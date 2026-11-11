'use strict';
// Dex Art Tracker server, part 3 of 9: the card list for the page, artists.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
// ---------- export for the page ----------
let lastExport = { art: 0, regular: 0, sets: 0 };
// Picture fields for the page: im (small) and iL (large), when one was found elsewhere or set by hand.
function picOf(id, o) {
  const p = db.pics[id]; if (p && p.im) { o.im = p.im; o.iL = p.imL || p.im; }
  const st = imgs.c[id]; if (st) { o.lc = st.h ? 2 : 1; o.lv = st.v; if (st.s === 'custom') o.lm = 1; } // stored on this server: 1 = low, 2 = low and high; lm: set by hand
  return o;
}
function exportCards() {
  if (Object.keys(artists.card).length) { if (artistsDirty) { writeJSON(ARTISTS_FILE, artists); artistsDirty = false; } exportArtists(); }
  matchRegular();
  const setPics = regIndex();
  const art = [], trainers = [], regular = [], sets = [];
  Object.values(db.cards).forEach(c => {
    if (c.x) return;
    (c.tr ? trainers : art).push(picOf(c.id, { id: c.id, n: c.n, r: c.r, sid: c.sid, k: localOf(c.id, c.sid), b: c.b || (setPics.get(c.id) && setPics.get(c.id).i ? cleanBase(setPics.get(c.id).i) : null), d: c.d, eu: c.eu, us: c.us, vr: c.vr, ch: c.ch, cm: c.cm || undefined, pt: c.pt, m: c.m ? 1 : undefined }));
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
      if (c.d && c.d.length) regular.push(picOf(c.id, { id: c.id, n: c.n, sid, k: c.l, b: c.i || null, d: c.d, eu: c.eu, us: c.us, vr: c.vr, ch: c.ch, cm: c.cm || undefined, pt: c.pt }));
    }
    sets.push({ id: sid, name: s.name, date: s.date || '', official: s.official, total: s.total, n: s.cards.length, art: a, promo: s.promo ? 1 : 0,
      lg: noExt(s.lg), sy: noExt(s.sy), ll: imgs.s[sid] ? imgs.s[sid].v : undefined, lm: imgs.s[sid] && imgs.s[sid].m ? 1 : undefined });
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
    cards: s.cards.map(c => cardOut(s, c)),
  };
}
function cardOut(s, c) { // one card of a set as the set page shows it
  const rec = db.cards[c.id];
  const o = picOf(c.id, { id: c.id, k: c.l, n: c.n, b: c.i || null });
  if (rec && !rec.x) { o.t = 'a'; o.r = rec.r; o.eu = rec.eu; o.us = rec.us; o.vr = rec.vr; o.ch = rec.ch; o.cm = rec.cm; o.pt = rec.pt; o.d = rec.d; if (rec.m) o.m = 1; }
  else if (!rec && worth(s, c)) { o.t = 'a'; o.pv = 1; o.r = provRarity(c.id); o.d = c.d || []; o.eu = null; o.us = null; }
  else { o.t = 'r'; o.eu = c.eu; o.us = c.us; o.vr = c.vr; o.ch = c.ch; o.cm = c.cm; o.pt = c.pt; o.d = c.d || []; }
  if (isSecret(s, c)) o.sec = 1;
  return o;
}

// ---------- artists ----------
// TCGdex lists its illustrators (/illustrators) and the cards of each (/illustrators/<name>): one request per artist
// per language, read again every week, a few hundred per run so other work goes on. Cards fetched one by one (prices)
// also note their artist. artists.json keeps { card: { id: name }, done: { lang: time }, pos: { lang: progress } };
// artists-list.json is what the page reads: every artist with the number of cards and the most expensive one as picture.
const ARTISTS_FILE = path.join(DATA_DIR, 'artists.json'), ARTISTS_OUT = path.join(DATA_DIR, 'artists-list.json');
const ARTISTS_DAYS = 7, ARTISTS_PER_RUN = 300;
const artists = Object.assign({ card: {}, done: {}, pos: {} }, readJSON(ARTISTS_FILE) || {});
let artistsDirty = false;
function noteArtist(id, d) {
  const a = d && typeof d.illustrator === 'string' ? d.illustrator.trim() : '';
  if (a && artists.card[id] !== a) { artists.card[id] = a; artistsDirty = true; }
}
function saveArtists() { writeJSON(ARTISTS_FILE, artists); artistsDirty = false; exportArtists(); }
async function syncArtists() {
  let n = 0;
  for (const lang of LANGS) {
    if (artists.done[lang] && ageDays(artists.done[lang]) < ARTISTS_DAYS) continue;
    let pos = artists.pos[lang];
    if (!pos) {
      if (!canSpend()) return;
      const list = await paced('/illustrators', lang); n++;
      if (!Array.isArray(list)) { artists.done[lang] = new Date().toISOString(); saveArtists(); continue; } // this language has no artist list
      pos = artists.pos[lang] = { names: list.filter(x => typeof x === 'string' && x.trim()), i: 0 };
    }
    while (pos.i < pos.names.length) {
      if (n >= ARTISTS_PER_RUN || !canSpend()) { saveArtists(); return; }
      const name = pos.names[pos.i].trim();
      const d = await paced('/illustrators/' + encodeURIComponent(pos.names[pos.i]), lang); n++;
      if (d && Array.isArray(d.cards)) for (const c of d.cards) if (c && c.id) artists.card[pfx(lang) + c.id] = name;
      pos.i++; if (pos.i % 25 === 0) saveArtists();
    }
    artists.done[lang] = new Date().toISOString(); delete artists.pos[lang]; saveArtists();
    log('artists read for', lang + ':', pos.names.length);
  }
  if (artistsDirty) saveArtists();
}
// Where every card is: id -> [set id, set card]
function cardWhere() { return cardIndex().where; }
function exportArtists() {
  const where = cardWhere(), by = new Map(), cur = PRICE_CUR;
  for (const [id, name] of Object.entries(artists.card)) { if (!where.has(id)) continue; if (!by.has(name)) by.set(name, []); by.get(name).push(id); }
  const priceOf = id => { const rec = db.cards[id]; const v = rec && !rec.x ? rec[cur] : where.get(id)[1][cur]; return typeof v === 'number' ? v : null; };
  const list = [], ids = [];
  [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, cs]) => {
    let best = null, bp = -1;
    for (const id of cs) { const v = priceOf(id); if (v != null && v > bp) { bp = v; best = id; } }
    if (!best) best = cs.find(id => where.get(id)[1].i || (db.cards[id] && db.cards[id].b)) || cs[0];
    const [sid, c] = where.get(best), rec = db.cards[best];
    list.push({ n: name, c: cs.length, cv: picOf(best, { id: best, n: c.n, k: c.l, sid, b: (rec && !rec.x && rec.b) || (c.i ? cleanBase(c.i) : null), eu: bp >= 0 && cur === 'eu' ? bp : undefined, us: bp >= 0 && cur === 'us' ? bp : undefined }) });
    ids.push(cs);
  });
  writeJSON(ARTISTS_OUT, { list, ids, t: new Date().toISOString() });
}
// An artist's page: every card of that artist, in the shape of a set page (oldest set first)
function artistPayload(name) {
  const where = cardWhere(), cards = [];
  for (const [id, a] of Object.entries(artists.card)) {
    if (a !== name || !where.has(id)) continue;
    const [sid, c] = where.get(id), s = db.sets[sid], o = cardOut(s, c);
    o.sid = sid; o.sn = s.name; o.date = s.date || ''; cards.push(o);
  }
  if (!cards.length) return null;
  const num = k => parseInt(k, 10) || 0;
  cards.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.sid.localeCompare(b.sid) || num(a.k) - num(b.k));
  return { id: 'artist:' + name, name, artist: 1, sets: new Set(cards.map(c => c.sid)).size, cards };
}

let sinceSave = 0;
// Saving: a change made by the background work only marks the database as changed, and a timer writes it (with the
// card list for the page) at most once every 5 minutes. A change you make yourself (force) is written at once.
let dbDirty = false;
function persist(force) {
  if (!force) { dbDirty = true; return; }
  dbDirty = false;
  writeJSON(DB_FILE, db);
  exportCards();
}
setInterval(() => { if (dbDirty) { try { persist(true); } catch (e) { log('saving the database failed:', e.message); } } }, 5 * 60000).unref();
