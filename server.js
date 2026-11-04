'use strict';
// Dex Art Card Tracker server (TCGdex edition).
//
// Local database, built gently:
//  1. Sets: the set list is checked monthly; every new set is fetched once (one request per set).
//     A set request returns all its cards by name and image, so the regular cards (number within
//     the official set size) are stored from that alone: no prices, no extra requests.
//  2. Art cards always have a number above the official set size (e.g. 199/198). Only those cards
//     get a request of their own, to read rarity, dex number and price. Card data never changes, so
//     it is stored forever.
//  3. Prices: the cheapest few art cards per Pokémon are picked from the local database and
//     re-priced slowly, oldest first, within a daily request budget. Pokémon whose art card you
//     own are never re-priced.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE = (process.env.TCGDEX_BASE || 'https://api.tcgdex.net/v2/en').replace(/\/$/, '');
const DAILY_REQUESTS = +process.env.DAILY_REQUESTS || 300;
const REQUEST_DELAY_MS = process.env.REQUEST_DELAY_MS !== undefined ? +process.env.REQUEST_DELAY_MS : 1000;
const PRICE_MAX_AGE_DAYS = +process.env.PRICE_MAX_AGE_DAYS || 30;
const SETS_CHECK_DAYS = +process.env.SETS_CHECK_DAYS || 30;
const PRICE_CANDIDATES = +process.env.PRICE_CANDIDATES || 2;
const MIN_SET_DATE = process.env.MIN_SET_DATE || '2023-03-01'; // Scarlet & Violet, where Illustration Rares start
const DISABLE_REFRESH = process.env.DISABLE_REFRESH === '1';
// 0 (default): the first build of the database runs in one go (about 20 to 30 minutes, 1 request per second).
// 1: even the first build is limited to DAILY_REQUESTS per day.
const STAGGER_INITIAL = process.env.STAGGER_INITIAL === '1';
const RARITIES = (process.env.RARITIES || 'Illustration Rare,Special Illustration Rare')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const RAR = new Set(RARITIES);

const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const NAMES_FILE = path.join(DATA_DIR, 'names.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ageDays = iso => iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity;
const todayStr = () => new Date().toISOString().slice(0, 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function writeJSON(file, obj) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); }

const db = readJSON(DB_FILE) || {};
db.sets = db.sets || {};          // id -> {name,date,official,total,scan,cards:[{id,l,n,i,d?}]}
db.cards = db.cards || {};        // id -> art card record, or {id,x:1} when it is not an art card
db.setsChecked = db.setsChecked || null;
db.initialDone = !!db.initialDone;
db.budget = db.budget || { date: '', used: 0 };
db.regMatched = db.regMatched || null;

// ---------- TCGdex access ----------
async function api(p) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'dex-art-tracker' } });
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
      last = new Error('HTTP ' + r.status + ' for ' + p);
    } catch (e) { last = e; }
    await sleep(2000 * (i + 1));
  }
  throw last;
}

let unlimited = false;
function rollBudget() { if (db.budget.date !== todayStr()) db.budget = { date: todayStr(), used: 0 }; }
function canSpend() { rollBudget(); return unlimited || db.budget.used < DAILY_REQUESTS; }
async function paced(p) {
  rollBudget(); db.budget.used++;
  const r = await api(p);
  await sleep(REQUEST_DELAY_MS);
  return r;
}

// ---------- helpers ----------
const img = (base, q) => base ? base + '/' + q + '.webp' : null;
const isNum = l => /^\d+$/.test(String(l));
// Regular range: number within the official set size. Art range: above it.
function isNormal(s, c) { return isNum(c.l) && s.official > 0 && +c.l <= s.official; }
function isSecret(s, c) { return isNum(c.l) && (!(s.official > 0) || +c.l > s.official); }

function prices(d) {
  let us = null, eu = null;
  const p = d.pricing || {};
  const tp = p.tcgplayer || {};
  Object.keys(tp).forEach(k => {
    const v = tp[k];
    if (v && typeof v === 'object' && typeof v.marketPrice === 'number' && v.marketPrice > 0 && (us === null || v.marketPrice < us)) us = v.marketPrice;
  });
  const cm = p.cardmarket || {};
  ['trend-holo', 'trend', 'avg30-holo', 'avg30'].some(k => {
    if (typeof cm[k] === 'number' && cm[k] > 0) { eu = cm[k]; return true; }
    return false;
  });
  return { us, eu };
}
function qualifies(d) {
  return d && d.category === 'Pokemon' && Array.isArray(d.dexId) && d.dexId.length && d.rarity && RAR.has(String(d.rarity).toLowerCase());
}
function record(d) {
  const pr = prices(d);
  return {
    id: d.id, n: d.name, r: d.rarity, s: d.set && d.set.name, sid: d.set && d.set.id, d: d.dexId,
    i: img(d.image, 'low'), l: img(d.image, 'high'), eu: pr.eu, us: pr.us, pt: new Date().toISOString(),
  };
}

// ---------- names + regular-card matching ----------
const toks = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function refreshNames() {
  const old = readJSON(NAMES_FILE);
  if (old && Date.now() - (old.t || 0) < 60 * 86400000) return;
  try {
    const r = await fetch('https://pokeapi.co/api/v2/pokemon-species?limit=2000', { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const names = {}; let max = 0;
    j.results.forEach(x => {
      const id = parseInt(x.url.replace(/\/$/, '').split('/').pop(), 10);
      if (!id) return;
      names[id] = x.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (id > max) max = id;
    });
    writeJSON(NAMES_FILE, { t: Date.now(), max, names });
    log('names updated:', Object.keys(names).length);
  } catch (e) { log('names refresh failed:', e.message); }
}

// Regular cards have no dex number in the set listing, so they are matched to Pokémon by name.
function matchRegular() {
  const nm = readJSON(NAMES_FILE);
  if (!nm || !nm.names || db.regMatched === nm.t) return;
  const sp = Object.entries(nm.names).map(([n, name]) => [+n, ' ' + toks(name) + ' ']);
  for (const s of Object.values(db.sets)) {
    if (!s.scan) continue;
    for (const c of s.cards) {
      const t = ' ' + toks(c.n || '') + ' ';
      c.d = sp.filter(([, k]) => t.includes(k)).map(([n]) => n);
    }
  }
  db.regMatched = nm.t;
}

// ---------- export for the page ----------
function exportCards() {
  matchRegular();
  const cards = Object.values(db.cards).filter(c => !c.x);
  const regular = [];
  for (const [sid, s] of Object.entries(db.sets)) {
    if (!s.scan) continue;
    for (const c of s.cards) {
      if (!isNormal(s, c) || !c.d || !c.d.length) continue;
      regular.push({ id: c.id, n: c.n, s: s.name, sid, i: img(c.i, 'low'), l: img(c.i, 'high'), d: c.d });
    }
  }
  if (!cards.length && !regular.length) return;
  writeJSON(CARDS_FILE, { updated: new Date().toISOString(), count: cards.length, cards, regular });
}
let sinceSave = 0;
function persist(force) {
  if (force || ++sinceSave >= 25) {
    sinceSave = 0;
    writeJSON(DB_FILE, db);
    exportCards();
  }
}

// ---------- building and updating the database ----------
async function syncSets() {
  const list = await paced('/sets');
  if (!Array.isArray(list)) throw new Error('Unexpected answer for the set list');
  let added = 0;
  for (const s of list) {
    if (db.sets[s.id]) continue;
    if (!canSpend()) { persist(true); return false; }
    const d = await paced('/sets/' + encodeURIComponent(s.id));
    if (!d) { db.sets[s.id] = { name: s.name, date: '', official: 0, total: 0, scan: false, cards: [] }; continue; }
    const date = d.releaseDate || '';
    const scan = date >= MIN_SET_DATE;
    db.sets[s.id] = {
      name: d.name, date, scan,
      official: (d.cardCount && d.cardCount.official) || 0,
      total: (d.cardCount && d.cardCount.total) || 0,
      cards: scan ? (d.cards || []).map(c => ({ id: c.id, l: String(c.localId), n: c.name, i: c.image || null })) : [],
    };
    if (scan) { added++; db.regMatched = null; }
    persist(false);
  }
  db.setsChecked = new Date().toISOString();
  persist(true);
  log('set check done, new sets in scope:', added);
  return true;
}

function pendingCards() {
  const out = [];
  for (const s of Object.values(db.sets)) {
    if (!s.scan) continue;
    for (const c of s.cards) if (isSecret(s, c) && !db.cards[c.id]) out.push(c.id);
  }
  return out;
}

async function fetchCard(id) {
  const d = await paced('/cards/' + encodeURIComponent(id));
  const old = db.cards[id];
  if (d && qualifies(d)) db.cards[id] = record(d);
  else if (old && !old.x) old.pt = new Date().toISOString();
  else db.cards[id] = { id, x: 1 };
  persist(false);
}

async function backfill() {
  for (const id of pendingCards()) {
    if (!canSpend()) return false;
    await fetchCard(id);
  }
  return true;
}

// The cheapest few art cards per Pokémon (by € and by $), skipping Pokémon whose art card is owned.
function planPriceRefresh(maxAge, limit) {
  const own = (readJSON(STATE_FILE) || {}).own || {};
  const byDex = {};
  Object.values(db.cards).forEach(c => { if (!c.x) c.d.forEach(n => { (byDex[n] = byDex[n] || []).push(c); }); });
  const picked = new Map();
  Object.keys(byDex).forEach(n => {
    if (own[n] && own[n].art) return;
    ['eu', 'us'].forEach(cur => {
      byDex[n].slice().sort((a, b) => {
        const pa = a[cur], pb = b[cur];
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1; if (pb == null) return -1;
        return pa - pb;
      }).slice(0, PRICE_CANDIDATES).forEach(c => picked.set(c.id, c));
    });
  });
  return [...picked.values()]
    .filter(c => ageDays(c.pt) >= maxAge)
    .sort((a, b) => Date.parse(a.pt || 0) - Date.parse(b.pt || 0))
    .slice(0, limit);
}

async function refreshPrices(maxAge) {
  for (const c of planPriceRefresh(maxAge, Infinity)) {
    if (!canSpend()) return;
    await fetchCard(c.id);
  }
}

let running = false, lastError = null, lastManual = 0;
async function exclusive(fn) {
  if (running) return false;
  running = true; lastError = null;
  try { await fn(); }
  catch (e) { lastError = e.message; log('run failed:', e.message); }
  finally { unlimited = false; try { persist(true); } catch (e) {} running = false; }
  return true;
}

async function tick() {
  if (DISABLE_REFRESH || running) return;
  await exclusive(async () => {
    unlimited = !db.initialDone && !STAGGER_INITIAL;
    await refreshNames();
    if ((!db.setsChecked || ageDays(db.setsChecked) >= SETS_CHECK_DAYS) && canSpend()) await syncSets();
    await backfill();
    if (!db.initialDone && db.setsChecked && pendingCards().length === 0) {
      db.initialDone = true; unlimited = false;
      log('first build of the database finished');
    }
    if (db.initialDone) await refreshPrices(PRICE_MAX_AGE_DAYS);
  });
}

// Manual refresh: at most 25 requests (missing cards first, then the oldest prices).
async function manualRun() {
  unlimited = true;
  let n = 0;
  for (const id of pendingCards()) { if (n++ >= 25) break; await fetchCard(id); }
  if (n < 25) for (const c of planPriceRefresh(0, 25 - n)) await fetchCard(c.id);
}

function status() {
  const cards = Object.values(db.cards).filter(c => !c.x);
  let scanned = 0, regular = 0;
  Object.values(db.sets).forEach(s => {
    if (!s.scan) return; scanned++;
    s.cards.forEach(c => { if (isNormal(s, c)) regular++; });
  });
  rollBudget();
  return {
    count: cards.length, regular, running, lastError,
    sets: { known: Object.keys(db.sets).length, scanned },
    backlog: pendingCards().length,
    pricesDue: planPriceRefresh(PRICE_MAX_AGE_DAYS, Infinity).length,
    setsChecked: db.setsChecked, initialDone: db.initialDone,
    requestsToday: db.budget.used, dailyRequests: DAILY_REQUESTS,
  };
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (req.method === 'GET' && p === '/data/cards.json') return sendFile(res, CARDS_FILE);
    if (req.method === 'GET' && p === '/data/names.json') return sendFile(res, NAMES_FILE);
    if (req.method === 'GET' && p === '/api/status') return sendJSON(res, 200, status());
    if (req.method === 'GET' && p === '/api/state') return sendJSON(res, 200, readJSON(STATE_FILE) || {});
    if (req.method === 'PUT' && p === '/api/state') {
      const s = JSON.parse(await readBody(req, 1e6));
      if (!s || typeof s.own !== 'object' || Array.isArray(s.own)) return sendJSON(res, 400, { error: 'bad state' });
      writeJSON(STATE_FILE, { own: s.own, pick: s.pick || {}, cur: s.cur === 'us' ? 'us' : 'eu' });
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/refresh') {
      if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'refresh disabled' });
      if (running) return sendJSON(res, 202, { started: false });
      if (Date.now() - lastManual < 600000) return sendJSON(res, 429, { error: 'wait a few minutes' });
      lastManual = Date.now();
      exclusive(manualRun);
      return sendJSON(res, 202, { started: true });
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  log('listening on', PORT, '| data dir', DATA_DIR, '| up to', DAILY_REQUESTS, 'requests per day');
  tick();
  setInterval(tick, 3600 * 1000);
});
