'use strict';
// Dex Art Tracker server, part 2 of 9: talking to TCGdex, helpers, Pokémon names and matching.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
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
  if (s.lang && s.lang !== 'en' && isSecret(s, c)) return true; // Japanese and Chinese: cards past the set size
  if (foundIds().has(c.id)) return true;
  return !rarOk(s.lang || 'en') && isSecret(s, c);
}
// Rarity a not-yet-fetched art card was listed under (kept from the rarity search).
function provRarity(id) {
  const r = db.rar[langOf(id)];
  return (r && r.m && r.m[rawId(id)]) || (langOf(id) !== 'en' ? 'Secret card' : null);
}
function worth(s, c) { return isCandidate(s, c) && (foundIds().has(c.id) || spOf(c) !== 0); }
const localOf = (id, sid) => String(id).slice(String(sid || '').length + 1);

const num = v => typeof v === 'number' && v > 0 ? Math.round(v * 100) / 100 : null;
// TCGplayer names its printings normal, holofoil, reverse-holofoil, 1st-edition-holofoil ...
function printName(k) {
  const t = String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase().trim();
  const m = { normal: 'Normal', holo: 'Holo', holofoil: 'Holo', reverse: 'Reverse holo', 'reverse holo': 'Reverse holo', 'reverse holofoil': 'Reverse holo',
    '1st edition': '1st edition', '1st edition holo': '1st edition holo', '1st edition holofoil': '1st edition holo', '1st edition normal': '1st edition',
    unlimited: 'Unlimited', 'unlimited holo': 'Unlimited holo', 'unlimited holofoil': 'Unlimited holo' };
  return m[t] || t.charAt(0).toUpperCase() + t.slice(1);
}
// The card's price (eu, us), every printing (vr) and the change of the day price against the 30-day average (ch).
// Cardmarket has two price families per card: the card itself and its reverse holo (TCGdex: "-holo");
// TCGplayer has one price per printing (normal, holo, reverse holo, 1st edition ...).
function prices(d) {
  let us = null, eu = null, fam = '';
  const p = d.pricing || {};
  const tp = p.tcgplayer || {};
  Object.keys(tp).forEach(k => {
    const v = tp[k];
    if (v && typeof v === 'object' && typeof v.marketPrice === 'number' && v.marketPrice > 0 && (us === null || v.marketPrice < us)) us = v.marketPrice;
  });
  const cm = p.cardmarket || {};
  // the card's own price (standard print) first; the reverse holo only when the card has no other price
  ['trend', 'avg30', 'trend-holo', 'avg30-holo'].some(k => {
    if (typeof cm[k] === 'number' && cm[k] > 0) { eu = cm[k]; fam = k.endsWith('-holo') ? '-holo' : ''; return true; }
    return false;
  });
  const vrEu = [['', 'Standard print'], ['-holo', 'Reverse holo']].map(([f, k]) => {
    const o = { k, v: num(cm['trend' + f]) || num(cm['avg30' + f]) || num(cm['avg' + f]), a1: num(cm['avg1' + f]), a7: num(cm['avg7' + f]), a30: num(cm['avg30' + f]), lo: num(cm['low' + f]) };
    return o.v == null ? null : o;
  }).filter(Boolean);
  const vrUs = Object.keys(tp).filter(k => tp[k] && typeof tp[k] === 'object' && num(tp[k].marketPrice) != null)
    .map(k => ({ k: printName(k), v: num(tp[k].marketPrice), lo: num(tp[k].lowPrice) }));
  const vr = vrEu.length || vrUs.length ? { eu: vrEu.length ? vrEu : undefined, us: vrUs.length ? vrUs : undefined } : undefined;
  // up or down: the day price (average of yesterday's sales, else the trend) against the 30-day average, same family as the price shown
  const day = num(cm['avg1' + fam]) || num(cm['trend' + fam]), month = num(cm['avg30' + fam]);
  const ch = eu != null && day != null && month != null ? Math.round((day - month) / month * 1000) / 1000 : undefined;
  return { us, eu, vr, ch };
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
// Japanese and Chinese card names contain the Pokémon's name (リザードンex, ナンジャモのピカチュウ, 皮卡丘ex ...).
// The names come from PokeAPI and are kept in names.json (ja for Japanese, zh-cn for Chinese Simplified).
const locCache = {};
function locList(lang) {
  const map = (NM && NM[lang]) || {}, n = Object.keys(map).length;
  if (!locCache[lang] || locCache[lang].n !== n) locCache[lang] = { n, list: Object.entries(map).map(([d, name]) => [+d, String(name).normalize('NFKC')]).filter(x => x[1].length >= 2) };
  return locCache[lang].list;
}
function dexByNameJa(raw) { return dexByNameLoc(raw, 'ja'); }
function dexByNameLoc(raw, lang) {
  if (!NM || !NM[lang]) return [];
  const t = String(raw || '').normalize('NFKC');
  const hits = locList(lang).filter(([, name]) => t.includes(name));
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
  if (p && s && isSecret(s, { l: String(d.localId) })) return true;
  return !!(PROMO_AS_ART && s && s.promo);
}
// The ability and attack names of a card, in the order printed (Cardmarket names Pokémon cards by them)
function moves(d) {
  const m = [].concat((d && d.abilities) || [], (d && d.attacks) || []).map(x => x && typeof x.name === 'string' ? x.name.trim() : '').filter(Boolean);
  return m.length ? m : undefined;
}
function record(d, p) {
  const pr = prices(d); p = p || '';
  return { atk: moves(d),
    id: p + d.id, n: d.name, r: d.rarity || null, s: d.set && d.set.name, sid: d.set && (p + d.set.id), d: d.dexId || [], tr: d.category === 'Trainer' ? 1 : undefined,
    b: cleanBase(d.image), eu: pr.eu, us: pr.us, vr: pr.vr, ch: pr.ch, cm: cmId(d), pt: new Date().toISOString(),
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
  if (!SP || langOf(c.id) !== 'en') return undefined;
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
    NM = Object.assign({}, NM || {}, { t: Date.now(), max, names }); // keeps the Japanese and Chinese names
    writeJSON(NAMES_FILE, NM);
    loadSpecies();
    log('names updated:', Object.keys(names).length);
  } catch (e) { log('names refresh failed:', e.message); }
}

// Regular cards have no dex number in the set listing, so they are matched to Pokémon by name.
function matchRegular() {
  const key = NM && NM.names ? NM.t + ':' + EXTRA_LANGS.map(l => (NM[l + 'Done'] || 0)).join(':') : null; // again when names of a language arrive
  if (!key || db.regMatched === key) return;
  const sp = speciesList();
  for (const s of Object.values(db.sets)) {
    if (!s.scan) continue;
    for (const c of s.cards) c.d = s.lang && s.lang !== 'en' ? dexByNameLoc(c.n, s.lang) : dexByName(c.n, sp);
  }
  db.regMatched = key;
}

// Japanese and Chinese species names from PokeAPI: one GraphQL request, or one request per Pokémon if that is not available.
const POKEAPI_LANG = { ja: ['ja-Hrkt', 'ja'], 'zh-cn': ['zh-hans', 'zh-Hans'] };
async function refreshLocNames() { for (const l of LANGS) if (l !== 'en') await refreshLangNames(l); }
async function refreshLangNames(lang) {
  const codes = POKEAPI_LANG[lang]; if (!codes || !NM || !NM.names) return;
  const want = Object.keys(NM.names).map(Number), doneKey = lang + 'Done';
  NM[lang] = NM[lang] || {};
  const map = NM[lang], have = () => Object.keys(map).length;
  if (NM[doneKey] && have() >= want.length * 0.9) return;
  if (have() < want.length * 0.9) {
    try {
      const r = await fetch('https://beta.pokeapi.co/graphql/v1beta', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'dex-art-tracker' }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ query: '{ pokemon_v2_pokemonspeciesname(where: {pokemon_v2_language: {name: {_in: ' + JSON.stringify(codes) + '}}}) { pokemon_species_id name pokemon_v2_language { name } } }' }),
      });
      const j = r.ok ? await r.json() : null;
      const rows = j && j.data && j.data.pokemon_v2_pokemonspeciesname;
      if (Array.isArray(rows)) rows.forEach(x => { const id = x.pokemon_species_id; if (id && x.name && (x.pokemon_v2_language.name === codes[0] || !map[id])) map[id] = x.name; });
    } catch (e) { log(LANG_NAME[lang].toLowerCase() + ' names (bulk) failed:', e.message); }
  }
  if (have() < want.length * 0.9) { // fall back to one request per Pokémon, up to 400 per start of a run
    let n = 0;
    for (const id of want) {
      if (map[id]) continue;
      if (n++ >= 400) break;
      try {
        const r = await fetch('https://pokeapi.co/api/v2/pokemon-species/' + id + '/', { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'dex-art-tracker' } });
        if (r.ok) {
          const j = await r.json(), lc = codes.map(c => c.toLowerCase());
          const nm = lc.map(c => (j.names || []).find(x => String(x.language.name).toLowerCase() === c)).find(Boolean);
          if (nm) map[id] = nm.name;
        }
      } catch (e) { /* try again in a later run */ }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  if (have() >= want.length * 0.9) { NM[doneKey] = Date.now(); log(LANG_NAME[lang].toLowerCase() + ' names loaded:', have()); }
  writeJSON(NAMES_FILE, NM);
  delete locCache[lang];
}
