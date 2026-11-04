'use strict';
// Dex Art Card Tracker server (TCGdex edition).
//
// Local database, built gently:
//  1. Sets: the set list is checked monthly; every new set is fetched once (one request per set).
//     A set request returns all its cards by name and image, so every card is stored from that
//     alone. Regular cards need no further requests.
//  2. Art candidates: TCGdex is asked which cards have an art rarity (a few dozen list requests), and
//     every card in a promo set counts too. Those cards get a request of their own, to read rarity,
//     dex number and price. (If the rarity search is not available, cards numbered above the official
//     set size are used instead.) Japanese sets are read the same way. Card data never changes, so it
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
// Languages whose sets are read: en (always) and ja. Japanese ids are stored as "ja:<id>" so they never clash.
const LANGS = ['en'].concat((process.env.LANGUAGES || 'en,ja').split(',').map(x => x.trim().toLowerCase()).filter(x => x === 'ja'));
const baseFor = lang => BASE.replace(/\/en$/, '/' + lang);
const langOf = id => String(id).startsWith('ja:') ? 'ja' : 'en';
const pfx = lang => lang === 'en' ? '' : lang + ':';
const rawId = id => String(id).replace(/^ja:/, '');
// How many of the daily requests may go to prices of regular cards (the rest is for art cards).
const REGULAR_PRICES_PER_DAY = process.env.REGULAR_PRICES_PER_DAY !== undefined ? +process.env.REGULAR_PRICES_PER_DAY : 0; // 0 = no limit
const DAILY_REQUESTS = process.env.DAILY_REQUESTS !== undefined ? (+process.env.DAILY_REQUESTS || 0) : 0; // 0 = no daily limit
const REQUEST_DELAY_MS = process.env.REQUEST_DELAY_MS !== undefined ? +process.env.REQUEST_DELAY_MS : 4000; // pause between requests, 4 seconds by default
const PRICE_MAX_AGE_DAYS = +process.env.PRICE_MAX_AGE_DAYS || 30;
const SETS_CHECK_DAYS = +process.env.SETS_CHECK_DAYS || 1; // the set list is checked at start and then this often
const PRICE_CANDIDATES = +process.env.PRICE_CANDIDATES || 2;
const MIN_SET_DATE = process.env.MIN_SET_DATE || '2000-01-01'; // only sets released on or after this date are read
const DISABLE_REFRESH = process.env.DISABLE_REFRESH === '1';
// 0 (default): the first build of the database runs in one go, 1 request per second.
// 1: even the first build is limited to DAILY_REQUESTS per day.
const STAGGER_INITIAL = process.env.STAGGER_INITIAL === '4';
const RARITIES = (process.env.RARITIES || 'Illustration Rare,Special Illustration Rare,Promo')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const RAR = new Set(RARITIES);
// Extra rarities that count as art cards in every language. Japanese sets also count every Pokémon card
// numbered above the set size ("secret" cards).
const EXTRA = (process.env.EXTRA_RARITIES !== undefined ? process.env.EXTRA_RARITIES : (process.env.JA_RARITIES !== undefined ? process.env.JA_RARITIES : 'Mega Hyper Rare,Ultra Rare,Holo Rare')).split(',').map(x => x.trim()).filter(Boolean);
const RAR_ALL = new Set(RARITIES.concat(EXTRA.map(x => x.toLowerCase())));
// 1 (default): every Pokémon card from a promo set counts as an art card, whatever its rarity label.
const PROMO_AS_ART = process.env.PROMO_AS_ART !== '0';

// Visitors who are not logged in see a view-only page. Set to 1 to let them see "worth" and "left to spend" too.
const SHOW_VALUE_PUBLIC = process.env.SHOW_VALUE_PUBLIC === '1' || process.env.SHARE_SHOW_VALUE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY !== '0'; // on by default (reverse proxy: use X-Forwarded-For / -Proto). 0 = off

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
db.rar = db.rar || {};            // lang -> {t, ok, ids:[card ids that have an art rarity]}
db.langsDone = db.langsDone || {};
if (db.setsChecked && !db.langsDone.en) db.langsDone.en = true;

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

// One-time: promo cards rejected earlier (for example for a missing dex number) are checked again.
if (!db.fix2) {
  for (const [id, c] of Object.entries(db.cards)) {
    if (!c.x || c.m) continue;
    const sid = id.slice(0, id.lastIndexOf('-')), st = db.sets[sid];
    if (st && st.promo) delete db.cards[id];
  }
  db.setsChecked = null; // read the set list once now, so promo sets pick up cards added since
  db.fix2 = true;
}

// ---------- TCGdex access ----------
async function api(p, lang) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(baseFor(lang || 'en') + p, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'dex-art-tracker' } });
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
function canSpend() { rollBudget(); return unlimited || !DAILY_REQUESTS || db.budget.used < DAILY_REQUESTS; }
// Requests for the owner's own clicks (fast = true) go first: they are sent at once, and the background
// work waits until none are running.
let manualBusy = 0;
async function paced(p, lang, fast) {
  if (fast) {
    manualBusy++;
    try { rollBudget(); db.budget.used++; return await api(p, lang); }
    finally { manualBusy--; }
  }
  while (manualBusy > 0) await sleep(200);
  rollBudget(); db.budget.used++;
  const r = await api(p, lang);
  await sleep(REQUEST_DELAY_MS);
  while (manualBusy > 0) await sleep(200);
  return r;
}

// ---------- helpers ----------
const isNum = l => /^\d+$/.test(String(l));
// Art candidates: numbered above the official set size, or anything in a promo set.
function isSecret(s, c) { return isNum(c.l) && (!(s.official > 0) || +c.l > s.official); }
let foundCache = null;
function foundIds() {
  if (!foundCache) { foundCache = new Set(); for (const [l, r] of Object.entries(db.rar)) if (r && r.ok) r.ids.forEach(i => foundCache.add(pfx(l) + i)); }
  return foundCache;
}
const rarOk = lang => !!(db.rar[lang] && db.rar[lang].ok);
// A card is looked at when TCGdex lists it under an art rarity, it is in a promo set, or (only while the
// rarity search is unavailable) it is numbered above the official set size.
function isCandidate(s, c) {
  if (PROMO_AS_ART && s.promo) return true;
  if (s.lang === 'ja' && isSecret(s, c)) return true;
  if (foundIds().has(c.id)) return true;
  return !rarOk(s.lang || 'en') && isSecret(s, c);
}
function worth(s, c) { return isCandidate(s, c) && (foundIds().has(c.id) || spOf(c) !== 0); }
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
function nameDex(name) {
  if (!NM || !NM.names) return [];
  const t = ' ' + toks(name || '') + ' ';
  return Object.entries(NM.names).filter(([, nm]) => t.includes(' ' + toks(nm) + ' ')).map(([n]) => +n);
}
function cmId(d) {
  const c = d && d.pricing && d.pricing.cardmarket;
  const v = c && (c.idProduct !== undefined ? c.idProduct : c.productId);
  return v ? String(v) : null;
}
function isPokemon(d) { return d && d.category === 'Pokemon' && Array.isArray(d.dexId) && d.dexId.length; }
function qualifies(d, p) {
  if (d && d.category === 'Trainer') return !!(d.rarity && RAR_ALL.has(String(d.rarity).toLowerCase()) && d.rarity.toLowerCase() !== 'promo');
  if (!isPokemon(d)) return false;
  if (d.rarity && RAR_ALL.has(String(d.rarity).toLowerCase())) return true;
  const s = d.set && db.sets[(p || '') + d.set.id];
  if (p === 'ja:' && s && isSecret(s, { l: String(d.localId) })) return true;
  return !!(PROMO_AS_ART && s && s.promo);
}
function record(d, p) {
  const pr = prices(d); p = p || '';
  return {
    id: p + d.id, n: d.name, r: d.rarity || null, s: d.set && d.set.name, sid: d.set && (p + d.set.id), d: d.dexId || [], tr: d.category === 'Trainer' ? 1 : undefined,
    b: cleanBase(d.image), eu: pr.eu, us: pr.us, cm: cmId(d), pt: new Date().toISOString(),
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
  if (!SP || String(c.id).startsWith('ja:')) return undefined;
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
    if (!s.scan || s.lang === 'ja') continue;
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
  const setPics = regIndex();
  const art = [], trainers = [], regular = [], sets = [];
  Object.values(db.cards).forEach(c => {
    if (c.x) return;
    (c.tr ? trainers : art).push({ id: c.id, n: c.n, r: c.r, sid: c.sid, k: localOf(c.id, c.sid), b: c.b || (setPics.get(c.id) && setPics.get(c.id).i ? cleanBase(setPics.get(c.id).i) : null), d: c.d, eu: c.eu, us: c.us, cm: c.cm || undefined, pt: c.pt, m: c.m ? 1 : undefined });
  });
  for (const [sid, s] of Object.entries(db.sets)) {
    if (!s.scan) continue;
    let a = 0;
    for (const c of s.cards) {
      const rec = db.cards[c.id];
      if (rec && !rec.x) { a++; continue; }
      if (!rec && worth(s, c)) continue; // not looked at yet
      if (c.d && c.d.length) regular.push({ id: c.id, n: c.n, sid, k: c.l, b: c.i || null, d: c.d, eu: c.eu, us: c.us, cm: c.cm || undefined, pt: c.pt });
    }
    sets.push({ id: sid, name: s.name, date: s.date || '', official: s.official, total: s.total, n: s.cards.length, art: a, promo: s.promo ? 1 : 0,
      lg: noExt(s.lg), sy: noExt(s.sy) });
  }
  lastExport = { art: art.length, trainers: trainers.length, regular: regular.length, sets: sets.length };
  if (!art.length && !regular.length && !sets.length) return;
  writeJSON(CARDS_FILE, { updated: new Date().toISOString(), count: art.length, cards: art, trainers, regular, sets });
}

function setPayload(sid) {
  const s = db.sets[sid];
  if (!s || !s.scan) return null;
  return {
    id: sid, name: s.name, date: s.date || '', official: s.official, total: s.total, promo: !!s.promo,
    cards: s.cards.map(c => {
      const rec = db.cards[c.id];
      const o = { id: c.id, k: c.l, n: c.n, b: c.i || null };
      if (rec && !rec.x) { o.t = 'a'; o.r = rec.r; o.eu = rec.eu; o.us = rec.us; o.cm = rec.cm; o.pt = rec.pt; o.d = rec.d; if (rec.m) o.m = 1; }
      else if (!rec && worth(s, c)) o.t = 'p';
      else { o.t = 'r'; o.eu = c.eu; o.us = c.us; o.cm = c.cm; o.pt = c.pt; }
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
function applyLogos(list, p) {
  for (const s of list) {
    const t = db.sets[(p || '') + s.id];
    if (!t) continue;
    if (s.logo) t.lg = s.logo;
    if (s.symbol) t.sy = s.symbol;
  }
}
async function syncSets() {
  for (const lang of LANGS) { if (!(await syncLang(lang))) return false; }
  db.setsChecked = new Date().toISOString();
  persist(true);
  return true;
}
async function syncLang(lang) {
  const p = pfx(lang);
  const list = await paced('/sets', lang);
  if (!Array.isArray(list)) throw new Error('Unexpected answer for the ' + lang + ' set list');
  applyLogos(list, p);
  if (lang === 'en') db.logosDone = true;
  let added = 0;
  for (const s of list) {
    const key = p + s.id, have = db.sets[key];
    if (!have && isPocket(s.id)) { db.sets[key] = { name: s.name, date: '', official: 0, total: 0, scan: false, pocket: true, promo: false, lang, cards: [] }; continue; }
    // Sets that can still grow (promo sets, sets released in the last 180 days) are read again once a day.
    const grows = have && have.scan && (have.promo || ageDays(have.date) < 180) && !(db.reread && db.reread[key] === todayStr());
    if (have && !grows && (have.scan || have.pocket || String(have.date || '') < MIN_SET_DATE)) continue;
    if (!canSpend()) { persist(true); return false; }
    const d = await paced('/sets/' + encodeURIComponent(s.id), lang);
    if (!d) { db.sets[key] = { name: s.name, date: '', official: 0, total: 0, scan: false, promo: false, lang, cards: [] }; continue; }
    const date = d.releaseDate || '';
    const pocket = isPocket(s.id) || (d.serie && d.serie.id === 'tcgp');
    const scan = !pocket && date >= MIN_SET_DATE;
    db.sets[key] = {
      name: d.name, date, scan, pocket: !!pocket, promo: lang === 'en' && /promo/i.test(d.name || ''), lang,
      lg: s.logo || d.logo || null, sy: s.symbol || d.symbol || null,
      official: (d.cardCount && d.cardCount.official) || 0,
      total: (d.cardCount && d.cardCount.total) || 0,
      cards: scan ? (d.cards || []).map(c => ({ id: p + c.id, l: String(c.localId), n: c.name, i: c.image || null })) : [],
    };
    if (scan) { added++; db.regMatched = null; (db.reread = db.reread || {})[key] = todayStr(); }
    persist(false);
  }
  db.langsDone[lang] = true;
  persist(true);
  log(lang + ' set check done, sets read this time:', added);
  return true;
}

// Asks TCGdex for every card with an art rarity (list requests of 100 cards). The result is stored as ids only.
const titleCase = x => x.replace(/\b\w/g, m => m.toUpperCase());
const sentenceCase = x => x.charAt(0).toUpperCase() + x.slice(1);
async function rarityScan(lang) {
  const names = new Set();
  RARITIES.concat(EXTRA.map(x => x.toLowerCase())).forEach(r => { names.add(titleCase(r)); names.add(sentenceCase(r)); });
  const ids = new Set(), sigs = new Map(); let ok = true;
  outer: for (const nm of names) {
    let first = null;
    for (let page = 1; page <= 250; page++) {
      if (!canSpend()) return false;
      const r = await paced('/cards?rarity=' + encodeURIComponent(nm) + '&pagination:page=' + page + '&pagination:itemsPerPage=100', lang);
      if (!Array.isArray(r)) { ok = false; break outer; }
      if (!r.length) break;
      if (page > 1 && r[0] && r[0].id === first) break; // the server ignored the page number
      if (page === 1) {
        first = r[0] && r[0].id;
        const sig = r.slice(0, 10).map(x => x.id).join(','), key = nm.toLowerCase();
        for (const [k, v] of sigs) if (k !== key && v === sig && r.length >= 10) { ok = false; break outer; } // same list for different rarities: the filter is ignored
        sigs.set(key, sig);
      }
      r.forEach(x => { if (x && x.id) ids.add(String(x.id)); });
      if (ids.size > 60000) { ok = false; break outer; }
      if (r.length < 100) break;
    }
  }
  if (!ids.size) ok = false;
  db.rar[lang] = { v: 4, t: new Date().toISOString(), ok, ids: ok ? [...ids] : [] };
  foundCache = null;
  persist(true);
  log(lang + ' rarity search:', ok ? ids.size + ' art cards listed' : 'not available, using the number rule instead');
  return true;
}

// Cards that still need a request of their own, newest sets first.
function pendingCards() {
  const out = [];
  const sets = Object.values(db.sets).filter(s => s.scan).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const s of sets) {
    for (const c of s.cards) if (worth(s, c) && !db.cards[c.id]) out.push(c.id);
  }
  return out;
}

async function fetchCard(id) {
  const lang = langOf(id), p = pfx(lang);
  const d = await paced('/cards/' + encodeURIComponent(rawId(id)), lang);
  const old = db.cards[id];
  if (d && p === '' && d.category === 'Pokemon' && !(Array.isArray(d.dexId) && d.dexId.length)) { const g = nameDex(d.name); if (g.length) d.dexId = g; }
  if (d && qualifies(d, p)) { const r = record(d, p); if (old && old.m) r.m = 1; db.cards[id] = r; }
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
  Object.values(db.cards).forEach(c => { if (!c.x && !c.tr) c.d.forEach(n => { (byDex[n] = byDex[n] || []).push(c); }); });
  const picked = new Map();
  Object.values(db.cards).forEach(c => { if (!c.x && c.tr && !owned[c.id]) picked.set(c.id, c); });
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
  // Art cards that have no picture yet are asked about again every 7 days (TCGdex adds pictures later).
  const noPic = Object.values(db.cards).filter(c => !c.x && !c.b && !owned[c.id] && ageDays(c.pt) >= 7);
  return [...new Set([...picked.values()].filter(c => ageDays(c.pt) >= maxAge).concat(noPic))]
    .sort((a, b) => (b.m ? 1 : 0) - (a.m ? 1 : 0) || Date.parse(a.pt || 0) - Date.parse(b.pt || 0)) // cards you picked by hand first
    .slice(0, limit);
}

async function refreshPrices(maxAge) {
  for (const c of planPriceRefresh(maxAge, Infinity)) {
    if (!canSpend()) return;
    await fetchCard(c.id);
  }
}

// ---------- prices of regular cards ----------
function regIndex() {
  const m = new Map();
  for (const s of Object.values(db.sets)) if (s.scan) for (const c of s.cards) m.set(c.id, c);
  return m;
}
async function priceRegular(id, idx, fast) {
  const c = (idx || regIndex()).get(id);
  if (!c) return false;
  const d = await paced('/cards/' + encodeURIComponent(rawId(id)), langOf(id), fast);
  c.pt = new Date().toISOString();
  if (d) { const pr = prices(d); c.eu = pr.eu; c.us = pr.us; c.cm = cmId(d); }
  persist(false);
  return true;
}
// Regular cards of Pokémon (they have a dex match) that have no price yet, newest sets first.
function regWithoutPrice(limit) {
  const out = [];
  const sets = Object.values(db.sets).filter(s => s.scan && s.lang !== 'ja').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const s of sets) for (const c of s.cards) {
    if (!c.pt && c.d && c.d.length && !db.cards[c.id]) { out.push(c.id); if (out.length >= limit) return out; }
  }
  return out;
}
async function fillRegularPrices() {
  rollBudget();
  db.budget.reg = db.budget.reg || 0;
  const idx = regIndex();
  const t0 = Date.now();
  while (canSpend() && (!REGULAR_PRICES_PER_DAY || db.budget.reg < REGULAR_PRICES_PER_DAY) && Date.now() - t0 < 50 * 60000) {
    const ids = regWithoutPrice(1);
    if (!ids.length) return;
    db.budget.reg++;
    await priceRegular(ids[0], idx);
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

let bootCheck = true;
async function tick() {
  if (DISABLE_REFRESH || running) return;
  if (!db.fix3) { // trainer art cards were rejected before: check those cards again once
    const f = foundIds();
    for (const [id, c] of Object.entries(db.cards)) if (c.x && !c.m && f.has(id)) delete db.cards[id];
    db.fix3 = true; persist(true);
  }
  if (!db.fix4) { // Japanese secret cards are counted now: check Japanese cards rejected earlier again
    for (const [id, c] of Object.entries(db.cards)) if (c.x && !c.m && id.startsWith('ja:')) delete db.cards[id];
    db.fix4 = true; persist(true);
  }
  if (db.ruleV !== 4) { // art rules changed (Ultra Rare, Holo Rare, Mega Hyper Rare ...): cards rejected before are looked at again
    let n = 0;
    for (const [id, c] of Object.entries(db.cards)) if (c.x && !c.m) { delete db.cards[id]; n++; }
    db.ruleV = 4; persist(true);
    log('art rules updated: ' + n + ' earlier rejected cards will be checked again where they now qualify');
  }
  await exclusive(async () => {
    unlimited = !db.initialDone && !STAGGER_INITIAL;
    await refreshNames();
    if (!db.logosDone && canSpend()) { // one request: fetch set pictures for sets stored by an older version
      const list = await paced('/sets');
      if (Array.isArray(list)) { applyLogos(list); db.logosDone = true; persist(true); }
    }
    if ((bootCheck || !db.setsChecked || ageDays(db.setsChecked) >= SETS_CHECK_DAYS || LANGS.some(l => !db.langsDone[l])) && canSpend()) { bootCheck = false; await syncSets(); }
    for (const lang of LANGS) {
      if (db.langsDone[lang] && (!db.rar[lang] || db.rar[lang].v !== 4 || ageDays(db.rar[lang].t) >= SETS_CHECK_DAYS) && canSpend()) await rarityScan(lang);
    }
    await backfill();
    if (!db.initialDone && db.setsChecked && LANGS.every(l => db.rar[l]) && pendingCards().length === 0) {
      db.initialDone = true; unlimited = false;
      log('first build of the database finished');
    }
    if (db.initialDone) await refreshPrices(PRICE_MAX_AGE_DAYS);
    if (db.initialDone && !unlimited) await fillRegularPrices();
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
let lastLang = 0, lastPrices = 0;
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
      hasPricing: !!d.pricing, cardmarketKeys: d.pricing && d.pricing.cardmarket ? Object.keys(d.pricing.cardmarket) : [], pricingFrom: d.pricing ? Object.keys(d.pricing) : [], eur: pr.eu, usd: pr.us });
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

// ---------- owner login ----------
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
let adminPw = String(process.env.ADMIN_PASSWORD || '');
if (adminPw) log('owner password: set by ADMIN_PASSWORD');
else {
  const a = readJSON(ADMIN_FILE);
  adminPw = (a && a.password) || '';
  if (!adminPw) { adminPw = crypto.randomBytes(9).toString('base64url'); writeJSON(ADMIN_FILE, { password: adminPw }); }
  log('OWNER PASSWORD (generated; also saved in admin.json in the data folder; set ADMIN_PASSWORD to choose your own):', adminPw);
}
const sessions = readJSON(SESS_FILE) || {}; // sha256(token) -> expiry
const SESSION_MS = 30 * 86400000;
function saveSessions() { const n = Date.now(); Object.keys(sessions).forEach(k => { if (sessions[k] < n) delete sessions[k]; }); writeJSON(SESS_FILE, sessions); }
const tokenOf = req => { const m = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('dex_session=')); return m ? m.slice(12) : ''; };
const hashTok = t => crypto.createHash('sha256').update(t).digest('hex');
function hasSession(req) { const t = tokenOf(req); if (!t) return false; const e = sessions[hashTok(t)]; return !!e && e > Date.now(); }
function clientIp(req) { const f = TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); return f || req.socket.remoteAddress || ''; }
const isHttps = req => TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const cookie = (req, v, age) => 'dex_session=' + v + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + age + (isHttps(req) ? '; Secure' : '');
const fails = new Map(); // ip -> {n, t}: wrong passwords
const blocked = ip => { const f = fails.get(ip); return !!f && Date.now() - f.t < 15 * 60000 && f.n >= 8; };
const hits = new Map();
const limited = ip => { const n = Date.now(), h = hits.get(ip); if (!h || n - h.t > 60000) { hits.set(ip, { t: n, n: 1 }); return false; } return ++h.n > 600; };

// mode: 'full' (logged in), 'ro' (view only, with a login link), 'view' (view only, no login link at all)
function indexHtml(mode) {
  let h = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const hide = 'window.DEX_HIDE_VALUE=' + (!SHOW_VALUE_PUBLIC) + ';';
  const inj = mode === 'full' ? 'window.DEX_AUTH=true;' : 'window.DEX_READONLY=true;' + hide + (mode === 'ro' ? 'window.DEX_LOGIN=true;' : '');
  return h.replace('<!--DEX_MODE-->', '<script>' + inj + '</script>');
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
  let p = u.pathname, forceAnon = false;
  try {
    // /view/ is the same page without any login option, whoever opens it.
    if (p === '/view') { res.writeHead(301, { Location: '/view/' }); return res.end(); }
    if (p.startsWith('/view/')) { p = p.slice(5); forceAnon = true; }
    const authed = !forceAnon && hasSession(req);
    const ip = clientIp(req);
    if (!authed && limited(ip)) { res.writeHead(429); return res.end('Slow down'); }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' });
      return res.end(indexHtml(authed ? 'full' : (forceAnon ? 'view' : 'ro')));
    }
    if (req.method === 'GET' && p === '/data/cards.json') return sendCompressed(req, res, CARDS_FILE);
    if (req.method === 'GET' && p === '/data/names.json') return sendFile(res, NAMES_FILE);
    if (req.method === 'GET' && p === '/api/status') return sendJSON(res, 200, authed ? status() : { count: lastExport.art, regular: lastExport.regular, running: false, backlog: 0, pricesDue: 0, sets: { scanned: lastExport.sets } });
    if (req.method === 'GET' && p === '/api/set') {
      const s = setPayload(u.searchParams.get('id') || '');
      return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: 'unknown set' });
    }
    if (req.method === 'GET' && p === '/api/state') return sendJSON(res, 200, readJSON(STATE_FILE) || {});
    if (req.method === 'GET' && p === '/api/lang-check') {
      if (!authed) return sendJSON(res, 401, { error: 'login required' });
      if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'The server is set to not contact the card service' });
      if (Date.now() - lastLang < 20000) return sendJSON(res, 429, { error: 'wait 20 seconds between checks' });
      lastLang = Date.now();
      const out = await langCheck(u.searchParams.get('lang') || 'ja');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(out, null, 1));
    }
    // Writing requests must be JSON: a web page on another site cannot send that without permission.
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return sendJSON(res, 415, { error: 'JSON required' });

    if (req.method === 'POST' && p === '/api/login') {
      if (forceAnon) return sendJSON(res, 404, { error: 'not found' });
      if (blocked(ip)) return sendJSON(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
      const b = JSON.parse(await readBody(req, 1e4));
      if (!sameText(String(b.password || ''), adminPw)) {
        const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 15 * 60000 ? { n: f.n + 1, t: Date.now() } : { n: 1, t: Date.now() });
        await sleep(1000);
        return sendJSON(res, 401, { error: 'Wrong password' });
      }
      fails.delete(ip);
      const tok = crypto.randomBytes(24).toString('base64url');
      sessions[hashTok(tok)] = Date.now() + SESSION_MS; saveSessions();
      res.setHeader('Set-Cookie', cookie(req, tok, SESSION_MS / 1000));
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      const t = tokenOf(req); if (t) { delete sessions[hashTok(t)]; saveSessions(); }
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      return sendJSON(res, 200, { ok: true });
    }
    if (!authed) return sendJSON(res, 401, { error: 'login required' });
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
    if (req.method === 'POST' && p === '/api/prices') {
      if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'The server is set to not contact the card service' });
      if (Date.now() - lastPrices < 3000) return sendJSON(res, 429, { error: 'Too soon' });
      lastPrices = Date.now();
      const b = JSON.parse(await readBody(req, 1e5));
      const idx = regIndex(), ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(i => idx.has(i) && !db.cards[i]).slice(0, 6);
      let n = 0;
      for (const i of ids) { if (await priceRegular(i, idx, true)) n++; }
      persist(true);
      return sendJSON(res, 200, { done: n });
    }
    if (req.method === 'POST' && p === '/api/card/mark') {
      const b = JSON.parse(await readBody(req, 1e5));
      const id = String(b.id || '');
      if (!id) return sendJSON(res, 400, { error: 'no card' });
      if (b.art) {
        if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'The server is set to not contact the card service' });
        const mp = pfx(langOf(id));
        const d = await paced('/cards/' + encodeURIComponent(rawId(id)), langOf(id), true);
        if (d && mp === '' && d.category === 'Pokemon' && !(Array.isArray(d.dexId) && d.dexId.length)) { const g = nameDex(d.name); if (g.length) d.dexId = g; }
        if (!d) return sendJSON(res, 502, { error: 'The card service did not know that card' });
        if (!isPokemon(d) && d.category !== 'Trainer') return sendJSON(res, 400, { error: 'That card has no dex number and its name matches no Pokémon' });
        const r = record(d, mp); r.m = 1;
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

server.listen(PORT, () => {
  log('listening on', PORT, '| data dir', DATA_DIR, '|', DAILY_REQUESTS ? 'up to ' + DAILY_REQUESTS + ' requests per day' : 'no daily limit', '|', REQUEST_DELAY_MS / 1000 + ' s between requests');
  try { exportCards(); } catch (e) { log('export failed:', e.message); }
  tick();
  setInterval(tick, 3600 * 1000);
});
