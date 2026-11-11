'use strict';
// Dex Art Tracker server, part 7 of 9: importing a collection from another site.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
// ---------- importing a collection from another site (a CSV export, for example Collectr) ----------
// Every row is matched by card number first (the number on the card, without the "/set size"), then checked
// by name (or, for Japanese cards, by Pokémon), with the set name and set size to choose between sets.
// Only the matching happens here: the page adds the cards to the owned list or the wish list itself.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const t = String(text).replace(/^﻿/, '');
  const sep = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const cardNo = s => String(s || '').trim().toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1'); // "087" -> "87", "TG02" -> "TG2"
function setWords(name) {
  const w = plain(name).replace(/\bpokemon\b/g, ' ').replace(/\bbase set\b/g, ' ').replace(/\bblack star promos?\b/g, ' promo ').replace(/\bpromos\b/g, 'promo').replace(/\s+/g, ' ').trim();
  return w || plain(name); // "Base Set" stays "base set"
}
// Card lists like "1 Pikachu ex MEW 25" (Pokémon TCG Live, Limitless and other deck builders) use short set codes.
const SET_CODES = {
  // Mega Evolution, Scarlet & Violet
  MEG: 'Mega Evolution', PFL: 'Phantasmal Flames', ASC: 'Ascended Heroes', POR: 'Perfect Order', CRI: 'Chaos Rising', PBL: 'Pitch Black',
  '30C': '30th Celebration', DLR: 'Delta Reign', MEE: 'Mega Evolution Energy', MEP: 'MEP Black Star Promos',
  SVI: 'Scarlet & Violet', PAL: 'Paldea Evolved', OBF: 'Obsidian Flames', MEW: '151', PAR: 'Paradox Rift', PAF: 'Paldean Fates',
  TEF: 'Temporal Forces', TWM: 'Twilight Masquerade', SFA: 'Shrouded Fable', SCR: 'Stellar Crown', SSP: 'Surging Sparks',
  PRE: 'Prismatic Evolutions', JTG: 'Journey Together', DRI: 'Destined Rivals', BLK: 'Black Bolt', WHT: 'White Flare',
  SVE: 'Scarlet & Violet Energies', 'PR-SV': 'SVP Black Star Promos', SVP: 'SVP Black Star Promos',
  // Sword & Shield
  SSH: 'Sword & Shield', RCL: 'Rebel Clash', DAA: 'Darkness Ablaze', CPA: "Champion's Path", VIV: 'Vivid Voltage', SHF: 'Shining Fates',
  BST: 'Battle Styles', CRE: 'Chilling Reign', EVS: 'Evolving Skies', CEL: 'Celebrations', FST: 'Fusion Strike', BRS: 'Brilliant Stars',
  ASR: 'Astral Radiance', PGO: 'Pokémon GO', LOR: 'Lost Origin', SIT: 'Silver Tempest', CRZ: 'Crown Zenith',
  'PR-SW': 'SWSH Black Star Promos', SWSHP: 'SWSH Black Star Promos',
  // Sun & Moon
  SUM: 'Sun & Moon', GRI: 'Guardians Rising', BUS: 'Burning Shadows', SLG: 'Shining Legends', CIN: 'Crimson Invasion', UPR: 'Ultra Prism',
  FLI: 'Forbidden Light', CES: 'Celestial Storm', DRM: 'Dragon Majesty', LOT: 'Lost Thunder', TEU: 'Team Up', DET: 'Detective Pikachu',
  UNB: 'Unbroken Bonds', UNM: 'Unified Minds', HIF: 'Hidden Fates', CEC: 'Cosmic Eclipse', 'PR-SM': 'SM Black Star Promos', SMP: 'SM Black Star Promos',
  // XY
  XY: 'XY', FLF: 'Flashfire', FFI: 'Furious Fists', PHF: 'Phantom Forces', PRC: 'Primal Clash', DCR: 'Double Crisis', ROS: 'Roaring Skies',
  AOR: 'Ancient Origins', BKT: 'BREAKthrough', BKP: 'BREAKpoint', GEN: 'Generations', FCO: 'Fates Collide', STS: 'Steam Siege',
  EVO: 'Evolutions', 'PR-XY': 'XY Black Star Promos', XYP: 'XY Black Star Promos',
  // Black & White
  BLW: 'Black & White', EPO: 'Emerging Powers', NVI: 'Noble Victories', NXD: 'Next Destinies', DEX: 'Dark Explorers', DRX: 'Dragons Exalted',
  DRV: 'Dragon Vault', BCR: 'Boundaries Crossed', PLS: 'Plasma Storm', PLF: 'Plasma Freeze', PLB: 'Plasma Blast', LTR: 'Legendary Treasures',
  'PR-BLW': 'BW Black Star Promos', BWP: 'BW Black Star Promos',
  // HeartGold & SoulSilver, Platinum, Diamond & Pearl
  HS: 'HeartGold SoulSilver', UL: 'Unleashed', UD: 'Undaunted', TM: 'Triumphant', CL: 'Call of Legends', HSP: 'HGSS Black Star Promos',
  PL: 'Platinum', RR: 'Rising Rivals', SV: 'Supreme Victors', AR: 'Arceus',
  DP: 'Diamond & Pearl', MT: 'Mysterious Treasures', SW: 'Secret Wonders', GE: 'Great Encounters', MD: 'Majestic Dawn',
  LA: 'Legends Awakened', SF: 'Stormfront', DPP: 'DP Black Star Promos',
  // EX, e-Card, Neo, the first sets
  RS: 'Ruby & Sapphire', SS: 'Sandstorm', DR: 'Dragon', MA: 'Team Magma vs Team Aqua', HL: 'Hidden Legends', RG: 'FireRed & LeafGreen',
  TRR: 'Team Rocket Returns', DX: 'Deoxys', EM: 'Emerald', UF: 'Unseen Forces', DS: 'Delta Species', LM: 'Legend Maker',
  HP: 'Holon Phantoms', CG: 'Crystal Guardians', DF: 'Dragon Frontiers', PK: 'Power Keepers',
  E1: 'Expedition Base Set', E2: 'Aquapolis', E3: 'Skyridge', N1: 'Neo Genesis', N2: 'Neo Discovery', N3: 'Neo Revelation', N4: 'Neo Destiny',
  BS: 'Base Set', JU: 'Jungle', FO: 'Fossil', B2: 'Base Set 2', TR: 'Team Rocket', G1: 'Gym Heroes', G2: 'Gym Challenge', LC: 'Legendary Collection',
};
// "1 Pikachu ex MEW 25", "1 Paras CRZ-GG 32" (Galarian Gallery card GG32), "1 Floatzel GL RR 4", "1 Tentacruel E2 H26".
// Lines like "Pokémon: 707" or "Trainer: 0" are headings.
function parseCardList(text) {
  const out = [];
  String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(\d+)x?\s+(.+?)\s+([A-Z0-9]{1,6}(?:-[A-Z]{2,3})?)\s+([A-Z]{0,4}\d+[a-z]?)\s*$/.exec(line);
    if (!m) return;
    let code = m[3], num = m[4], sub = '';
    const g = /^(.+)-(TG|GG|RC|SV)$/.exec(code);
    if (g && !SET_CODES[code]) { code = g[1]; sub = g[2]; }
    if (sub && /^\d/.test(num)) num = sub + num.padStart(2, '0'); // a gallery card: CRZ-GG 32 is GG32
    const setName = SET_CODES[code] || code;
    out.push({ row: i + 1, name: m[2], number: num, set: sub ? setName + (sub === 'TG' ? ' Trainer Gallery' : sub === 'GG' ? ' Galarian Gallery' : '') : setName, code: m[3],
      ja: /^(M\d+[A-Z]?|SV\d+[A-Z]?)$/.test(code) && !SET_CODES[code] }); // Japanese set codes such as M6, M6a, SV8a
  });
  return out;
}
let importIdx = null, importIdxAt = 0;
function importIndex() { // card number -> cards in every set read
  if (importIdx && Date.now() - importIdxAt < 600000) return importIdx;
  const m = new Map();
  for (const [sid, s] of Object.entries(db.sets)) {
    if (!s.scan) continue;
    const sw = setWords(s.name);
    for (const c of s.cards) {
      const k = cardNo(c.l); if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ c, sid, s, sw });
    }
  }
  importIdx = m; importIdxAt = Date.now();
  return m;
}
const IMPORT_COLS = {
  name: ['product name', 'card name', 'name', 'card'],
  number: ['card number', 'number', 'collector number', 'card no', 'no'],
  set: ['set', 'set name', 'expansion', 'edition'],
};
function importRows(text) {
  const rows = parseCsv(text);
  if (rows.length >= 2) {
    const head = rows[0].map(h => plain(h));
    const col = k => { for (const n of IMPORT_COLS[k]) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
    const ci = { name: col('name'), number: col('number'), set: col('set') };
    if (ci.name >= 0 && ci.number >= 0) {
      return rows.slice(1).map((r, n) => ({ row: n + 2, name: (r[ci.name] || '').trim(), number: (r[ci.number] || '').trim(), set: ci.set >= 0 ? (r[ci.set] || '').trim() : '' }))
        .filter(r => r.name || r.number);
    }
  }
  const list = parseCardList(text);
  if (list.length) return list;
  throw new Error('Could not read that as a CSV export (with card name and card number columns) or as a card list like "1 Pikachu ex MEW 25"');
}
const IMPORT_TAG_LANG = { EN: 'en', FR: 'fr', DE: 'de', ES: 'es', SP: 'es', IT: 'it', PT: 'pt', BR: 'pt', NL: 'nl', PL: 'pl', RU: 'ru', JP: 'ja', JA: 'ja', KR: 'ko', KO: 'ko', TW: 'zh-tw', CN: 'zh-cn', ZH: 'zh-cn', ID: 'id', TH: 'th' };
function importMatch(text) {
  const idx = importIndex(), found = [], missing = [];
  importRows(text).forEach(row => {
    const rawName = row.name, rawNo = row.number, set = row.set;
    const out = { row: row.row, name: rawName, number: rawNo, set };
    const tags = (rawName.match(/\(([^)]*)\)/g) || []).map(x => x.slice(1, -1).trim().toUpperCase());
    // a language tag such as (FR), (KR) or (JP): the card is looked up as its English, Japanese or Chinese counterpart
    const tagLang = tags.map(t => IMPORT_TAG_LANG[t]).find(Boolean);
    const want = (tagLang && counterpart(tagLang)) || (row.ja ? 'ja' : 'en');
    const name = plain(rawName.replace(/\([^)]*\)/g, ' '));
    const parts = rawNo.split('/'), num = cardNo(parts[0]), total = parts[1] ? cardNo(parts[1]) : '';
    if (!num) return missing.push(Object.assign(out, { why: 'No card number' }));
    const dex = new Set(nameDex(rawName.replace(/\([^)]*\)/g, ' ')));
    const sw = setWords(set);
    let best = null, bestScore = -1, tie = false;
    for (const x of idx.get(num) || []) {
      const cn = plain(x.c.n);
      const nameOk = !!cn && (cn === name || (name.length >= 3 && cn.length >= 3 && (cn.includes(name) || name.includes(cn)))); // Japanese names have no letters left here
      const dexOk = !nameOk && dex.size && (x.c.d && x.c.d.length ? x.c.d : nameDex(x.c.n)).some(d => dex.has(d));
      if (!nameOk && !dexOk) continue;
      let score = nameOk ? (cn === name ? 3 : 2) : 1;
      if (sw && x.sw === sw) score += 6;
      else if (sw && x.sw && (x.sw.includes(sw) || sw.includes(x.sw))) score += 3;
      if (total && (cardNo(String(x.s.official)) === total || cardNo(String(x.s.total)) === total)) score += 2;
      if ((x.s.lang || 'en') === want) score += 1; else if (want !== 'en') score -= tagLang ? 8 : 2; // a tagged (JP) or (KR) card is the Japanese print when there is one
      if (score > bestScore || (score === bestScore && String(x.s.date) > String(best.s.date))) { tie = score === bestScore; best = x; bestScore = score; }
      else if (score === bestScore) tie = true;
    }
    if (!best && sw) { // the number may be printed with letters in that set (Shiny Vault SV36 listed as "36")
      const digits = num.replace(/^[A-Z]+/, '');
      for (const [, s2] of Object.entries(db.sets)) {
        if (!s2.scan) continue;
        const w2 = setWords(s2.name);
        if (!(w2 === sw || w2.includes(sw) || sw.includes(w2))) continue;
        for (const c of s2.cards) {
          const cn = plain(c.n);
          if (cardNo(c.l).replace(/^[A-Z]+/, '') !== digits || !cn || !(cn === name || cn.includes(name) || name.includes(cn))) continue;
          best = { c, s: s2 }; bestScore = w2 === sw ? 6 : 3; tie = false;
        }
      }
    }
    if (!best) return missing.push(Object.assign(out, { why: (idx.get(num) || []).length ? 'No card with that name and number' : 'No card with that number in the sets read' }));
    found.push(Object.assign(out, { id: best.c.id, card: best.c.n, cardSet: best.s.name, sure: bestScore >= 6 && !tie ? 1 : 0 }));
  });
  return { found, missing };
}
