'use strict';
// Dex Art Card Tracker server (TCGdex edition).
//
// Local database, built gently:
//  1. Sets: the set list is checked monthly; every new set is fetched once (one request per set).
//     A set request returns all its cards by name and image, so every card is stored from that
//     alone. Regular cards need no further requests.
//  2. Art candidates: cards numbered above the official set size (e.g. 199/198) and every card in a
//     promo set get a request of their own, to read rarity, dex number and price. Candidates whose
//     name contains no Pokémon name (trainers, energy) are skipped. Card data never changes, so it
//     is stored forever.
//  3. Prices: the cheapest few art cards per Pokémon are re-priced slowly, oldest first, within a
//     daily request budget. Cards you own and Pokémon whose art card you own are never re-priced.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE = (process.env.TCGDEX_BASE || 'https://api.tcgdex.net/v2/en').replace(/\/$/, '');
const DAILY_REQUESTS = +process.env.DAILY_REQUESTS || 200;
const REQUEST_DELAY_MS = process.env.REQUEST_DELAY_MS !== undefined ? +process.env.REQUEST_DELAY_MS : 1000;
const PRICE_MAX_AGE_DAYS = +process.env.PRICE_MAX_AGE_DAYS || 30;
const SETS_CHECK_DAYS = +process.env.SETS_CHECK_DAYS || 30;
const PRICE_CANDIDATES = +process.env.PRICE_CANDIDATES || 2;
const MIN_SET_DATE = process.env.MIN_SET_DATE || '2000-01-01'; // only sets released on or after this date are read
const DISABLE_REFRESH = process.env.DISABLE_REFRESH === '1';
// 0 (default): the first build of the database runs in one go, 1 request per second.
// 1: even the first build is limited to DAILY_REQUESTS per day.
const STAGGER_INITIAL = process.env.STAGGER_INITIAL === '4';
const RARITIES = (process.env.RARITIES || 'Illustration Rare,Special Illustration Rare,Promo')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const RAR = new Set(RARITIES);
// 1 (default): every Pokémon card from a promo set counts as an art card, whatever its rarity label.
const PROMO_AS_ART = process.env.PROMO_AS_ART !== '0';

// View-only copy of the page for friends, on its own port. Only GET requests, and only under a private link.
const SHARE_PORT = process.env.SHARE_PORT !== undefined ? +process.env.SHARE_PORT : 8081; // 0 = off
const SHARE_SHOW_VALUE = process.env.SHARE_SHOW_VALUE === '1'; // 1 = friends also see "worth" and "left to spend"
const SHARE_FILE = path.join(DATA_DIR, 'share.json');

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
db.sets = db.sets || {};          // id -> {name,date,official,total,scan,promo,pocket,cards:[{id,l,n,i,d?,sp?}]}
db.cards = db.cards || {};        // id -> art card record, or {id,x:1} when it is not an art card
db.setsChecked = db.setsChecked || null;
db.initialDone = !!db.initialDone;
db.budget = db.budget || { date: '', used: 0 };
db.regMatched = db.regMatched || null;

// Pokémon TCG Pocket sets (A1, A2a, B1, P-A ...) are not physical cards.
const isPocket = id => /^(?:[AB]\d+[a-z]?|P-[AB])$/i.test(String(id));
const noExt = u => u ? String(u).replace(/\.(?:webp|png|jpg)$/, '') : null;
const cleanBase = u => u ? String(u).replace(/\/(?:low|high)\.(?:webp|png|jpg)$/, '') : null;

// Upgrade data written by earlier versions.
(function migrate() {
  for (const [id, s] of Object.entries(db.sets)) {
    s.promo = /promo/i.test(s.name || '');
    if (isPocket(id)) { s.pocket = true; s.scan = false; s.cards = []; }
  }
  for (const c of Object.values(db.cards)) {
    if (c.x || 'b' in c) continue;
    c.b = cleanBase(c.i);
    delete c.i; delete c.l;
  }
})();

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
const isNum = l => /^\d+$/.test(String(l));
// Art candidates: numbered above the official set size, or anything in a promo set.
function isSecret(s, c) { return isNum(c.l) && (!(s.official > 0) || +c.l > s.official); }
function isCandidate(s, c) { return (PROMO_AS_ART && s.promo) || isSecret(s, c); }
const localOf = (id, sid) => String(id).slice(String(sid || '').length + 1);

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
function isPokemon(d) { return d && d.category === 'Pokemon' && Array.isArray(d.dexId) && d.dexId.length; }
function qualifies(d) {
  if (!isPokemon(d)) return false;
  if (d.rarity && RAR.has(String(d.rarity).toLowerCase())) return true;
  const s = d.set && db.sets[d.set.id];
  return !!(PROMO_AS_ART && s && s.promo);
}
function record(d) {
  const pr = prices(d);
  return {
    id: d.id, n: d.name, r: d.rarity || null, s: d.set && d.set.name, sid: d.set && d.set.id, d: d.dexId,
    b: cleanBase(d.image), eu: pr.eu, us: pr.us, pt: new Date().toISOString(),
  };
}

// ---------- names + matching ----------
const toks = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const cmp = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

let NM = readJSON(NAMES_FILE), SP = null;
function loadSpecies() {
  SP = NM && NM.names ? Object.values(NM.names).map(n => cmp(/^nidoran/i.test(n) ? 'nidoran' : n)).filter(k => k.length >= 3) : null;
}
loadSpecies();
// 1 if the card name contains a Pokémon name, 0 if not (trainers, energy), undefined if names are not loaded yet.
function spOf(c) {
  if (!SP) return undefined;
  if (c.sp === undefined) { const k = cmp(c.n || ''); c.sp = SP.some(s => k.includes(s)) ? 1 : 0; }
  return c.sp;
}

async function refreshNames() {
  if (NM && Date.now() - (NM.t || 0) < 60 * 86400000) return;
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
    NM = { t: Date.now(), max, names };
    writeJSON(NAMES_FILE, NM);
    loadSpecies();
    log('names updated:', Object.keys(names).length);
  } catch (e) { log('names refresh failed:', e.message); }
}

// Regular cards have no dex number in the set listing, so they are matched to Pokémon by name.
function matchRegular() {
  if (!NM || !NM.names || db.regMatched === NM.t) return;
  const sp = Object.entries(NM.names).map(([n, name]) => [+n, ' ' + toks(name) + ' ']);
  for (const s of Object.values(db.sets)) {
    if (!s.scan) continue;
    for (const c of s.cards) {
      const t = ' ' + toks(c.n || '') + ' ';
      c.d = sp.filter(([, k]) => t.includes(k)).map(([n]) => n);
    }
  }
  db.regMatched = NM.t;
}

// ---------- export for the page ----------
let lastExport = { art: 0, regular: 0, sets: 0 };
function exportCards() {
  matchRegular();
  const art = [], regular = [], sets = [];
  Object.values(db.cards).forEach(c => {
    if (c.x) return;
    art.push({ id: c.id, n: c.n, r: c.r, sid: c.sid, k: localOf(c.id, c.sid), b: c.b || null, d: c.d, eu: c.eu, us: c.us, pt: c.pt, m: c.m ? 1 : undefined });
  });
  for (const [sid, s] of Object.entries(db.sets)) {
    if (!s.scan) continue;
    let a = 0;
    for (const c of s.cards) {
      const rec = db.cards[c.id];
      if (rec && !rec.x) { a++; continue; }
      if (!rec && isCandidate(s, c) && spOf(c) !== 0) continue; // not looked at yet
      if (c.d && c.d.length) regular.push({ id: c.id, n: c.n, sid, k: c.l, b: c.i || null, d: c.d });
    }
    sets.push({ id: sid, name: s.name, date: s.date || '', official: s.official, total: s.total, n: s.cards.length, art: a, promo: s.promo ? 1 : 0,
      lg: noExt(s.lg), sy: noExt(s.sy) });
  }
  lastExport = { art: art.length, regular: regular.length, sets: sets.length };
  if (!art.length && !regular.length && !sets.length) return;
  writeJSON(CARDS_FILE, { updated: new Date().toISOString(), count: art.length, cards: art, regular, sets });
}

function setPayload(sid) {
  const s = db.sets[sid];
  if (!s || !s.scan) return null;
  return {
    id: sid, name: s.name, date: s.date || '', official: s.official, total: s.total, promo: !!s.promo,
    cards: s.cards.map(c => {
      const rec = db.cards[c.id];
      const o = { id: c.id, k: c.l, n: c.n, b: c.i || null };
      if (rec && !rec.x) { o.t = 'a'; o.r = rec.r; o.eu = rec.eu; o.us = rec.us; o.d = rec.d; if (rec.m) o.m = 1; }
      else if (!rec && isCandidate(s, c) && spOf(c) !== 0) o.t = 'p';
      else o.t = 'r';
      if (isSecret(s, c)) o.sec = 1;
      return o;
    }),
  };
}

let sinceSave = 0;
function persist(force) {
  if (force || ++sinceSave >= 50) {
    sinceSave = 0;
    writeJSON(DB_FILE, db);
    exportCards();
  }
}

// ---------- building and updating the database ----------
// Set logo and symbol pictures come with the set list (addresses without a file extension).
function applyLogos(list) {
  for (const s of list) {
    const t = db.sets[s.id];
    if (!t) continue;
    if (s.logo) t.lg = s.logo;
    if (s.symbol) t.sy = s.symbol;
  }
}
async function syncSets() {
  const list = await paced('/sets');
  if (!Array.isArray(list)) throw new Error('Unexpected answer for the set list');
  applyLogos(list); db.logosDone = true;
  let added = 0;
  for (const s of list) {
    const have = db.sets[s.id];
    if (!have && isPocket(s.id)) { db.sets[s.id] = { name: s.name, date: '', official: 0, total: 0, scan: false, pocket: true, promo: false, cards: [] }; continue; }
    if (have && (have.scan || have.pocket || String(have.date || '') < MIN_SET_DATE)) continue;
    if (!canSpend()) { persist(true); return false; }
    const d = await paced('/sets/' + encodeURIComponent(s.id));
    if (!d) { db.sets[s.id] = { name: s.name, date: '', official: 0, total: 0, scan: false, promo: false, cards: [] }; continue; }
    const date = d.releaseDate || '';
    const pocket = isPocket(s.id) || (d.serie && d.serie.id === 'tcgp');
    const scan = !pocket && date >= MIN_SET_DATE;
    db.sets[s.id] = {
      name: d.name, date, scan, pocket: !!pocket, promo: /promo/i.test(d.name || ''),
      lg: s.logo || d.logo || null, sy: s.symbol || d.symbol || null,
      official: (d.cardCount && d.cardCount.official) || 0,
      total: (d.cardCount && d.cardCount.total) || 0,
      cards: scan ? (d.cards || []).map(c => ({ id: c.id, l: String(c.localId), n: c.name, i: c.image || null })) : [],
    };
    if (scan) { added++; db.regMatched = null; }
    persist(false);
  }
  db.setsChecked = new Date().toISOString();
  persist(true);
  log('set check done, sets read this time:', added);
  return true;
}

// Cards that still need a request of their own, newest sets first.
function pendingCards() {
  const out = [];
  const sets = Object.values(db.sets).filter(s => s.scan).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const s of sets) {
    for (const c of s.cards) if (isCandidate(s, c) && !db.cards[c.id] && spOf(c) !== 0) out.push(c.id);
  }
  return out;
}

async function fetchCard(id) {
  const d = await paced('/cards/' + encodeURIComponent(id));
  const old = db.cards[id];
  if (d && qualifies(d)) { const r = record(d); if (old && old.m) r.m = 1; db.cards[id] = r; }
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

// The cheapest few art cards per Pokémon (by € and by $), skipping Pokémon whose art card you own.
function planPriceRefresh(maxAge, limit) {
  const stt = readJSON(STATE_FILE) || {};
  const own = stt.own || {}, owned = stt.cards || {};
  const byDex = {};
  Object.values(db.cards).forEach(c => { if (!c.x) c.d.forEach(n => { (byDex[n] = byDex[n] || []).push(c); }); });
  const picked = new Map();
  Object.keys(byDex).forEach(n => {
    if (own[n] && own[n].art) return;
    if (byDex[n].some(c => owned[c.id])) return;
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
    if (!db.logosDone && canSpend()) { // one request: fetch set pictures for sets stored by an older version
      const list = await paced('/sets');
      if (Array.isArray(list)) { applyLogos(list); db.logosDone = true; persist(true); }
    }
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

// Diagnostic: asks TCGdex about one language and reports whether its newest cards carry rarity, dex numbers and prices.
let lastLang = 0;
async function langCheck(lang) {
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/i.test(lang)) throw new Error('Use a language code such as ja, zh-tw, zh-cn, ko, fr, de');
  const base = 'https://api.tcgdex.net/v2/' + lang.toLowerCase();
  const out = { language: lang, steps: [], rarities: {}, samples: [] };
  async function get(p) {
    rollBudget(); db.budget.used++;
    let r;
    try { r = await fetch(base + p, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'dex-art-tracker' } }); }
    catch (e) { out.steps.push(p + ' -> ' + e.message); return null; }
    out.steps.push(p + ' -> HTTP ' + r.status);
    await sleep(REQUEST_DELAY_MS);
    return r.ok ? r.json() : null;
  }
  const list = await get('/sets');
  if (!Array.isArray(list)) { out.summary = 'Could not read the set list.'; return out; }
  out.setCount = list.length;
  out.setsWithLogo = list.filter(x => x.logo).length;
  let best = null;
  for (const x of list.slice(-4)) {
    const d = await get('/sets/' + encodeURIComponent(x.id));
    if (d && (!best || String(d.releaseDate) > String(best.releaseDate))) best = d;
  }
  if (!best) { out.summary = 'Could not read any set.'; return out; }
  const off = (best.cardCount && best.cardCount.official) || 0;
  out.newestSetChecked = { id: best.id, name: best.name, releaseDate: best.releaseDate, official: off, total: best.cardCount && best.cardCount.total, cardsListed: (best.cards || []).length };
  let pick = (best.cards || []).filter(c => /^\d+$/.test(String(c.localId)) && +c.localId > off).slice(-4);
  if (!pick.length) pick = (best.cards || []).slice(-4);
  for (const c of pick) {
    const d = await get('/cards/' + encodeURIComponent(c.id));
    if (!d) continue;
    const pr = prices(d);
    out.rarities[d.rarity] = (out.rarities[d.rarity] || 0) + 1;
    out.samples.push({ id: d.id, name: d.name, rarity: d.rarity, category: d.category, dexId: d.dexId || null, hasImage: !!d.image,
      hasPricing: !!d.pricing, pricingFrom: d.pricing ? Object.keys(d.pricing) : [], eur: pr.eu, usd: pr.us });
  }
  const priced = out.samples.filter(x => x.eur != null || x.usd != null).length;
  out.summary = out.samples.length + ' newest cards checked, ' + priced + ' with a price, ' + out.samples.filter(x => x.dexId).length + ' with a dex number.';
  return out;
}

function status() {
  rollBudget();
  return {
    count: lastExport.art, regular: lastExport.regular, running, lastError,
    sets: { known: Object.keys(db.sets).length, scanned: lastExport.sets },
    backlog: pendingCards().length,
    pricesDue: planPriceRefresh(PRICE_MAX_AGE_DAYS, Infinity).length,
    setsChecked: db.setsChecked, initialDone: db.initialDone,
    requestsToday: db.budget.used, dailyRequests: DAILY_REQUESTS,
  };
}

// ---------- share link ----------
const makeKey = () => crypto.randomBytes(9).toString('base64url');
const envKey = String(process.env.SHARE_KEY || '').trim();
const shareFixed = /^[A-Za-z0-9_-]{4,64}$/.test(envKey);
if (envKey && !shareFixed) log('SHARE_KEY ignored: use 4 to 64 letters, numbers, - or _');
let shareKey = shareFixed ? envKey : ((readJSON(SHARE_FILE) || {}).key || null);
if (!shareKey) { shareKey = makeKey(); writeJSON(SHARE_FILE, { key: shareKey }); }
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
function indexHtml(readonly) {
  let h = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  if (readonly) h = h.replace('<!--DEX_MODE-->', '<script>window.DEX_READONLY=true;window.DEX_HIDE_VALUE=' + (!SHARE_SHOW_VALUE) + ';</script>');
  return h;
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
const gz = {};
function sendCompressed(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { res.writeHead(404); return res.end('Not found'); }
  if (!String(req.headers['accept-encoding'] || '').includes('gzip')) return sendFile(res, file);
  let c = gz[file];
  if (!c || c.m !== st.mtimeMs) { c = gz[file] = { m: st.mtimeMs, buf: zlib.gzipSync(fs.readFileSync(file)) }; }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-cache' });
  res.end(c.buf);
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
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (req.method === 'GET' && p === '/data/cards.json') return sendCompressed(req, res, CARDS_FILE);
    if (req.method === 'GET' && p === '/data/names.json') return sendFile(res, NAMES_FILE);
    if (req.method === 'GET' && p === '/api/status') return sendJSON(res, 200, status());
    if (req.method === 'GET' && p === '/api/set') {
      const s = setPayload(u.searchParams.get('id') || '');
      return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: 'unknown set' });
    }
    if (req.method === 'GET' && p === '/api/state') return sendJSON(res, 200, readJSON(STATE_FILE) || {});
    if (req.method === 'GET' && p === '/api/share') return sendJSON(res, 200, { enabled: SHARE_PORT > 0, port: SHARE_PORT, key: shareKey, fixed: shareFixed, showValue: SHARE_SHOW_VALUE });
    if (req.method === 'GET' && p === '/api/lang-check') {
      if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'The server is set to not contact the card service' });
      if (Date.now() - lastLang < 20000) return sendJSON(res, 429, { error: 'wait 20 seconds between checks' });
      lastLang = Date.now();
      const out = await langCheck(u.searchParams.get('lang') || 'ja');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(out, null, 1));
    }
    // Writing requests must be JSON: a web page on another site cannot send that without permission.
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return sendJSON(res, 415, { error: 'JSON required' });

    if (req.method === 'POST' && p === '/api/share/reset') {
      if (shareFixed) return sendJSON(res, 409, { error: 'The link is fixed by the SHARE_KEY setting' });
      shareKey = makeKey(); writeJSON(SHARE_FILE, { key: shareKey });
      return sendJSON(res, 200, { key: shareKey });
    }
    if (req.method === 'PUT' && p === '/api/state') {
      const s = JSON.parse(await readBody(req, 5e6));
      if (!s || typeof s.own !== 'object' || Array.isArray(s.own)) return sendJSON(res, 400, { error: 'bad state' });
      const cards = s.cards && typeof s.cards === 'object' && !Array.isArray(s.cards) ? s.cards : {};
      writeJSON(STATE_FILE, { own: s.own, cards, pick: s.pick || {}, cur: s.cur === 'us' ? 'us' : 'eu' });
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
    // Count a card as an art card (one request to read its details) or take it off the art list.
    if (req.method === 'POST' && p === '/api/card/mark') {
      const b = JSON.parse(await readBody(req, 1e5));
      const id = String(b.id || '');
      if (!id) return sendJSON(res, 400, { error: 'no card' });
      if (b.art) {
        if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'The server is set to not contact the card service' });
        const d = await paced('/cards/' + encodeURIComponent(id));
        if (!isPokemon(d)) return sendJSON(res, 400, { error: 'That is not a Pokémon card with a dex number' });
        const r = record(d); r.m = 1;
        db.cards[id] = r;
      } else {
        db.cards[id] = { id, x: 1, m: 1 };
      }
      persist(true);
      return sendJSON(res, 200, { ok: true });
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
});

// Read-only server: GET only, everything lives under /<key>/ so the page's relative addresses just work.
const hits = new Map();
const limited = ip => { const n = Date.now(), h = hits.get(ip); if (!h || n - h.t > 60000) { hits.set(ip, { t: n, n: 1 }); return false; } return ++h.n > 600; };
const shareServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress || '';
  const hdr = { 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' };
  try {
    if (limited(ip)) { res.writeHead(429, hdr); return res.end('Slow down'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, Object.assign({ Allow: 'GET, HEAD' }, hdr)); return res.end(); }
    const seg = u.pathname.split('/');
    if (!seg[1] || !safeEq(seg[1], shareKey)) { res.writeHead(404, hdr); return res.end('Not found'); }
    if (seg.length === 2) { res.writeHead(301, Object.assign({ Location: '/' + shareKey + '/' }, hdr)); return res.end(); }
    const rest = '/' + seg.slice(2).join('/');
    if (rest === '/') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, hdr));
      return res.end(indexHtml(true));
    }
    if (rest === '/data/cards.json') return sendCompressed(req, res, CARDS_FILE);
    if (rest === '/data/names.json') return sendFile(res, NAMES_FILE);
    if (rest === '/api/state') return sendJSON(res, 200, readJSON(STATE_FILE) || {});
    if (rest === '/api/status') return sendJSON(res, 200, { count: lastExport.art, regular: lastExport.regular, running: false, backlog: 0, pricesDue: 0, sets: { scanned: lastExport.sets } });
    if (rest === '/api/set') {
      const s = setPayload(u.searchParams.get('id') || '');
      return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: 'unknown set' });
    }
    res.writeHead(404, hdr); res.end('Not found');
  } catch (e) { res.writeHead(500, hdr); res.end('Error'); }
});
shareServer.on('error', e => log('view-only server could not start:', e.message));

server.listen(PORT, () => {
  log('listening on', PORT, '| data dir', DATA_DIR, '| up to', DAILY_REQUESTS, 'requests per day');
  try { exportCards(); } catch (e) { log('export failed:', e.message); }
  tick();
  setInterval(tick, 3600 * 1000);
  if (SHARE_PORT > 0 && SHARE_PORT !== PORT) shareServer.listen(SHARE_PORT, () => log('view-only page on port', SHARE_PORT, '| link path: /' + shareKey + '/'));
});
