'use strict';
// Dex Art Card Tracker server (TCGdex edition).
//
// Local database, built gently:
//  1. Sets: the set list is checked at start and then daily (SETS_CHECK_DAYS); every new set is fetched once.
//     A set request returns all its cards by name and image, so every card is stored from that
//     alone. Regular cards need no further requests.
//  2. Art candidates: TCGdex is asked which cards have an art rarity (a few dozen list requests), and
//     every card in a promo set counts too. Those cards get a request of their own, to read rarity,
//     dex number and price. (If the rarity search is not available, cards numbered above the official
//     set size are used instead.) Japanese sets are read the same way. Card data never changes, so it
//     is stored forever.
//  3. Prices: the cheapest few art cards per Pokémon are re-priced slowly, oldest first (one request every
//     REQUEST_DELAY_MS). Cards and Pokémon that every account owns are not re-priced.
//  Accounts: every trainer has their own dex (ticks, wish list, history); the card database is shared.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');
const dns = require('dns');
const net = require('net');

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
const REQUEST_DELAY_MS = process.env.REQUEST_DELAY_MS !== undefined ? +process.env.REQUEST_DELAY_MS : 2000; // pause between requests, 2 seconds by default
const PRICE_MAX_AGE_DAYS = +process.env.PRICE_MAX_AGE_DAYS || 30;
const SETS_CHECK_DAYS = +process.env.SETS_CHECK_DAYS || 1; // the set list is checked at start and then this often
const PRICE_CANDIDATES = +process.env.PRICE_CANDIDATES || 2;
const MIN_SET_DATE = process.env.MIN_SET_DATE || '2000-01-01'; // only sets released on or after this date are read
const DISABLE_REFRESH = process.env.DISABLE_REFRESH === '1';
// 0 (default): the first build of the database runs in one go, at REQUEST_DELAY_MS between requests.
// 1: even the first build is limited to DAILY_REQUESTS per day. ("4" is still accepted from older setups.)
const STAGGER_INITIAL = process.env.STAGGER_INITIAL === '1' || process.env.STAGGER_INITIAL === '4';
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
// Which prices the page shows: cardmarket (€, default) or tcgplayer ($).
const PRICE_CUR = /^(tcgplayer|us|usd|\$)$/i.test(String(process.env.PRICE_SOURCE || '').trim()) ? 'us' : 'eu';
// Pictures for cards TCGdex has none for (mostly promos) are looked up in the pokemontcg.io card search.
const PICTURE_LOOKUP = process.env.PICTURE_LOOKUP !== '0';
const PTCG_API = (process.env.PTCG_API || 'https://api.pokemontcg.io/v2').replace(/\/$/, '');
const PTCG_API_KEY = process.env.PTCG_API_KEY || '';
const PICTURES_PER_DAY = process.env.PICTURES_PER_DAY !== undefined ? +process.env.PICTURES_PER_DAY : 500; // 0 = no limit
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
db.pics = db.pics || {};          // card id -> {im, imL, t, m}: picture found elsewhere (m = set by hand)
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
// Rarity a not-yet-fetched art card was listed under (kept from the rarity search).
function provRarity(id) {
  const r = db.rar[langOf(id)];
  return (r && r.m && r.m[rawId(id)]) || (String(id).startsWith('ja:') ? 'Secret card' : null);
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
// Names that do not match PokeAPI's spelling once punctuation is removed.
const ALIAS = { 83: ['farfetch d'], 865: ['sirfetch d'] };
function dexByName(name, list) { // list: [[dex, [' token ', ...]], ...]
  const raw = String(name || ''), t = ' ' + toks(raw) + ' ';
  const out = list.filter(([, ks]) => ks.some(k => t.includes(k))).map(([n]) => n);
  if (/♀/.test(raw) && !out.includes(29)) out.push(29); // Nidoran♀
  if (/♂/.test(raw) && !out.includes(32)) out.push(32); // Nidoran♂
  return out;
}
// Japanese card names contain the Pokémon's katakana name (リザードンex, ナンジャモのピカチュウ ...).
let jaCache = null;
function jaList() {
  const n = NM && NM.ja ? Object.keys(NM.ja).length : 0;
  if (!jaCache || jaCache.n !== n) jaCache = { n, list: Object.entries(NM.ja || {}).map(([d, name]) => [+d, String(name).normalize('NFKC')]).filter(x => x[1].length >= 2) };
  return jaCache.list;
}
function dexByNameJa(raw) {
  if (!NM || !NM.ja) return [];
  const t = String(raw || '').normalize('NFKC');
  const hits = jaList().filter(([, name]) => t.includes(name));
  // ミュウ is part of ミュウツー: a name that only appears inside a longer matching name does not count
  const keep = hits.filter(([, a]) => !hits.some(([, b]) => b.length > a.length && b.includes(a)));
  return [...new Set(keep.map(([n]) => n))];
}
const speciesList = () => Object.entries(NM.names).map(([n, name]) => [+n, [' ' + toks(name) + ' '].concat((ALIAS[n] || []).map(a => ' ' + a + ' '))]);
function nameDex(name) {
  if (!NM || !NM.names) return [];
  return dexByName(name, speciesList());
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
  if (c.sp === undefined) { const k = cmp(c.n || ''); c.sp = (SP.some(s => k.includes(s)) || /[♀♂]/.test(c.n || '')) ? 1 : 0; }
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
    NM = { t: Date.now(), max, names, ja: NM && NM.ja, jaDone: NM && NM.jaDone };
    writeJSON(NAMES_FILE, NM);
    loadSpecies();
    log('names updated:', Object.keys(names).length);
  } catch (e) { log('names refresh failed:', e.message); }
}

// Regular cards have no dex number in the set listing, so they are matched to Pokémon by name.
function matchRegular() {
  const key = NM && NM.names ? NM.t + ':' + (NM.jaDone || 0) : null;
  if (!key || db.regMatched === key) return;
  const sp = speciesList();
  for (const s of Object.values(db.sets)) {
    if (!s.scan) continue;
    for (const c of s.cards) c.d = s.lang === 'ja' ? dexByNameJa(c.n) : dexByName(c.n, sp);
  }
  db.regMatched = key;
}

// Japanese species names from PokeAPI: one GraphQL request, or one request per Pokémon if that is not available.
async function refreshJaNames() {
  if (!LANGS.includes('ja') || !NM || !NM.names) return;
  const want = Object.keys(NM.names).map(Number);
  NM.ja = NM.ja || {};
  if (NM.jaDone && Object.keys(NM.ja).length >= want.length * 0.9) return;
  const have = () => Object.keys(NM.ja).length;
  if (have() < want.length * 0.9) {
    try {
      const r = await fetch('https://beta.pokeapi.co/graphql/v1beta', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'dex-art-tracker' }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ query: '{ pokemon_v2_pokemonspeciesname(where: {pokemon_v2_language: {name: {_in: ["ja-Hrkt", "ja"]}}}) { pokemon_species_id name pokemon_v2_language { name } } }' }),
      });
      const j = r.ok ? await r.json() : null;
      const rows = j && j.data && j.data.pokemon_v2_pokemonspeciesname;
      if (Array.isArray(rows)) rows.forEach(x => { const id = x.pokemon_species_id; if (id && x.name && (x.pokemon_v2_language.name === 'ja-Hrkt' || !NM.ja[id])) NM.ja[id] = x.name; });
    } catch (e) { log('japanese names (bulk) failed:', e.message); }
  }
  if (have() < want.length * 0.9) { // fall back to one request per Pokémon, up to 400 per start of a run
    let n = 0;
    for (const id of want) {
      if (NM.ja[id]) continue;
      if (n++ >= 400) break;
      try {
        const r = await fetch('https://pokeapi.co/api/v2/pokemon-species/' + id + '/', { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'dex-art-tracker' } });
        if (r.ok) {
          const j = await r.json();
          const nm = (j.names || []).find(x => x.language.name === 'ja-Hrkt') || (j.names || []).find(x => x.language.name === 'ja');
          if (nm) NM.ja[id] = nm.name;
        }
      } catch (e) { /* try again in a later run */ }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  if (have() >= want.length * 0.9) { NM.jaDone = Date.now(); log('japanese names loaded:', have()); }
  writeJSON(NAMES_FILE, NM);
  jaCache = null;
}

// ---------- export for the page ----------
let lastExport = { art: 0, regular: 0, sets: 0 };
// Picture fields for the page: im (small) and iL (large), when one was found elsewhere or set by hand.
function picOf(id, o) {
  const p = db.pics[id]; if (p && p.im) { o.im = p.im; o.iL = p.imL || p.im; }
  const st = imgs.c[id]; if (st) { o.lc = st.h ? 2 : 1; o.lv = st.v; } // stored on this server: 1 = low, 2 = low and high
  return o;
}
function exportCards() {
  matchRegular();
  const setPics = regIndex();
  const art = [], trainers = [], regular = [], sets = [];
  Object.values(db.cards).forEach(c => {
    if (c.x) return;
    (c.tr ? trainers : art).push(picOf(c.id, { id: c.id, n: c.n, r: c.r, sid: c.sid, k: localOf(c.id, c.sid), b: c.b || (setPics.get(c.id) && setPics.get(c.id).i ? cleanBase(setPics.get(c.id).i) : null), d: c.d, eu: c.eu, us: c.us, cm: c.cm || undefined, pt: c.pt, m: c.m ? 1 : undefined }));
  });
  for (const [sid, s] of Object.entries(db.sets)) {
    if (!s.scan) continue;
    let a = 0;
    for (const c of s.cards) {
      const rec = db.cards[c.id];
      if (rec && !rec.x) { a++; continue; }
      if (!rec && worth(s, c)) { // known to be an art card, details still to be fetched: show it already
        if (c.d && c.d.length) art.push(picOf(c.id, { id: c.id, n: c.n, r: provRarity(c.id), sid, k: c.l, b: c.i ? cleanBase(c.i) : null, d: c.d, eu: null, us: null, pv: 1 }));
        a++; continue;
      }
      if (c.d && c.d.length) regular.push(picOf(c.id, { id: c.id, n: c.n, sid, k: c.l, b: c.i || null, d: c.d, eu: c.eu, us: c.us, cm: c.cm || undefined, pt: c.pt }));
    }
    sets.push({ id: sid, name: s.name, date: s.date || '', official: s.official, total: s.total, n: s.cards.length, art: a, promo: s.promo ? 1 : 0,
      lg: noExt(s.lg), sy: noExt(s.sy), ll: imgs.s[sid] ? imgs.s[sid].v : undefined });
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
      const o = picOf(c.id, { id: c.id, k: c.l, n: c.n, b: c.i || null });
      if (rec && !rec.x) { o.t = 'a'; o.r = rec.r; o.eu = rec.eu; o.us = rec.us; o.cm = rec.cm; o.pt = rec.pt; o.d = rec.d; if (rec.m) o.m = 1; }
      else if (!rec && worth(s, c)) { o.t = 'a'; o.pv = 1; o.r = provRarity(c.id); o.d = c.d || []; o.eu = null; o.us = null; }
      else { o.t = 'r'; o.eu = c.eu; o.us = c.us; o.cm = c.cm; o.pt = c.pt; o.d = c.d || []; }
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
    const oldCards = new Map(((have && have.cards) || []).map(c => [c.id, c]));
    db.sets[key] = {
      name: d.name, date, scan, pocket: !!pocket, promo: lang === 'en' && /promo/i.test(d.name || ''), lang,
      lg: s.logo || d.logo || null, sy: s.symbol || d.symbol || null,
      official: (d.cardCount && d.cardCount.official) || 0,
      total: (d.cardCount && d.cardCount.total) || 0,
      cards: scan ? (d.cards || []).map(c => {
        const o = oldCards.get(p + c.id), n = { id: p + c.id, l: String(c.localId), n: c.name, i: c.image || (o && o.i) || null };
        if (o && o.pt) { n.eu = o.eu; n.us = o.us; n.cm = o.cm; n.pt = o.pt; } // keep prices already fetched for regular cards
        return n;
      }) : [],
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
  const ids = new Set(), sigs = new Map(), rmap = {}; let ok = true;
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
      r.forEach(x => { if (x && x.id) { ids.add(String(x.id)); if (!rmap[x.id]) rmap[x.id] = nm; } });
      if (ids.size > 60000) { ok = false; break outer; }
      if (r.length < 100) break;
    }
  }
  if (!ids.size) ok = false;
  db.rar[lang] = { v: 5, t: new Date().toISOString(), ok, ids: ok ? [...ids] : [], m: ok ? rmap : {} };
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

async function fetchCard(id, fast) {
  const lang = langOf(id), p = pfx(lang);
  if (db.cards[id] && db.cards[id].x && db.cards[id].m) return; // you took this card off the art list: leave it
  const d = await paced('/cards/' + encodeURIComponent(rawId(id)), lang, fast);
  const old = db.cards[id];
  if (d && d.category === 'Pokemon' && !(Array.isArray(d.dexId) && d.dexId.length)) { const g = p === '' ? nameDex(d.name) : dexByNameJa(d.name); if (g.length) d.dexId = g; }
  if (d && qualifies(d, p)) {
    const r = record(d, p); if (old && old.m) r.m = 1;
    if (old && !old.x) { // never replace something known with nothing: keep the last picture, price and shop number
      if (!r.b && old.b) r.b = old.b;
      if (r.eu == null && old.eu != null) r.eu = old.eu;
      if (r.us == null && old.us != null) r.us = old.us;
      if (!r.cm && old.cm) r.cm = old.cm;
    }
    db.cards[id] = r;
  }
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
// With several accounts, a card or Pokémon is only skipped when every account owns it.
function planPriceRefresh(maxAge, limit) {
  const states = allStates();
  const all = fn => states.length > 0 && states.every(fn);
  const ownedByAll = id => all(s => !!s.cards[id]);
  const byDex = {};
  Object.values(db.cards).forEach(c => { if (!c.x && !c.tr) c.d.forEach(n => { (byDex[n] = byDex[n] || []).push(c); }); });
  const picked = new Map();
  Object.values(db.cards).forEach(c => { if (!c.x && c.tr && !ownedByAll(c.id)) picked.set(c.id, c); });
  Object.keys(byDex).forEach(n => {
    if (all(s => (s.own[n] && s.own[n].art) || byDex[n].some(c => s.cards[c.id]))) return;
    ['eu', 'us'].forEach(cur => {
      byDex[n].slice().sort((a, b) => {
        const pa = a[cur], pb = b[cur];
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1; if (pb == null) return -1;
        return pa - pb;
      }).slice(0, PRICE_CANDIDATES).forEach(c => picked.set(c.id, c));
    });
  });
  // Art cards on someone's wish list are kept up to date as well, however expensive they are.
  const wished = wishedIds();
  Object.values(db.cards).forEach(c => { if (!c.x && wished.has(c.id)) picked.set(c.id, c); });
  // Art cards that have no picture yet are asked about again every 7 days (TCGdex adds pictures later).
  const noPic = Object.values(db.cards).filter(c => !c.x && !c.b && !ownedByAll(c.id) && ageDays(c.pt) >= 7);
  return [...new Set([...picked.values()].filter(c => ageDays(c.pt) >= maxAge).concat(noPic))]
    .sort((a, b) => (b.m ? 1 : 0) - (a.m ? 1 : 0) || Date.parse(a.pt || 0) - Date.parse(b.pt || 0)) // cards you picked by hand first
    .slice(0, limit);
}

async function refreshPrices(maxAge) {
  for (const c of planPriceRefresh(maxAge, Infinity)) {
    if (!canSpend()) return;
    await fetchCard(c.id);
  }
  // Wished regular cards (art cards are in the plan above).
  const idx = regIndex();
  for (const id of wishedIds()) {
    const c = idx.get(id);
    if (!c || db.cards[id] || ageDays(c.pt) < maxAge) continue;
    if (!canSpend()) return;
    await priceRegular(id, idx);
  }
}
// Every card on someone's wish list.
function wishedIds() { const out = new Set(); allStates().forEach(s => wishOf(s).forEach(w => out.add(w.id))); return out; }

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
  const sets = Object.values(db.sets).filter(s => s.scan).sort((a, b) => String(b.date).localeCompare(String(a.date)));
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

// ---------- pictures from pokemontcg.io ----------
// Cards the page shows that have no TCGdex picture, promo sets first, then newest sets. English only:
// pokemontcg.io has no Japanese cards. A card without a result is asked about again after 30 days.
function picsNeeded() {
  const out = [];
  const sets = Object.entries(db.sets).filter(([, s]) => s.scan && s.lang !== 'ja')
    .sort((a, b) => (b[1].promo ? 1 : 0) - (a[1].promo ? 1 : 0) || String(b[1].date).localeCompare(String(a[1].date)));
  for (const [sid, s] of sets) for (const c of s.cards) {
    const rec = db.cards[c.id], art = !!(rec && !rec.x);
    if (c.i || (art && rec.b)) continue;
    if (!art && !(c.d && c.d.length)) continue; // the page only shows Pokémon cards and art cards
    const p = db.pics[c.id];
    if (p && (p.m || p.im || ageDays(p.t) < 30)) continue;
    out.push({ id: c.id, sid, k: c.l, n: art ? rec.n : c.n, promo: !!s.promo });
  }
  return out;
}
const ptcgSetId = sid => String(sid).replace(/^([a-z]+)0*(\d)/i, '$1$2').replace('.', 'pt');
const plainNum = k => /^\d+$/.test(String(k)) ? String(+k) : String(k);
async function ptcgSearch(q) {
  const headers = { 'User-Agent': 'dex-art-tracker' }; if (PTCG_API_KEY) headers['X-Api-Key'] = PTCG_API_KEY;
  const r = await fetch(PTCG_API + '/cards?q=' + encodeURIComponent(q) + '&pageSize=20&select=id,name,number,set,images', { headers, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('pokemontcg.io answered HTTP ' + r.status);
  const j = await r.json();
  return Array.isArray(j.data) ? j.data : [];
}
const httpsUrl = u => typeof u === 'string' && /^https?:\/\/\S+$/.test(u) && u.length < 1000;
// First by set and number; if the set id differs there, by name and number, keeping only an unambiguous match.
async function findPicture(c) {
  const clean = x => String(x).replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
  const num = clean(plainNum(c.k));
  let hits = await ptcgSearch('set.id:' + ptcgSetId(c.sid) + ' number:"' + num + '"');
  if (!hits.length) {
    await sleep(REQUEST_DELAY_MS);
    hits = await ptcgSearch('name:"' + clean(c.n) + '" number:"' + num + '"');
    if (hits.length > 1) {
      const setName = toks((db.sets[c.sid] || {}).name || '');
      const same = hits.filter(h => h.set && toks(h.set.name) === setName);
      hits = same.length ? same : hits.filter(h => /promo/i.test((h.set && h.set.name) || '') === c.promo);
    }
    if (hits.length !== 1) hits = [];
  }
  const h = hits.find(x => x.images && (httpsUrl(x.images.small) || httpsUrl(x.images.large)));
  if (!h) return null;
  const sm = httpsUrl(h.images.small) ? h.images.small : h.images.large, lg = httpsUrl(h.images.large) ? h.images.large : sm;
  return { im: sm, imL: lg };
}
async function fillPictures() {
  if (!PICTURE_LOOKUP) return;
  rollBudget(); db.budget.pic = db.budget.pic || 0;
  let n = 0, found = 0;
  for (const c of picsNeeded()) {
    if ((PICTURES_PER_DAY && db.budget.pic >= PICTURES_PER_DAY) || n >= 200) break; // at most 200 per hourly run
    n++; db.budget.pic++;
    try {
      const f = await findPicture(c);
      db.pics[c.id] = f ? Object.assign(f, { t: new Date().toISOString() }) : { t: new Date().toISOString() };
      if (f) found++;
    } catch (e) { log('picture lookup paused:', e.message); break; }
    persist(false);
    await sleep(REQUEST_DELAY_MS);
  }
  if (n) { persist(true); log('picture lookup: ' + found + ' of ' + n + ' cards found on pokemontcg.io'); }
}

// ---------- pictures stored on the server ----------
// Every card picture the page shows is downloaded once, checked and re-saved as WebP in the data folder:
// low (245 px wide) and high (734 px) for every card (IMAGE_HIGH=art: high only for art cards, cards someone
// owns or wishes for, and custom pictures). The page loads these first and only falls back to the
// outside sites for pictures not stored yet. Safety:
//  - Automatic downloads only come from the three known card picture sites, over https.
//  - Custom picture addresses (main admin) may be any https site, but never a private, local or
//    reserved network address (checked on the address actually connected to, also after redirects).
//  - At most 15 MB per picture; every picture is decoded and re-encoded by sharp (anything that is not
//    a JPG, PNG, WebP, GIF, AVIF or TIFF picture is refused), so only clean WebP files are stored and served.
//  - Files are named by a hash of the card id, never by anything from a request.
let sharp = null;
try { sharp = require('sharp'); sharp.cache(false); sharp.concurrency(1); }
catch (e) { log('sharp is not installed: pictures are not stored on the server (rebuild the container)'); }
const IMAGE_CACHE = process.env.IMAGE_CACHE !== '0';
// Which cards also get a high resolution copy: all (default), art (art cards, owned and wished cards), none.
const IMAGE_HIGH = ['art', 'none'].includes(String(process.env.IMAGE_HIGH || '').toLowerCase()) ? process.env.IMAGE_HIGH.toLowerCase() : 'all';
const IMAGE_DELAY_MS = process.env.IMAGE_DELAY_MS !== undefined ? +process.env.IMAGE_DELAY_MS : 1000;
const IMG_DIR = path.join(DATA_DIR, 'images');
const IMG_FILE = path.join(DATA_DIR, 'images.json');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const LOW_W = 245, HIGH_W = 734, LOGO_H = 120;
const AUTO_HOSTS = new Set(['assets.tcgdex.net', 'images.pokemontcg.io', 'images.scrydex.com']);
const imgs = readJSON(IMG_FILE) || {};
imgs.c = imgs.c || {};       // card id -> {h: high stored, s: source, v: version, t, hx: time a high one was not found}
imgs.s = imgs.s || {};       // set id -> {v, t}
imgs.fail = imgs.fail || {}; // 'c:<id>' / 's:<id>' -> time of the last failed try (tried again after 7 days)
let imgDirty = 0;
function saveImgs(force) { if (force || ++imgDirty >= 25) { imgDirty = 0; writeJSON(IMG_FILE, imgs); } }
const imgHash = id => crypto.createHash('sha1').update(String(id)).digest('hex');
function imgPath(kind, id, size) { const k = imgHash(id); return path.join(IMG_DIR, kind, k.slice(0, 2), k + (size ? '-' + size : '') + '.webp'); }
function writeAtomic(file, buf) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file); }

function privateIp(ip) {
  ip = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (!net.isIPv6(ip)) return true;
  if (ip.startsWith('::ffff:')) return net.isIPv4(ip.slice(7)) ? privateIp(ip.slice(7)) : true;
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || ip.startsWith('64:ff9b') || ip.startsWith('2001:db8') || ip.startsWith('100::');
}
// Resolves the host and refuses it when any of its addresses is private; the connection uses the checked address.
function safeLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => privateIp(a.address))) return cb(new Error('that address points into a private or local network'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
function fetchImage(url, custom, redirects) {
  if (redirects === undefined) redirects = 3;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('not a valid address')); }
    if (u.protocol !== 'https:') return reject(new Error('only https:// addresses are downloaded'));
    if (u.port && u.port !== '443') return reject(new Error('only the normal https port is allowed'));
    if (u.username || u.password) return reject(new Error('addresses with a user name are not allowed'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!custom && !AUTO_HOSTS.has(host)) return reject(new Error('host not allowed: ' + host));
    if (net.isIP(host) && privateIp(host)) return reject(new Error('that address points into a private or local network'));
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const req = https.get(u, { lookup: safeLookup, timeout: 20000, headers: { 'User-Agent': 'dex-art-tracker', Accept: 'image/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return finish(reject, new Error('too many redirects'));
        let next; try { next = new URL(res.headers.location, u).toString(); } catch (e) { return finish(reject, new Error('bad redirect')); }
        return fetchImage(next, custom, redirects - 1).then(v => finish(resolve, v), e => finish(reject, e));
      }
      if (res.statusCode !== 200) { res.resume(); return finish(reject, new Error('the site answered HTTP ' + res.statusCode)); }
      if (+res.headers['content-length'] > MAX_IMAGE_BYTES) { res.destroy(); return finish(reject, new Error('the picture is larger than 15 MB')); }
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > MAX_IMAGE_BYTES) { res.destroy(); finish(reject, new Error('the picture is larger than 15 MB')); } else chunks.push(c); });
      res.on('end', () => finish(resolve, Buffer.concat(chunks)));
      res.on('error', e => finish(reject, e));
    });
    const timer = setTimeout(() => req.destroy(new Error('the download took too long')), 30000);
    req.on('timeout', () => req.destroy(new Error('the site did not answer')));
    req.on('error', e => finish(reject, e));
  });
}
const IMG_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'];
async function checkedImage(buf) {
  if (!sharp) throw new Error('picture processing is not available');
  const m = await sharp(buf, { limitInputPixels: 40e6, failOn: 'error' }).metadata();
  if (!IMG_FORMATS.includes(m.format)) throw new Error('not a supported picture (use JPG, PNG, WebP, GIF or AVIF)');
  if (!(m.width >= 40 && m.height >= 40)) throw new Error('the picture is too small');
  return sharp(buf, { limitInputPixels: 40e6, failOn: 'error' }).rotate(); // first frame only, turned upright, no metadata kept
}
async function makeCardImages(buf, wantHigh) {
  const base = await checkedImage(buf);
  const low = await base.clone().resize({ width: LOW_W, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  const high = wantHigh ? await base.clone().resize({ width: HIGH_W, withoutEnlargement: true }).webp({ quality: 85 }).toBuffer() : null;
  return { low, high };
}
function storeCard(id, out, src, wantedHigh) {
  writeAtomic(imgPath('c', id, 'low'), out.low);
  if (out.high) writeAtomic(imgPath('c', id, 'high'), out.high);
  else { try { fs.unlinkSync(imgPath('c', id, 'high')); } catch (e) { /* none */ } }
  const now = new Date().toISOString();
  imgs.c[id] = { h: out.high ? 1 : 0, s: src, v: Date.now().toString(36), t: now };
  if (wantedHigh && !out.high) imgs.c[id].hx = now;
  delete imgs.fail['c:' + id];
  saveImgs();
}
function dropCard(id) {
  ['low', 'high'].forEach(z => { try { fs.unlinkSync(imgPath('c', id, z)); } catch (e) { /* none */ } });
  delete imgs.c[id]; delete imgs.fail['c:' + id]; saveImgs(true);
}
// Where a card's picture can come from, best first: TCGdex, the pokemontcg.io picture found for it,
// then the addresses the page used to guess (pokemontcg.io and Scrydex by set id and number).
function cardSources(c, wantHigh) {
  const hi = [], lo = [];
  if (c.b) { hi.push({ url: c.b + '/high.webp', src: 'tcgdex' }); lo.push({ url: c.b + '/low.webp', src: 'tcgdex' }); }
  const pc = db.pics[c.id];
  if (pc && pc.im && !pc.m) { hi.push({ url: pc.imL || pc.im, src: 'pokemontcg' }); lo.push({ url: pc.im, src: 'pokemontcg' }); }
  if (c.k != null && c.k !== '') {
    const plain = plainNum(c.k);
    if (langOf(c.sid) === 'ja') {
      const js = encodeURIComponent(rawId(c.sid).toLowerCase());
      [plain, String(c.k)].filter((x, i, a) => a.indexOf(x) === i).forEach(n => {
        hi.push({ url: 'https://images.scrydex.com/pokemon/' + js + '_ja-' + encodeURIComponent(n) + '/medium', src: 'scrydex' });
        lo.push({ url: 'https://images.scrydex.com/pokemon/' + js + '_ja-' + encodeURIComponent(n) + '/small', src: 'scrydex' });
      });
    } else {
      const pid = encodeURIComponent(ptcgSetId(c.sid)), n = encodeURIComponent(plain);
      hi.push({ url: 'https://images.pokemontcg.io/' + pid + '/' + n + '_hires.png', src: 'pokemontcg' });
      lo.push({ url: 'https://images.pokemontcg.io/' + pid + '/' + n + '.png', src: 'pokemontcg' });
      hi.push({ url: 'https://images.scrydex.com/pokemon/' + pid + '-' + n + '/medium', src: 'scrydex' });
      lo.push({ url: 'https://images.scrydex.com/pokemon/' + pid + '-' + n + '/small', src: 'scrydex' });
    }
  }
  return wantHigh ? hi.map(x => Object.assign(x, { big: true })).concat(lo) : lo;
}
// Cards whose picture should be stored, owned and wished-for cards first, then art cards, then the rest,
// newest sets first within each group.
function imageTargets() {
  const prio = new Set();
  allStates().forEach(s => { Object.keys(s.cards).forEach(id => { if (s.cards[id]) prio.add(id); }); wishOf(s).forEach(w => prio.add(w.id)); });
  const out = [];
  const sets = Object.entries(db.sets).filter(([, s]) => s.scan).sort((a, b) => String(b[1].date).localeCompare(String(a[1].date)));
  for (const [sid, s] of sets) for (const c of s.cards) {
    const rec = db.cards[c.id], art = rec ? !rec.x : worth(s, c);
    if (!art && !(c.d && c.d.length)) continue; // the page only shows Pokémon cards and art cards
    const have = imgs.c[c.id], pc = db.pics[c.id];
    if (have && have.s === 'custom') continue;
    const b = (rec && !rec.x && rec.b) || cleanBase(c.i);
    const wantHigh = IMAGE_HIGH === 'all' || (IMAGE_HIGH === 'art' && (art || prio.has(c.id)));
    if (have) {
      const upgrade = b && have.s !== 'tcgdex'; // TCGdex has a picture now
      const needHigh = wantHigh && !have.h && !(have.hx && ageDays(have.hx) < 30);
      if (!upgrade && !needHigh) continue;
    }
    const f = imgs.fail['c:' + c.id];
    if (f && ageDays(f) < 7) continue;
    out.push({ id: c.id, sid, k: c.l, b, wantHigh, custom: !!(pc && pc.m && pc.im && !have), p: prio.has(c.id) ? 2 : art ? 1 : 0 });
  }
  return out.sort((a, b) => b.p - a.p);
}
async function downloadCard(c) {
  if (c.custom) { // a picture address set by hand in an earlier version: store it like a new custom picture
    try { storeCard(c.id, await makeCardImages(await fetchImage(db.pics[c.id].im, true), true), 'custom', true); return true; }
    catch (e) { imgs.fail['c:' + c.id] = new Date().toISOString(); saveImgs(); return false; }
  }
  for (const s of cardSources(c, c.wantHigh)) {
    try {
      const out = await makeCardImages(await fetchImage(s.url, false), c.wantHigh && !!s.big);
      storeCard(c.id, out, s.src, c.wantHigh);
      return true;
    } catch (e) { /* try the next source */ }
  }
  imgs.fail['c:' + c.id] = new Date().toISOString(); saveImgs();
  return false;
}
function logoSources(sid, s) {
  const l = [];
  if (s.lg) { l.push(s.lg + '.png'); l.push(s.lg + '.webp'); }
  if (s.sy) l.push(s.sy + '.png');
  if (langOf(sid) !== 'ja') l.push('https://images.pokemontcg.io/' + encodeURIComponent(ptcgSetId(sid)) + '/logo.png');
  return l;
}
async function downloadLogo(sid, s) {
  for (const url of logoSources(sid, s)) {
    try {
      const base = await checkedImage(await fetchImage(url, false));
      writeAtomic(imgPath('s', sid), await base.resize({ height: LOGO_H, withoutEnlargement: true }).webp({ quality: 90 }).toBuffer());
      imgs.s[sid] = { v: Date.now().toString(36), t: new Date().toISOString() }; delete imgs.fail['s:' + sid]; saveImgs();
      return true;
    } catch (e) { /* next */ }
  }
  imgs.fail['s:' + sid] = new Date().toISOString(); saveImgs();
  return false;
}
// Runs in the hourly background job for at most 25 minutes.
async function fillImages() {
  if (!IMAGE_CACHE || !sharp) return;
  const t0 = Date.now(); let n = 0, ok = 0;
  for (const [sid, s] of Object.entries(db.sets)) {
    if (!s.scan || imgs.s[sid] || (imgs.fail['s:' + sid] && ageDays(imgs.fail['s:' + sid]) < 7)) continue;
    n++; if (await downloadLogo(sid, s)) ok++;
    await sleep(IMAGE_DELAY_MS);
  }
  for (const c of imageTargets()) {
    if (Date.now() - t0 > 25 * 60000) break;
    n++; if (await downloadCard(c)) ok++;
    if (n % 50 === 0) exportCards();
    await sleep(IMAGE_DELAY_MS);
  }
  saveImgs(true);
  if (n) { exportCards(); log('pictures stored on the server: ' + ok + ' of ' + n + ' this run, ' + Object.keys(imgs.c).length + ' cards in total'); }
}
function sendImage(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.end(buf);
  });
}

// ---------- card scanning ----------
// The app sends a photo with one or more cards. For every card on it the server:
//  1. finds the card's rectangle with OpenCV (edges -> outlines -> four corners) and straightens it,
//  2. compares the straightened card with the stored pictures of all cards (a small colour fingerprint per
//     card, kept in fingerprints.bin and built in the background), which works even when no text is readable,
//  3. reads the name (top of the card) and the card number (bottom, left or right) with Tesseract and matches
//     them tolerantly: "Toxtr" still finds Toxtricity, "GG09" or "/198" still count.
// Everything runs on this server with its own data; nothing is sent anywhere.
const SCAN = process.env.SCAN !== '0';
const SCAN_DEBUG = process.env.SCAN_DEBUG === '1'; // log what each scan finds and reads, with timings
const slog = (...a) => { if (SCAN_DEBUG) log('[scan]', ...a); };
let ocr = null, ocrIdle = null, ocrChain = Promise.resolve(), ocrWaiting = 0, cvPromise = null;
async function ocrWorker() {
  if (ocr) return ocr;
  const { createWorker } = require('tesseract.js');
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  ocr = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true });
  await ocr.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text: lines anywhere in the area
  return ocr;
}
function ocrRelease() { // free the reader's memory again after 10 quiet minutes
  clearTimeout(ocrIdle);
  ocrIdle = setTimeout(() => { if (ocr && !ocrWaiting) { ocr.terminate().catch(() => {}); ocr = null; } }, 10 * 60000);
}
function cvReady() {
  if (!cvPromise) cvPromise = (async () => {
    let cv = require('@techstark/opencv-js');
    if (cv instanceof Promise) cv = await cv;
    // the library may finish loading before or after this point: wait until its functions are there
    for (let i = 0; !(cv.Mat && cv.Canny) && i < 600; i++) await sleep(50);
    if (!cv.Mat) throw new Error('OpenCV did not load');
    // OpenCV's module object has a then() of its own: hand it over wrapped, or awaiting it never ends
    return { cv };
  })();
  return cvPromise;
}
const NAME_KINDS = ['ex', 'gx', 'v', 'vmax', 'vstar', 'vunion', 'break', 'prime', 'lv', 'star', 'radiant', 'mega'];
const NAME_NOISE = new Set(['stage', 'basic', 'evolves', 'from', 'hp', 'pokemon', 'ability', 'trainer', 'item', 'tool', 'supporter', 'stadium', 'tera', 'fusion', 'strike', 'single', 'rapid', 'illus']);
const CARD_W = 1000, CARD_H = 1397; // a card is 63 x 88 mm
const MAX_CARDS = 12;

// "201", "TG05", "SWSH050", "GG35", "SV-P 050" -> "201", "TG5", "SWSH50", "GG35"
function normNum(x) {
  const m = /^([A-Za-z]*)-?0*(\d+)([a-z]?)$/.exec(String(x).replace(/\s+/g, ''));
  return m ? m[1].toUpperCase() + (+m[2] || 0) + m[3] : String(x).toUpperCase();
}
const ocrDigits = s => s.replace(/[Oo]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss](?=\d)|(?<=\d)[Ss]/g, '5');
// What the card number line says: the number, the set size, or only part of them.
function readNumber(text) {
  const t = String(text).replace(/[⁄∕]/g, '/');
  // a letter prefix only counts when it touches the digits ("TG05/TG30"), so "EN 201/198" reads as 201/198
  let m = /(?:\b([A-Z]{2,4}))?([0-9OoIl|]{1,3})\s*\/\s*([A-Z]{2,4})?([0-9OoIl|]{2,3})\b/.exec(t);
  if (m) {
    const n = +ocrDigits(m[2]), tot = +ocrDigits(m[4]);
    if (n > 0 && tot > 0) return { num: normNum((m[1] || '') + n), total: m[3] ? null : tot, text: m[0].trim() };
  }
  m = /\b(SVP|SWSH|SM|XY|BW|DP|HGSS|SV-P|MEP)\s*(?:EN\s*)?([0-9OoIl|]{1,3})\b/i.exec(t); // promos: no "/total"
  if (m) return { num: normNum(m[1].replace('-', '').toUpperCase() === 'SVP' ? String(+ocrDigits(m[2])) : m[1].replace('-', '') + (+ocrDigits(m[2]))), total: null, promo: true, text: m[0].trim() };
  m = /\b(TG|GG|RC|SV|SH)\s?([0-9OoIl|]{1,3})\b/.exec(t); // a gallery / subset number without its "/total"
  if (m) return { num: normNum(m[1] + (+ocrDigits(m[2]))), total: null, text: m[0].trim() };
  m = /\/\s*([0-9OoIl|]{2,3})\b/.exec(t); // only "/198": the set size
  if (m && +ocrDigits(m[1]) >= 20) return { num: null, total: +ocrDigits(m[1]), text: m[0].trim() };
  return null;
}

// Tolerant word matching for what Tesseract makes of stylised names ("Toxtr;", "Charizrd").
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < best) best = cur[j]; }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// 1 = same word, down to 0.6 for a close misreading or a cut-off start of at least 5 letters, 0 = no match
function wordLike(ocrWord, word) {
  if (ocrWord === word) return 1;
  if (ocrWord.length >= 5 && word.length > ocrWord.length && word.startsWith(ocrWord)) return 0.6 + 0.3 * ocrWord.length / word.length;
  if (word.length < 4 || ocrWord.length < 4) return 0;
  const max = Math.floor(word.length / 4), d = lev(ocrWord, word, max);
  return d <= max ? 1 - d / word.length : 0;
}
let speciesWords = null, speciesKey = '';
function fuzzyDex(words) { // dex number -> how well a Pokémon name was read
  const key = NM && NM.names ? NM.t : '';
  if (speciesKey !== key) { speciesKey = key; speciesWords = Object.entries((NM && NM.names) || {}).map(([n, name]) => [+n, toks(name).split(' ').filter(x => x.length >= 3)]); }
  const out = new Map();
  for (const [n, ws] of speciesWords || []) {
    let s = 0;
    for (const w of ws) for (const o of words) { const v = wordLike(o, w); if (v > s) s = v; }
    if (s >= 0.6) out.set(n, s);
  }
  return out;
}

// ---- picture fingerprints: 16 x 22 colour pixels, brightness and contrast evened out per colour ----
const FP_FILE = path.join(DATA_DIR, 'fingerprints.bin');
const FP_LEN = 16 * 22 * 3;
const fps = new Map(); // card id -> {v: picture version, f: Int8Array}
(function loadFingerprints() {
  try {
    const b = fs.readFileSync(FP_FILE); let o = 0;
    if (b.toString('latin1', 0, 5) !== 'DXFP1') return;
    o = 5;
    while (o < b.length) {
      const il = b[o++]; const id = b.toString('utf8', o, o + il); o += il;
      const vl = b[o++]; const v = b.toString('utf8', o, o + vl); o += vl;
      fps.set(id, { v, f: new Int8Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + FP_LEN)) }); o += FP_LEN;
    }
  } catch (e) { /* none yet */ }
})();
function saveFingerprints() {
  const parts = [Buffer.from('DXFP1', 'latin1')];
  for (const [id, x] of fps) { const i = Buffer.from(id), v = Buffer.from(x.v); parts.push(Buffer.from([i.length]), i, Buffer.from([v.length]), v, Buffer.from(x.f.buffer, x.f.byteOffset, FP_LEN)); }
  const tmp = FP_FILE + '.tmp'; fs.writeFileSync(tmp, Buffer.concat(parts)); fs.renameSync(tmp, FP_FILE);
}
// inset: how much of the edge to leave out (the photo's straightened card has a little room around it)
async function fingerprint(buf, inset) {
  let img = sharp(buf);
  if (inset) { const m = await img.metadata(); const dx = Math.round(m.width * inset), dy = Math.round(m.height * inset); img = sharp(await img.extract({ left: dx, top: dy, width: m.width - 2 * dx, height: m.height - 2 * dy }).toBuffer()); }
  const px = await img.resize(16, 22, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const f = new Int8Array(FP_LEN);
  for (let c = 0; c < 3; c++) {
    let sum = 0, sq = 0; for (let i = c; i < FP_LEN; i += 3) { sum += px[i]; sq += px[i] * px[i]; }
    const n = FP_LEN / 3, mean = sum / n, sd = Math.sqrt(Math.max(1, sq / n - mean * mean));
    for (let i = c; i < FP_LEN; i += 3) f[i] = Math.max(-127, Math.min(127, Math.round((px[i] - mean) / sd * 40)));
  }
  return f;
}
function fpLike(a, b) { let s = 0; for (let i = 0; i < FP_LEN; i++) s += a[i] * b[i]; return s / (FP_LEN * 1600); } // about -1 .. 1
let fpBusy = false;
// Fingerprints for stored pictures that have none yet (runs at start and after each picture download round).
async function fillFingerprints() {
  if (fpBusy || !sharp) return;
  fpBusy = true;
  let n = 0;
  try {
    for (const [id, st] of Object.entries(imgs.c)) {
      const have = fps.get(id);
      if (have && have.v === st.v) continue;
      try { fps.set(id, { v: st.v, f: await fingerprint(fs.readFileSync(imgPath('c', id, 'low')), 0.03) }); n++; } catch (e) { /* picture missing */ }
      if (n % 200 === 0) { await new Promise(r => setImmediate(r)); if (n % 2000 === 0) saveFingerprints(); }
    }
    for (const id of fps.keys()) if (!imgs.c[id]) { fps.delete(id); n++; }
    if (n) { saveFingerprints(); log('scan fingerprints: ' + fps.size + ' pictures ready (' + n + ' new)'); }
  } finally { fpBusy = false; }
}
if (SCAN) setTimeout(() => { fillFingerprints().catch(e => log('fingerprints failed:', e.message)); }, 20000);

// ---- finding cards on the photo ----
function orderCorners(pts) { // top-left, top-right, bottom-right, bottom-left
  const s = pts.map(p => p.x + p.y), d = pts.map(p => p.x - p.y);
  return [pts[s.indexOf(Math.min(...s))], pts[d.indexOf(Math.max(...d))], pts[s.indexOf(Math.max(...s))], pts[d.indexOf(Math.min(...d))]];
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Rectangles with card proportions, grouped: a card, its inner picture panel and its sleeve are one group.
async function cardOutlines(rgba, W, H) {
  const { cv } = await cvReady();
  const mats = [];
  const keep = m => { mats.push(m); return m; };
  try {
    const src = keep(cv.matFromImageData({ data: rgba, width: W, height: H })), gray = keep(new cv.Mat()), edges = keep(new cv.Mat()), k = keep(cv.Mat.ones(5, 5, cv.CV_8U));
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 40, 120);
    cv.dilate(edges, edges, k);
    const contours = keep(new cv.MatVector()), hier = keep(new cv.Mat());
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const quads = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      if (cv.contourArea(c) < W * H * 0.015) { c.delete(); continue; }
      // the card's outline is often joined to lines in the artwork: take the outer hull, simplified to 4 corners
      const hull = new cv.Mat(); cv.convexHull(c, hull, false, true);
      let ap = new cv.Mat();
      for (const eps of [0.02, 0.03, 0.04, 0.05, 0.06]) { ap.delete(); ap = new cv.Mat(); cv.approxPolyDP(hull, ap, cv.arcLength(hull, true) * eps, true); if (ap.rows <= 4) break; }
      const area = cv.contourArea(hull);
      if (ap.rows === 4) {
        const pts = []; for (let j = 0; j < 4; j++) pts.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
        const [tl, tr, br, bl] = orderCorners(pts);
        const w = (dist(tl, tr) + dist(bl, br)) / 2, h = (dist(tl, bl) + dist(tr, br)) / 2, ratio = Math.min(w, h) / Math.max(w, h);
        if (ratio > 0.6 && ratio < 0.82 && area > W * H * 0.015) quads.push({ pts: [tl, tr, br, bl], area, landscape: w > h });
      }
      hull.delete(); ap.delete(); c.delete();
    }
    quads.sort((a, b) => b.area - a.area);
    const box = q => ({ x0: Math.min(...q.pts.map(p => p.x)), x1: Math.max(...q.pts.map(p => p.x)), y0: Math.min(...q.pts.map(p => p.y)), y1: Math.max(...q.pts.map(p => p.y)) });
    const within = (a, b) => { const p = box(a), o = box(b), m = 0.02 * Math.max(W, H); return p.x0 >= o.x0 - m && p.x1 <= o.x1 + m && p.y0 >= o.y0 - m && p.y1 <= o.y1 + m; };
    const groups = [];
    for (const q of quads) {
      const g = groups.find(gr => within(q, gr[0]) && q.area / gr[0].area > 0.35);
      if (g) { if (g.length < 3) g.push(q); } else if (!groups.some(gr => within(q, gr[0]))) groups.push([q]);
    }
    return groups.slice(0, MAX_CARDS);
  } finally { mats.forEach(m => { try { m.delete(); } catch (e) { /* gone */ } }); }
}
// The card inside four corners, straightened to CARD_W x CARD_H (with 4.5% room around it).
async function straighten(rgba, W, H, q, grow) {
  const { cv } = await cvReady();
  let p = q.pts; if (q.landscape) p = [p[3], p[0], p[1], p[2]]; // lying sideways: turn upright
  const cx = p.reduce((s, z) => s + z.x, 0) / 4, cy = p.reduce((s, z) => s + z.y, 0) / 4;
  p = p.map(z => ({ x: cx + (z.x - cx) * grow, y: cy + (z.y - cy) * grow }));
  const src = cv.matFromImageData({ data: rgba, width: W, height: H }), dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, p.flatMap(z => [z.x, z.y])), to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CARD_W, 0, CARD_W, CARD_H, 0, CARD_H]);
  const M = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(CARD_W, CARD_H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    return await sharp(Buffer.from(dst.data), { raw: { width: CARD_W, height: CARD_H, channels: 4 } }).removeAlpha().png().toBuffer();
  } finally { [src, dst, from, to, M].forEach(m => m.delete()); }
}

// ---- reading one straightened card ----
async function readArea(card, y0, y1, width) {
  const w = await ocrWorker();
  const img = await sharp(card).extract({ left: 0, top: Math.round(CARD_H * y0), width: CARD_W, height: Math.round(CARD_H * (y1 - y0)) })
    .resize({ width }).grayscale().normalize().sharpen().png().toBuffer();
  const r = await w.recognize(img, {}, { blocks: true });
  const lines = [];
  for (const b of r.data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).filter(x => x.confidence >= 30 && x.text.trim());
    if (words.length) lines.push({ text: words.map(x => x.text).join(' '), h: Math.max(...words.map(x => x.bbox.y1 - x.bbox.y0)) });
  }
  return lines;
}
async function readCard(card) {
  const top = await readArea(card, 0, 0.17, 2000), bottom = await readArea(card, 0.83, 1, 2500);
  // name words: from the tallest lines at the top, without "STAGE 1", "HP 120", "Evolves from ..." and the like
  const words = [];
  top.sort((a, b) => b.h - a.h).slice(0, 4).forEach(l => {
    if (/evolves\s+from/i.test(l.text)) return;
    toks(l.text).split(' ').forEach(x => { if (x.length >= 2 && !/^\d+$/.test(x) && !NAME_NOISE.has(x) && !words.includes(x)) words.push(x); });
  });
  let num = null;
  for (const l of bottom) { const r = readNumber(l.text); if (r && (!num || (r.num && r.total))) num = r; }
  if (!num) num = readNumber(bottom.map(l => l.text).join(' '));
  return { words, num, said: top.concat(bottom).map(l => l.text).join(' ').slice(0, 160) };
}

// ---- reading cards with an AI model (optional) ----
// SCAN_AI chooses the service: gemini, openai, claude, mistral, openrouter or local (Ollama, LM Studio,
// llama.cpp or any other server with an OpenAI-style /v1/chat/completions). SCAN_AI_KEY is the API key,
// SCAN_AI_MODEL the model (it must understand images), SCAN_AI_URL the address of a local server.
// The AI only reads what is printed on the card; finding the card in the database stays on this server.
const AI_DEFAULTS = {
  gemini: { model: 'gemini-flash-latest', url: 'https://generativelanguage.googleapis.com/v1beta' },
  openai: { model: 'gpt-5-mini', url: 'https://api.openai.com/v1' },
  claude: { model: 'claude-haiku-5-5', url: 'https://api.anthropic.com/v1' },
  mistral: { model: 'mistral-small-latest', url: 'https://api.mistral.ai/v1' },
  openrouter: { model: 'openrouter/auto', url: 'https://openrouter.ai/api/v1' },
  local: { model: 'llama3.2-vision', url: 'http://host.docker.internal:11434/v1' },
};
const AI_ALIASES = { gpt: 'openai', chatgpt: 'openai', anthropic: 'claude', google: 'gemini', ollama: 'local', llama: 'local', lmstudio: 'local' };
const AI_NAME = (() => { const v = String(process.env.SCAN_AI || '').trim().toLowerCase(); return AI_DEFAULTS[v] ? v : (AI_ALIASES[v] || null); })();
const AI = AI_NAME ? {
  name: AI_NAME,
  key: process.env.SCAN_AI_KEY || '',
  model: process.env.SCAN_AI_MODEL || AI_DEFAULTS[AI_NAME].model,
  url: String(process.env.SCAN_AI_URL || AI_DEFAULTS[AI_NAME].url || '').replace(/\/+$/, ''),
  timeout: (+process.env.SCAN_AI_TIMEOUT || 45) * 1000,
} : null;
if (AI) log('scanning: cards are read by ' + AI.name + ' (' + AI.model + ')' + (AI.key || AI.name === 'local' ? '' : ' - SCAN_AI_KEY is not set'));

const AI_FIELDS = '"name": the card name exactly as printed at the top, with suffixes like ex, V, VMAX, VSTAR or GX (for a Trainer or Energy card: its title); '
  + '"number": the collector number exactly as printed, usually small at the bottom left or bottom right, for example "201/198", "TG05/TG30", "GG09/GG70", "SWSH050" or "050", or null if you cannot read it; '
  + '"pokemon": the English name of the Pokémon on the card (translate it if the card is not in English), or null; '
  + '"language": the two-letter language code of the card text';
const AI_ONE = 'This is a photo of one Pokémon Trading Card Game card. It may be in a plastic sleeve, slightly blurry, shiny or upside down. '
  + 'Read what is printed on it. Reply with only one JSON object and nothing else: {' + AI_FIELDS + '}.';
const AI_MANY = 'This photo shows one or more Pokémon Trading Card Game cards. Some may be in sleeves, blurry, shiny or upside down. '
  + 'Read each card. Reply with only JSON and nothing else: {"cards": [ one object per card, from top left to bottom right, each {' + AI_FIELDS + '} ]}.';

function aiJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('the AI did not answer with JSON');
  return JSON.parse(t.slice(a, b + 1));
}
async function aiAsk(jpeg, prompt) {
  const b64 = jpeg.toString('base64'), dataUrl = 'data:image/jpeg;base64,' + b64;
  const opts = (headers, body) => ({ method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': 'dex-art-tracker' }, headers), body: JSON.stringify(body), signal: AbortSignal.timeout(AI.timeout) });
  let r, j;
  if (AI.name === 'gemini') {
    r = await fetch(AI.url + '/models/' + encodeURIComponent(AI.model) + ':generateContent', opts({ 'x-goog-api-key': AI.key },
      { contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }], generationConfig: { responseMimeType: 'application/json' } }));
    j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Gemini: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
    return ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('');
  }
  if (AI.name === 'claude') {
    r = await fetch(AI.url + '/messages', opts({ 'x-api-key': AI.key, 'anthropic-version': '2023-06-01' },
      { model: AI.model, max_tokens: 600, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }] }] }));
    j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Claude: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  }
  // OpenAI, OpenRouter, Mistral and local servers: the OpenAI-style chat completions request
  const image = AI.name === 'mistral' ? dataUrl : { url: dataUrl };
  const headers = AI.key ? { Authorization: 'Bearer ' + AI.key } : {};
  if (AI.name === 'openrouter') Object.assign(headers, { 'X-Title': 'Dex Art Tracker' });
  r = await fetch(AI.url + '/chat/completions', opts(headers, { model: AI.model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: image }] }] }));
  j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(AI.name + ': ' + ((j.error && (j.error.message || j.error)) || 'HTTP ' + r.status));
  const c = ((j.choices || [])[0] || {}).message || {};
  return Array.isArray(c.content) ? c.content.map(p => p.text || '').join('') : String(c.content || '');
}
// What the AI read, in the same shape as the built-in reader's result.
function aiRead(o) {
  if (!o || typeof o !== 'object') return null;
  const name = String(o.name || '').slice(0, 80), pokemon = String(o.pokemon || '').slice(0, 60);
  const words = [];
  toks(name).split(' ').concat(toks(pokemon).split(' ')).forEach(x => { if (x.length >= 2 && !/^\d+$/.test(x) && !NAME_NOISE.has(x) && !words.includes(x)) words.push(x); });
  const raw = o.number == null ? '' : String(o.number).trim().slice(0, 30);
  let num = raw ? readNumber(raw) : null;
  if (!num && /^[A-Za-z]{0,5}-?\d{1,3}[a-z]?$/.test(raw)) num = { num: normNum(raw), total: null, text: raw }; // "050", "SWSH050"
  if (!words.length && !num) return null;
  return { words, num, ai: true, said: [name, raw].filter(Boolean).join(' · ') };
}
async function aiReadCard(card) { // one straightened card
  const jpeg = await sharp(card).resize({ width: 768 }).jpeg({ quality: 88 }).toBuffer();
  return aiRead(aiJson(await aiAsk(jpeg, AI_ONE)));
}
async function aiReadPhoto(buf) { // a whole photo, when no card outline was found
  const jpeg = await (await checkedImage(buf)).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const j = aiJson(await aiAsk(jpeg, AI_MANY));
  return (Array.isArray(j.cards) ? j.cards : [j]).slice(0, MAX_CARDS).map(aiRead).filter(Boolean);
}

// ---- matching ----
function cardInfo(c, s, sid) {
  const rec = db.cards[c.id], art = rec ? !rec.x : worth(s, c);
  const d = (rec && !rec.x && rec.d && rec.d.length) ? rec.d : (c.d || []);
  return { c, s, sid, rec, art, d, name: rec && !rec.x ? rec.n : c.n };
}
function scoreText(x, read, dex) {
  const num = read.num;
  const numHit = !!(num && num.num) && normNum(x.c.l) === num.num;
  const totHit = !!(num && num.total) && (x.s.official === num.total || x.s.total === num.total) && (numHit || !num.num);
  const ct = toks(x.name).split(' ').filter(w => w.length >= 2);
  let nameHit = 0;
  if (ct.length && read.words.length) {
    nameHit = ct.map(w => Math.max(0, ...read.words.map(o => wordLike(o, w)))).reduce((a, b) => a + b, 0) / ct.length;
    if (nameHit) for (const k of NAME_KINDS) if (read.words.includes(k) !== ct.includes(k)) nameHit -= 0.25; // "Pikachu ex" is not "Pikachu"
  }
  const dexHit = Math.max(0, ...x.d.map(n => dex.get(n) || 0));
  return { numHit, totHit, nameHit: Math.max(0, nameHit), dexHit, text: (numHit ? 4 : 0) + (totHit ? 2 : 0) + Math.max(0, nameHit) * 3 + dexHit * 1.5 };
}
// card: the straightened card (null when only text is known); given: what the AI read (else the built-in reader reads)
async function matchCard(card, given) {
  const read = given || await readCard(card);
  const dex = fuzzyDex(read.words);
  // the photo's fingerprint, at three sizes: the straightened area may be the card, its inner panel or its sleeve
  const prints = [];
  if (card) for (const inset of [0.023, 0, 0.045]) prints.push(await fingerprint(card, inset));
  const picSim = id => { const st = fps.get(id); return st && prints.length ? Math.max(...prints.map(p => fpLike(p, st.f))) : null; };
  const pool = new Map();
  // cards whose picture looks most alike
  const byPic = [];
  if (prints.length) for (const [id, st] of fps) { const v = Math.max(...prints.map(p => fpLike(p, st.f))); byPic.push([id, v]); }
  byPic.sort((a, b) => b[1] - a[1]);
  const picIds = new Set(byPic.slice(0, 40).map(x => x[0]));
  // cards whose text fits
  for (const [sid, s] of Object.entries(db.sets)) {
    if (!s.scan) continue;
    for (const c of s.cards) {
      const x = cardInfo(c, s, sid);
      if (!x.art && !x.d.length) continue; // only cards the page shows
      const t = scoreText(x, read, dex);
      if (t.text >= 1.5 || picIds.has(c.id)) pool.set(c.id, Object.assign(x, t));
    }
  }
  const list = [...pool.values()].sort((a, b) => b.text - a.text).slice(0, 80);
  for (const id of picIds) if (!list.some(x => x.c.id === id) && pool.has(id)) list.push(pool.get(id));
  for (const x of list) {
    x.pic = picSim(x.c.id);
    // a picture that looks alike counts strongly (up to 8 points); unrelated pictures sit around 0.2-0.4
    x.score = x.text + (x.pic != null ? Math.max(0, x.pic - 0.45) * 15 : 0);
  }
  list.sort((a, b) => b.score - a.score || String(b.s.date).localeCompare(String(a.s.date)));
  return { read, list, best: list.length ? list[0].score : 0, second: list.length > 1 ? list[1].score : 0 };
}
function matchOut(x, best, second) {
  return picOf(x.c.id, {
    id: x.c.id, n: x.name, sid: x.sid, set: x.s.name, k: x.c.l, r: x.rec && !x.rec.x ? x.rec.r : null, a: x.art ? 1 : 0, tr: x.rec && x.rec.tr ? 1 : undefined, d: x.d,
    b: (x.rec && !x.rec.x && x.rec.b) || cleanBase(x.c.i), eu: x.rec && !x.rec.x ? x.rec.eu : x.c.eu, us: x.rec && !x.rec.x ? x.rec.us : x.c.us, pt: x.rec && !x.rec.x ? x.rec.pt : x.c.pt,
    why: [x.numHit ? 'number' : null, x.totHit ? 'set size' : null, x.nameHit >= 0.6 ? 'name' : (x.dexHit >= 0.6 ? 'pokémon' : null), x.pic != null && x.pic > 0.7 ? 'picture' : null].filter(Boolean),
    sure: x.score >= best - 0.01 && x.score >= 7 && best - second >= 2 ? 1 : 0,
  });
}
const useful = m => m.list.length && (m.list[0].numHit || m.list[0].nameHit >= 0.6 || m.list[0].dexHit >= 0.6 || (m.list[0].pic != null && m.list[0].pic > 0.6));
async function scanPhoto(buf) {
  const base = await checkedImage(buf);
  // find the cards on a 1400 px copy; straighten them from a sharper copy
  const small = await base.clone().resize(1400, 1400, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const big = await base.clone().resize(2600, 2600, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const k = big.info.width / small.info.width, bigData = new Uint8ClampedArray(big.data);
  const scaleQ = q => ({ landscape: q.landscape, pts: q.pts.map(p => ({ x: p.x * k, y: p.y * k })) });
  let t0 = Date.now();
  let groups = await cardOutlines(new Uint8ClampedArray(small.data), small.info.width, small.info.height);
  slog('outlines:', groups.length, 'groups', groups.map(g => g.length).join(','), Date.now() - t0, 'ms');
  const found = [];
  if (!groups.length) { // no outline found: the middle of the photo, card-shaped (as framed by the camera guide)
    const W = big.info.width, H = big.info.height, h = Math.min(H, W / 0.716) * 0.92, w = h * 0.716;
    groups = [[{ landscape: false, pts: [{ x: (W - w) / 2, y: (H - h) / 2 }, { x: (W + w) / 2, y: (H - h) / 2 }, { x: (W + w) / 2, y: (H + h) / 2 }, { x: (W - w) / 2, y: (H + h) / 2 }], scaled: true }]];
  }
  let aiProblem = null, aiUsed = false;
  if (AI && groups[0] && groups[0][0].scaled) { // no outline found: the AI looks at the whole photo
    try {
      const reads = await aiReadPhoto(buf); aiUsed = true;
      slog('AI read the photo:', JSON.stringify(reads.map(x => x.said)));
      for (const read of reads) { const m = await matchCard(null, read); if (useful(m)) found.push(m); }
      if (found.length) groups = [];
    } catch (e) { aiProblem = e.message; log('AI reader failed:', e.message); }
  }
  for (const g of groups) {
    let best = null;
    if (AI && !aiProblem && !g[0].scaled) {
      try {
        const card = await straighten(bigData, big.info.width, big.info.height, scaleQ(g[0]), 1.045);
        t0 = Date.now();
        const read = await aiReadCard(card); aiUsed = true;
        slog('AI read', read ? read.said : '-', Date.now() - t0, 'ms');
        if (read) { best = await matchCard(card, read); best.card = card; }
      } catch (e) { aiProblem = e.message; log('AI reader failed:', e.message); }
    }
    if (!best || !useful(best)) for (const q of g) { // the card, its inner panel or its sleeve: keep whichever reads best
      const qq = q.scaled ? q : scaleQ(q);
      for (const turn of [0, 180]) {
        let card = await straighten(bigData, big.info.width, big.info.height, qq, 1.045);
        if (turn) card = await sharp(card).rotate(180).png().toBuffer();
        t0 = Date.now();
        const m = await matchCard(card); m.card = card;
        slog('read', JSON.stringify(m.read.words.slice(0, 6)), m.read.num ? m.read.num.text : '-', '| best', m.list[0] ? m.list[0].c.id + ' ' + m.best.toFixed(1) + ' pic ' + (m.list[0].pic != null ? m.list[0].pic.toFixed(2) : '-') : '-', '|', Date.now() - t0, 'ms');
        if (!best || m.best > best.best) best = m;
        if (useful(m) && m.best >= 7) break;
      }
      if (best && useful(best) && best.best >= 7) break;
    }
    if (best && useful(best)) found.push(best);
  }
  // a small picture of each card as it was found on the photo, for checking the scan afterwards
  for (const f of found) f.thumb = f.card ? 'data:image/jpeg;base64,' + (await sharp(f.card).resize({ width: 180 }).jpeg({ quality: 72 }).toBuffer()).toString('base64') : null;
  return {
    cards: found.map(f => ({
      read: { name: f.read.words.filter(w => w.length >= 3).slice(0, 4).join(' ') || null, number: f.read.num ? f.read.num.text : null },
      matches: f.list.slice(0, 8).map(x => matchOut(x, f.best, f.second)),
      thumb: f.thumb,
    })),
    text: found.length ? '' : 'no card outline or readable text',
    reader: aiUsed && !aiProblem ? 'ai' : 'built-in',
    aiProblem: aiProblem ? aiProblem.slice(0, 160) : undefined,
  };
}
async function runScan(buf) {
  ocrWaiting++;
  const job = ocrChain.catch(() => {}).then(() => scanPhoto(buf));
  ocrChain = job;
  try { return await job; } finally { ocrWaiting--; ocrRelease(); }
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
  if (db.matchV !== 2) { db.regMatched = null; for (const st of Object.values(db.sets)) for (const c of st.cards || []) delete c.sp; db.matchV = 2; }
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
    await refreshJaNames();
    if (!db.logosDone && canSpend()) { // one request: fetch set pictures for sets stored by an older version
      const list = await paced('/sets');
      if (Array.isArray(list)) { applyLogos(list); db.logosDone = true; persist(true); }
    }
    if ((bootCheck || !db.setsChecked || ageDays(db.setsChecked) >= SETS_CHECK_DAYS || LANGS.some(l => !db.langsDone[l])) && canSpend()) { bootCheck = false; await syncSets(); }
    for (const lang of LANGS) {
      if (db.langsDone[lang] && (!db.rar[lang] || db.rar[lang].v !== 5 || ageDays(db.rar[lang].t) >= SETS_CHECK_DAYS) && canSpend()) await rarityScan(lang);
    }
    await backfill();
    if (!db.initialDone && db.setsChecked && LANGS.every(l => db.rar[l]) && pendingCards().length === 0) {
      db.initialDone = true; unlimited = false;
      log('first build of the database finished');
    }
    if (db.initialDone) await refreshPrices(PRICE_MAX_AGE_DAYS);
    if (db.initialDone && !unlimited) await fillPictures();
    if (db.initialDone && !unlimited) await fillImages();
    if (SCAN) await fillFingerprints();
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
    picsDue: PICTURE_LOOKUP ? picsNeeded().length : 0,
    imgsStored: Object.keys(imgs.c).length, imgsDue: IMAGE_CACHE && sharp ? imageTargets().length : 0,
    setsChecked: db.setsChecked, initialDone: db.initialDone,
    requestsToday: db.budget.used, dailyRequests: DAILY_REQUESTS,
  };
}

// ---------- accounts and login ----------
// Every account (trainer) has its own dex. The main account is the admin: its password is ADMIN_PASSWORD
// (or the generated one in admin.json) and its ticks stay in state.json. The admin creates the other
// accounts; their ticks are stored in states/<id>.json. A login only opens the dex it was made on.
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
const STATES_DIR = path.join(DATA_DIR, 'states');
const MAIN = 'main';
fs.mkdirSync(STATES_DIR, { recursive: true });
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// The main admin's password: ADMIN_PASSWORD if set (then it can only be changed there). Otherwise admin.json:
// first a generated password in plain text, and once changed on the page a salted hash ({salt, hash}).
const ADMIN_FIXED = !!process.env.ADMIN_PASSWORD;
let adminPw = String(process.env.ADMIN_PASSWORD || ''), adminHash = null;
if (ADMIN_FIXED) log('owner password: set by ADMIN_PASSWORD');
else {
  const a = readJSON(ADMIN_FILE) || {};
  if (a.hash && a.salt) { adminHash = { salt: a.salt, hash: a.hash }; log('owner password: changed on the page (stored hashed in admin.json)'); }
  else {
    adminPw = a.password || '';
    if (!adminPw) { adminPw = crypto.randomBytes(9).toString('base64url'); writeJSON(ADMIN_FILE, { password: adminPw }); }
    log('OWNER PASSWORD (generated; also saved in admin.json in the data folder; set ADMIN_PASSWORD to choose your own):', adminPw);
  }
}
const accounts = readJSON(ACC_FILE) || {};
accounts.list = Array.isArray(accounts.list) ? accounts.list : [];
if (!accounts.list.some(a => a.id === MAIN)) accounts.list.unshift({ id: MAIN, name: 'Owner', created: new Date().toISOString() });
function saveAccounts() { writeJSON(ACC_FILE, accounts); }
saveAccounts();
const accById = id => accounts.list.find(a => a.id === String(id || '')) || null;
const publicAccounts = () => accounts.list.map(a => ({ id: a.id, name: a.name }));
const stateFile = id => id === MAIN ? STATE_FILE : path.join(STATES_DIR, id + '.json');
function allStates() {
  return accounts.list.map(a => { const s = readJSON(stateFile(a.id)) || {}; return { own: s.own || {}, cards: s.cards || {}, pick: s.pick || {}, wish: s.wish || {} }; });
}
// History: every card that becomes ticked is added at the top, with its name and set kept so the entry
// still reads well if the card leaves the database. A save that adds more than 50 cards at once (a backup
// being restored) is not recorded. At most 300 entries are kept.
const HIST_MAX = 300;
function addHistory(old, own, cards) {
  const hist = Array.isArray(old.hist) ? old.hist : [];
  const oc = old.cards || {}, oo = old.own || {};
  const newCards = Object.keys(cards).filter(id => cards[id] && !oc[id]);
  const newAny = Object.keys(own || {}).filter(n => own[n] && own[n].any && !(oo[n] && oo[n].any));
  if (!newCards.length && !newAny.length) return hist;
  if (newCards.length + newAny.length > 50) return hist;
  const t = new Date().toISOString(), idx = regIndex(), add = [];
  for (const id of newCards) {
    const rec = db.cards[id], reg = idx.get(id);
    const sid = (rec && !rec.x && rec.sid) || id.slice(0, id.lastIndexOf('-'));
    add.push({ id, t, n: (rec && !rec.x && rec.n) || (reg && reg.n) || id, sid, k: localOf(id, sid) });
  }
  for (const n of newAny) add.push({ dex: +n, t });
  // A card ticked again moves to the top instead of appearing twice.
  return add.concat(hist.filter(h => !(h.id ? newCards.includes(h.id) : newAny.includes(String(h.dex))))).slice(0, HIST_MAX);
}
// A wish list: the main picture you picked for a Pokémon (pick) plus cards wished for without one (wish,
// for example trainer cards), leaving out cards you already own.
function wishOf(s) {
  const cards = s.cards || {}, pick = s.pick || {}, extra = s.wish || {}, out = [];
  Object.keys(pick).forEach(n => { if (pick[n] && !cards[pick[n]]) out.push({ dex: +n, id: String(pick[n]) }); });
  Object.keys(extra).forEach(id => { if (extra[id] && !cards[id] && !out.some(w => w.id === id)) out.push({ dex: null, id }); });
  return out;
}
function tradeData() {
  return accounts.list.map(a => {
    const s = readJSON(stateFile(a.id)) || {}, cards = s.cards || {};
    return { id: a.id, name: a.name, cards: Object.keys(cards).filter(id => cards[id]), wish: wishOf(s) };
  });
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32);
function checkPw(acc, pw) {
  if (acc.id === MAIN) {
    if (adminHash) return crypto.timingSafeEqual(hashPw(pw, adminHash.salt), Buffer.from(adminHash.hash, 'hex'));
    return sameText(pw, adminPw);
  }
  if (!acc.hash || !acc.salt) return false;
  return crypto.timingSafeEqual(hashPw(pw, acc.salt), Buffer.from(acc.hash, 'hex'));
}
function setPw(acc, pw) {
  const salt = crypto.randomBytes(16).toString('hex'), hash = hashPw(pw, salt).toString('hex');
  if (acc.id === MAIN) { adminHash = { salt, hash }; adminPw = ''; writeJSON(ADMIN_FILE, adminHash); return; }
  acc.salt = salt; acc.hash = hash;
}
const newPw = () => crypto.randomBytes(9).toString('base64url');
// Trainer names: 1-30 characters, no control characters, unique (ignoring upper/lower case).
function cleanName(n, selfId) {
  const v = String(n || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!v) throw new Error('Enter a trainer name');
  if (accounts.list.some(a => a.id !== selfId && a.name.toLowerCase() === v.toLowerCase())) throw new Error('That trainer name is already taken');
  return v;
}

const sessions = readJSON(SESS_FILE) || {}; // sha256(token) -> {exp, acc}
for (const k of Object.keys(sessions)) if (typeof sessions[k] === 'number') sessions[k] = { exp: sessions[k], acc: MAIN }; // older logins belong to the main account
const SESSION_MS = 30 * 86400000;
function saveSessions() { const n = Date.now(); Object.keys(sessions).forEach(k => { if (sessions[k].exp < n) delete sessions[k]; }); writeJSON(SESS_FILE, sessions); }
function dropSessions(acc) { Object.keys(sessions).forEach(k => { if (sessions[k].acc === acc) delete sessions[k]; }); saveSessions(); }
const tokenOf = req => { const m = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('dex_session=')); return m ? m.slice(12) : ''; };
const hashTok = t => crypto.createHash('sha256').update(t).digest('hex');
function sessionOf(req) {
  const t = tokenOf(req); if (!t) return null;
  const s = sessions[hashTok(t)];
  return s && s.exp > Date.now() && accById(s.acc) ? s : null;
}
// Behind a reverse proxy the visitor's address is the one the proxy adds at the END of X-Forwarded-For:
// anything before it was sent by the visitor and can be made up (which would get around the
// wrong-password limit). PROXY_HOPS = number of proxies in a row in front of this server (default 1).
const PROXY_HOPS = Math.max(1, +process.env.PROXY_HOPS || 1);
function fromProxy(v) { const l = String(v || '').split(',').map(x => x.trim()).filter(Boolean); return l.length >= PROXY_HOPS ? l[l.length - PROXY_HOPS] : ''; }
function clientIp(req) { const f = TRUST_PROXY && fromProxy(req.headers['x-forwarded-for']); return f || req.socket.remoteAddress || ''; }
const isHttps = req => TRUST_PROXY && fromProxy(req.headers['x-forwarded-proto']) === 'https';
const cookie = (req, v, age) => 'dex_session=' + v + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + age + (isHttps(req) ? '; Secure' : '');
const fails = new Map(); // ip -> {n, t}: wrong passwords
const blocked = ip => { const f = fails.get(ip); return !!f && Date.now() - f.t < 15 * 60000 && f.n >= 8; };
const hits = new Map();
const limited = ip => { const n = Date.now(), h = hits.get(ip); if (!h || n - h.t > 60000) { hits.set(ip, { t: n, n: 1 }); return false; } return ++h.n > 600; };

// mode: 'full' (logged in), 'ro' (view only, with a login link), 'view' (view only, no login link: the main dex on /view/)
function indexHtml(mode, dexId, sess) {
  let h = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const hide = 'window.DEX_HIDE_VALUE=' + (!SHOW_VALUE_PUBLIC) + ';';
  const me = sess ? accById(sess.acc) : null;
  const cfg = { dex: dexId, accounts: publicAccounts(), me: me ? { id: me.id, name: me.name, admin: me.id === MAIN } : null };
  const inj = 'window.DEX_CUR=' + JSON.stringify(PRICE_CUR) + ';' + (mode === 'full' ? 'window.DEX_AUTH=true;' : 'window.DEX_READONLY=true;' + hide + (mode === 'ro' ? 'window.DEX_LOGIN=true;' : ''))
    + 'window.DEX_CFG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';';
  return h.replace('<!--DEX_MODE-->', '<script>' + inj + '</script>');
}

// ---------- HTTP ----------
const APP_FILES = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json', 'no-cache'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png', 'public, max-age=604800'],
  '/icons/maskable-512.png': ['icons/maskable-512.png', 'image/png', 'public, max-age=604800'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png', 'public, max-age=604800'],
  '/favicon.ico': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
};
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
  let p = u.pathname, viewPath = false;
  try {
    // /view/ is the same page, but the main admin can never log in or use a login there: only the other
    // trainers can. Publishing only /view/ keeps the admin login unreachable from outside.
    if (p === '/view') { res.writeHead(301, { Location: '/view/' + u.search }); return res.end(); }
    if (p.startsWith('/view/')) { p = p.slice(5); viewPath = true; }
    // Stored pictures: /img/c/<card id>/<low|high> and /img/s/<set id>. Looked up in the index, never by path.
    if (req.method === 'GET' && p.startsWith('/img/')) {
      const m = /^\/img\/(c|s)\/([^/]{1,200})(?:\/(low|high))?$/.exec(p);
      let id = null; try { id = m && decodeURIComponent(m[2]); } catch (e) { id = null; }
      const rec = id && (m[1] === 'c' ? imgs.c[id] : imgs.s[id]);
      if (!rec || !Object.prototype.hasOwnProperty.call(m[1] === 'c' ? imgs.c : imgs.s, id)) { res.writeHead(404); return res.end('Not found'); }
      return sendImage(res, m[1] === 'c' ? imgPath('c', id, m[3] === 'high' && rec.h ? 'high' : 'low') : imgPath('s', id));
    }
    // App files for installing the page as an app (fixed list, read from the public folder).
    if (req.method === 'GET' && APP_FILES[p]) {
      const [file, type, cache] = APP_FILES[p];
      return fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
        res.end(buf);
      });
    }
    let sess = sessionOf(req);
    if (viewPath && sess && sess.acc === MAIN) sess = null; // an admin login counts as a visitor on /view/
    const authed = !!sess, isAdmin = !!sess && sess.acc === MAIN;
    const ip = clientIp(req);
    if (!authed && limited(ip)) { res.writeHead(429); return res.end('Slow down'); }
    // Which dex is looked at: ?dex=<account id>, else your own one when logged in, else the main one.
    const dexQ = u.searchParams.get('dex');
    const dexId = accById(dexQ) ? dexQ : (sess ? sess.acc : MAIN);
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' });
      return res.end(indexHtml(sess && sess.acc === dexId ? 'full' : (viewPath && dexId === MAIN ? 'view' : 'ro'), dexId, sess));
    }
    if (req.method === 'GET' && p === '/api/accounts') return sendJSON(res, 200, publicAccounts());
    // Every dex's owned cards and wish list, for the trade matches.
    if (req.method === 'GET' && p === '/api/trades') return sendJSON(res, 200, tradeData());
    if (req.method === 'GET' && p === '/data/cards.json') return sendCompressed(req, res, CARDS_FILE);
    if (req.method === 'GET' && p === '/data/names.json') return sendFile(res, NAMES_FILE);
    if (req.method === 'GET' && p === '/api/status') return sendJSON(res, 200, authed ? status() : { count: lastExport.art, regular: lastExport.regular, running: false, backlog: 0, pricesDue: 0, sets: { scanned: lastExport.sets } });
    if (req.method === 'GET' && p === '/api/set') {
      const s = setPayload(u.searchParams.get('id') || '');
      return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: 'unknown set' });
    }
    if (req.method === 'GET' && p === '/api/state') return sendJSON(res, 200, readJSON(stateFile(dexId)) || {});
    if (req.method === 'GET' && p === '/api/admin/accounts') {
      if (!isAdmin) return sendJSON(res, authed ? 403 : 401, { error: 'Only the main admin can do that' });
      return sendJSON(res, 200, accounts.list.map(a => ({ id: a.id, name: a.name, created: a.created, main: a.id === MAIN })));
    }
    if (req.method === 'GET' && p === '/api/lang-check') {
      if (!isAdmin) return sendJSON(res, 401, { error: 'login as the main admin required' });
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
      if (blocked(ip)) return sendJSON(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
      const b = JSON.parse(await readBody(req, 1e4));
      const acc = accById(b.dex || MAIN);
      if (!acc || (viewPath && acc.id === MAIN)) return sendJSON(res, 404, { error: 'That dex does not exist' });
      if (!checkPw(acc, String(b.password || ''))) {
        const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 15 * 60000 ? { n: f.n + 1, t: Date.now() } : { n: 1, t: Date.now() });
        await sleep(1000);
        return sendJSON(res, 401, { error: 'Wrong password' });
      }
      fails.delete(ip);
      const tok = crypto.randomBytes(24).toString('base64url');
      sessions[hashTok(tok)] = { exp: Date.now() + SESSION_MS, acc: acc.id }; saveSessions();
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
      if (dexQ && dexQ !== sess.acc) return sendJSON(res, 403, { error: 'You can only change your own dex' });
      const s = JSON.parse(await readBody(req, 5e6));
      if (!s || typeof s.own !== 'object' || Array.isArray(s.own)) return sendJSON(res, 400, { error: 'bad state' });
      const cards = s.cards && typeof s.cards === 'object' && !Array.isArray(s.cards) ? s.cards : {};
      const old = readJSON(stateFile(sess.acc)) || {};
      const hist = addHistory(old, s.own, cards);
      const wish = s.wish && typeof s.wish === 'object' && !Array.isArray(s.wish) ? s.wish : {};
      writeJSON(stateFile(sess.acc), { own: s.own, cards, pick: s.pick || {}, wish, cur: PRICE_CUR, hist });
      return sendJSON(res, 200, { ok: true, hist });
    }
    // Every account owner can change their own trainer name.
    if (req.method === 'POST' && p === '/api/account/name') {
      const b = JSON.parse(await readBody(req, 1e4));
      const acc = accById(sess.acc);
      acc.name = cleanName(b.name, acc.id); saveAccounts();
      return sendJSON(res, 200, { ok: true, name: acc.name });
    }
    // Every account owner can change their own password (the old one is asked first).
    // Other devices logged in to this dex are logged out; this one stays logged in.
    if (req.method === 'POST' && p === '/api/account/password') {
      const b = JSON.parse(await readBody(req, 1e4));
      const acc = accById(sess.acc);
      if (acc.id === MAIN && ADMIN_FIXED) return sendJSON(res, 409, { error: 'This password is set with ADMIN_PASSWORD in docker-compose.yml. Change it there.' });
      if (blocked(ip)) return sendJSON(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
      if (!checkPw(acc, String(b.old || ''))) {
        const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 15 * 60000 ? { n: f.n + 1, t: Date.now() } : { n: 1, t: Date.now() });
        await sleep(1000);
        return sendJSON(res, 401, { error: 'The current password is wrong' });
      }
      const pw = String(b.password || '');
      if (pw.length < 8) return sendJSON(res, 400, { error: 'A password needs at least 8 characters' });
      setPw(acc, pw); saveAccounts();
      const mine = hashTok(tokenOf(req));
      Object.keys(sessions).forEach(k => { if (sessions[k].acc === acc.id && k !== mine) delete sessions[k]; }); saveSessions();
      log('password changed:', acc.name);
      return sendJSON(res, 200, { ok: true });
    }
    // The main admin creates accounts, gives them a new password and deletes them.
    if (req.method === 'POST' && p.startsWith('/api/admin/')) {
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the main admin can do that' });
      const b = JSON.parse(await readBody(req, 1e4));
      const givenPw = String(b.password || '');
      if (givenPw && givenPw.length < 8) return sendJSON(res, 400, { error: 'A password needs at least 8 characters' });
      if (p === '/api/admin/accounts') {
        const acc = { id: crypto.randomBytes(6).toString('hex'), name: cleanName(b.name), created: new Date().toISOString() };
        const pw = givenPw || newPw();
        setPw(acc, pw);
        accounts.list.push(acc); saveAccounts();
        log('account created:', acc.name);
        return sendJSON(res, 200, { ok: true, id: acc.id, name: acc.name, password: pw });
      }
      const acc = accById(b.id);
      if (!acc) return sendJSON(res, 404, { error: 'Unknown account' });
      if (acc.id === MAIN) return sendJSON(res, 400, { error: 'The main account uses ADMIN_PASSWORD (or admin.json)' });
      if (p === '/api/admin/accounts/password') {
        const pw = givenPw || newPw();
        setPw(acc, pw); saveAccounts(); dropSessions(acc.id);
        return sendJSON(res, 200, { ok: true, password: pw });
      }
      if (p === '/api/admin/accounts/delete') {
        accounts.list = accounts.list.filter(a => a.id !== acc.id); saveAccounts(); dropSessions(acc.id);
        try { fs.renameSync(stateFile(acc.id), path.join(STATES_DIR, acc.id + '.deleted-' + Date.now() + '.json')); } catch (e) { /* no ticks yet */ }
        log('account deleted:', acc.name);
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 404, { error: 'not found' });
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
    // Fetch one card's details and price right now (the owner's button on a card without a price).
    if (req.method === 'POST' && p === '/api/card/fetch') {
      if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'The server is set to not contact the card service' });
      const b = JSON.parse(await readBody(req, 1e4));
      const id = String(b.id || '');
      const idx = regIndex(), c = idx.get(id), rec = db.cards[id];
      const s = db.sets[id.slice(0, id.lastIndexOf('-'))];
      if (!c && !(rec && !rec.x)) return sendJSON(res, 404, { error: 'unknown card' });
      const isArt = (rec && !rec.x) || (c && s && !rec && worth(s, c));
      if (isArt) await fetchCard(id, true); else await priceRegular(id, idx, true);
      persist(true);
      const now = db.cards[id];
      return sendJSON(res, 200, { ok: true, notArt: !!(isArt && !(now && !now.x)), art: !!(now && !now.x), price: now && !now.x ? { eu: now.eu, us: now.us } : (c ? { eu: c.eu, us: c.us } : null) });
    }
    // Scan cards: a photo (base64 JPEG/PNG/WebP, up to 6 MB) with one or more cards in, for every card found the
    // best matching cards out. Logged-in only, one scan at a time.
    if (req.method === 'POST' && p === '/api/scan') {
      if (!SCAN || !sharp) return sendJSON(res, 409, { error: 'Scanning is not available on this server' });
      if (ocrWaiting >= 3) return sendJSON(res, 429, { error: 'The scanner is busy. Try again in a moment.' });
      const b = JSON.parse(await readBody(req, 9e6));
      const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
      if (!m) return sendJSON(res, 400, { error: 'No photo received' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 6 * 1024 * 1024) return sendJSON(res, 400, { error: 'The photo is too large' });
      try { return sendJSON(res, 200, await runScan(buf)); }
      catch (e) { log('scan failed:', e.message); return sendJSON(res, 400, { error: /tesseract|Cannot find module/i.test(e.message) ? 'Scanning is not installed on this server (rebuild the container)' : 'Could not read that photo: ' + e.message }); }
    }
    // Set a card's picture by hand (main admin): a picture address, or empty to go back to automatic.
    if (req.method === 'POST' && p === '/api/card/picture') {
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the main admin can change pictures' });
      const b = JSON.parse(await readBody(req, 22e6)); // an uploaded picture (up to 15 MB) arrives as base64 text
      const id = String(b.id || ''), url = String(b.url || '').trim(), data = typeof b.data === 'string' ? b.data : '';
      if (!regIndex().has(id) && !(db.cards[id] && !db.cards[id].x)) return sendJSON(res, 404, { error: 'unknown card' });
      if (!url && !data) { // back to the automatic picture
        delete db.pics[id]; dropCard(id); persist(true);
        return sendJSON(res, 200, { ok: true });
      }
      if (!sharp) return sendJSON(res, 409, { error: 'Picture processing is not available on this server (rebuild the container so sharp is installed)' });
      let buf;
      if (data) {
        const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(data);
        if (!m) return sendJSON(res, 400, { error: 'That file could not be read as a picture' });
        buf = Buffer.from(m[1], 'base64');
        if (buf.length > MAX_IMAGE_BYTES) return sendJSON(res, 400, { error: 'The picture is larger than 15 MB' });
      } else {
        if (!/^https:\/\//i.test(url) || url.length > 2000) return sendJSON(res, 400, { error: 'Paste a picture address that starts with https://' });
        try { buf = await fetchImage(url, true); }
        catch (e) { return sendJSON(res, 400, { error: 'Could not download that picture: ' + e.message }); }
      }
      let out;
      try { out = await makeCardImages(buf, true); }
      catch (e) { return sendJSON(res, 400, { error: 'That is not a picture that can be used: ' + e.message }); }
      storeCard(id, out, 'custom'); saveImgs(true);
      db.pics[id] = { m: 1, src: data ? 'upload' : url, t: new Date().toISOString() };
      persist(true);
      return sendJSON(res, 200, { ok: true, high: !!out.high });
    }
    if (req.method === 'POST' && p === '/api/card/mark') {
      // The art list is shared by every dex, so only the main admin changes it.
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the main admin can change the art list' });
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
