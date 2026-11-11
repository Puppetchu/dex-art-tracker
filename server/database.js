'use strict';
// Dex Art Tracker server, part 4 of 9: building and updating the database, price history, prices of regular cards.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
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
    if (!have && isPocket(s.id)) { setsChanged(); db.sets[key] = { name: s.name, date: '', official: 0, total: 0, scan: false, pocket: true, promo: false, lang, cards: [] }; continue; }
    // Sets that can still grow (promo sets, sets released in the last 180 days) are read again once a day.
    const grows = have && have.scan && (have.promo || ageDays(have.date) < 180) && !(db.reread && db.reread[key] === todayStr());
    if (have && !grows && (have.scan || have.pocket || String(have.date || '') < MIN_SET_DATE)) continue;
    if (!canSpend()) { persist(true); return false; }
    const d = await paced('/sets/' + encodeURIComponent(s.id), lang);
    if (!d) { setsChanged(); db.sets[key] = { name: s.name, date: '', official: 0, total: 0, scan: false, promo: false, lang, cards: [] }; continue; }
    const date = d.releaseDate || '';
    const pocket = isPocket(s.id) || (d.serie && d.serie.id === 'tcgp');
    const scan = !pocket && date >= MIN_SET_DATE;
    const oldCards = new Map(((have && have.cards) || []).map(c => [c.id, c]));
    setsChanged();
    db.sets[key] = {
      name: d.name, date, scan, pocket: !!pocket, promo: lang === 'en' && /promo/i.test(d.name || ''), lang,
      lg: s.logo || d.logo || null, sy: s.symbol || d.symbol || null,
      official: (d.cardCount && d.cardCount.official) || 0,
      total: (d.cardCount && d.cardCount.total) || 0,
      cards: scan ? (d.cards || []).map(c => {
        const o = oldCards.get(p + c.id), n = { id: p + c.id, l: String(c.localId), n: c.name, i: c.image || (o && o.i) || null };
        if (o && o.pt) { n.eu = o.eu; n.us = o.us; n.vr = o.vr; n.ch = o.ch; n.cm = o.cm; n.pt = o.pt; if (o.atk) n.atk = o.atk; } // keep prices and attack names already fetched for regular cards
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
  noteArtist(id, d);
  const old = db.cards[id];
  if (d && d.category === 'Pokemon' && !(Array.isArray(d.dexId) && d.dexId.length)) { const g = p === '' ? nameDex(d.name) : dexByNameLoc(d.name, lang); if (g.length) d.dexId = g; }
  if (d && qualifies(d, p)) {
    const r = record(d, p); if (old && old.m) r.m = 1;
    if (old && !old.x) { // never replace something known with nothing: keep the last picture, price and shop number
      if (!r.b && old.b) r.b = old.b;
      if (r.eu == null && old.eu != null) r.eu = old.eu;
      if (r.us == null && old.us != null) r.us = old.us;
      if (!r.vr && old.vr) { r.vr = old.vr; r.ch = old.ch; }
      if (!r.cm && old.cm) r.cm = old.cm;
    }
    db.cards[id] = r;
    notePrice(id, r);
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
  // Cards on someone's wish list first, every day (Cardmarket updates its prices once a day): they feed the price graphs.
  const idx = regIndex();
  for (const id of wishedIds()) {
    const art = db.cards[id] && !db.cards[id].x ? db.cards[id] : null, reg = art ? null : idx.get(id);
    if ((!art && !reg) || ageDays((art || reg).pt) < WISH_PRICE_DAYS) continue;
    if (!canSpend()) return;
    if (art) await fetchCard(id); else await priceRegular(id, idx);
  }
  // Every card of a set released in the last months, every day as well (new cards change price fast).
  for (const id of recentIds()) {
    const art = db.cards[id] && !db.cards[id].x ? db.cards[id] : null, reg = art ? null : idx.get(id);
    if (!canSpend()) return;
    if (art) await fetchCard(id); else await priceRegular(id, idx);
  }
  for (const c of planPriceRefresh(maxAge, Infinity)) {
    if (!canSpend()) return;
    await fetchCard(c.id);
  }
}

// The cards of sets released in the last RECENT_PRICE_MONTHS months whose price is older than a day, oldest price first.
function recentIds() {
  if (!RECENT_PRICE_MONTHS) return [];
  const from = new Date(); from.setMonth(from.getMonth() - RECENT_PRICE_MONTHS);
  const since = from.toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10), out = [];
  for (const s of Object.values(db.sets)) {
    if (!s.scan || !s.date || s.date < since || s.date > today) continue;
    for (const c of s.cards) {
      const art = db.cards[c.id] && !db.cards[c.id].x ? db.cards[c.id] : null, pt = (art || c).pt;
      if (ageDays(pt) >= WISH_PRICE_DAYS) out.push([c.id, pt ? Date.parse(pt) : 0]);
    }
  }
  return out.sort((a, b) => a[1] - b[1]).map(x => x[0]);
}

// ---------- price history (for the graphs) ----------
// Every time a card's price is fetched, that day's price is noted: price-history.json { id: [[day, eu, us], ...] }.
// Wished cards are priced every day, so their graph fills in day by day; other cards get a point when they are priced.
const HIST_FILE = path.join(DATA_DIR, 'price-history.json');
let priceHist = readJSON(HIST_FILE) || {}, histDirty = false;
function notePrice(id, c) {
  if (!c || (c.eu == null && c.us == null)) return;
  const day = new Date().toISOString().slice(0, 10), h = priceHist[id] || (priceHist[id] = []);
  const row = [day, c.eu == null ? null : c.eu, c.us == null ? null : c.us];
  if (h.length && h[h.length - 1][0] === day) h[h.length - 1] = row; else { h.push(row); thinHist(h); }
  if (h.length > 400) h.splice(0, h.length - 400);
  histDirty = true;
}
// Older than PRICE_HISTORY_DAILY_DAYS days: one point per week is kept (the last of each week), so the file stays small.
function thinHist(h) {
  if (!PRICE_HISTORY_DAILY_DAYS || h.length < 8) return false;
  const cut = new Date(Date.now() - PRICE_HISTORY_DAILY_DAYS * 86400000).toISOString().slice(0, 10);
  if (h[0][0] >= cut) return false;
  const week = d => Math.floor(Date.parse(d) / (7 * 86400000));
  const out = [];
  for (let i = 0; i < h.length; i++) {
    const r = h[i], nx = h[i + 1];
    if (r[0] >= cut || !nx || nx[0] >= cut || week(nx[0]) !== week(r[0])) out.push(r);
  }
  if (out.length === h.length) return false;
  h.length = 0; out.forEach(r => h.push(r)); return true;
}
{ let n = 0; for (const h of Object.values(priceHist)) if (Array.isArray(h) && thinHist(h)) n++; if (n) histDirty = true; }
function saveHist(force) { if (histDirty || force) { writeJSON(HIST_FILE, priceHist); histDirty = false; } }
setInterval(() => saveHist(false), 60000).unref();
// Every card on someone's wish list.
function wishedIds() { const out = new Set(); allStates().forEach(s => wishOf(s).forEach(w => out.add(w.id))); return out; }

// ---------- prices of regular cards ----------
// Every card of the sets that are read: id -> set card (reg) and id -> [set id, set card] (where). Built once and
// built again after the set lists changed (setsChanged); the maps are only read, never changed.
let cardIdx = null;
function setsChanged() { cardIdx = null; }
function cardIndex() {
  if (!cardIdx) {
    const reg = new Map(), where = new Map();
    for (const [sid, s] of Object.entries(db.sets)) if (s.scan) for (const c of s.cards) { reg.set(c.id, c); where.set(c.id, [sid, c]); }
    cardIdx = { reg, where };
  }
  return cardIdx;
}
function regIndex() { return cardIndex().reg; }
async function priceRegular(id, idx, fast) {
  const c = (idx || regIndex()).get(id);
  if (!c) return false;
  const d = await paced('/cards/' + encodeURIComponent(rawId(id)), langOf(id), fast);
  c.pt = new Date().toISOString();
  if (d) { const pr = prices(d); c.eu = pr.eu; c.us = pr.us; c.vr = pr.vr; c.ch = pr.ch; c.cm = cmId(d); c.atk = moves(d); notePrice(id, c); noteArtist(id, d); }
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
