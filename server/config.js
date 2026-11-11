'use strict';
// Dex Art Tracker server, part 1 of 9: settings, data folder, the database file and its upgrades.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
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

// ---------- settings from the admin page ----------
// Every setting below can also be chosen on the admin page. Those choices are kept in settings.json in the data
// folder and win over the container's own values; "Default" on the page means: use the container's value (or the
// built-in default). The server starts again by itself to apply a change (see start.js).
const yesNo = (yes, no) => [['1', yes || 'Yes'], ['0', no || 'No']];
const SETTINGS = [
  { group: 'Prices', key: 'PRICE_SOURCE', label: 'Prices from', def: 'cardmarket', options: [['cardmarket', 'Cardmarket (€)'], ['tcgplayer', 'TCGplayer ($)']] },
  { group: 'Prices', key: 'PRICE_MAX_AGE_DAYS', label: 'Check art card prices again after', def: '30', options: [['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days']] },
  { group: 'Prices', key: 'RECENT_PRICE_MONTHS', label: 'Price every card of new sets every day', def: '6', help: 'Prices of new cards change often. Costs about one request per card per day (a set has about 200 cards).',
    options: [['0', 'Off'], ['3', 'Sets from the last 3 months'], ['6', 'Sets from the last 6 months'], ['12', 'Sets from the last 12 months']] },
  { group: 'Prices', key: 'PRICE_HISTORY_DAILY_DAYS', label: 'Price history: keep a point per day for', def: '90', help: 'Older points are thinned to one per week, which keeps the history file small. At most 400 points per card are kept.',
    options: [['30', '30 days, then weekly'], ['90', '90 days, then weekly'], ['180', '180 days, then weekly'], ['0', 'Always daily (largest file)']] },
  { group: 'Prices', key: 'SHOW_VALUE_PUBLIC', label: 'Visitors (not logged in) see worth and left to spend', def: '0', options: yesNo('Shown', 'Hidden') },
  { group: 'Card database', key: 'MIN_SET_DATE', label: 'Sets to read', def: 'any', help: 'Older sets are read the next time the set list is checked (at start).',
    options: [['any', 'All sets (from 1996)'], ['2000-01-01', 'From 2000'], ['2011-04-25', 'From Black & White (2011)'], ['2017-02-03', 'From Sun & Moon (2017)'], ['2020-02-07', 'From Sword & Shield (2020)'], ['2023-03-31', 'From Scarlet & Violet (2023)']] },
  { group: 'Card database', key: 'LANGUAGES', label: 'Languages', def: 'en,ja', options: [['en,ja', 'English and Japanese'], ['en,ja,zh-cn', 'English, Japanese and Chinese (Simplified)'], ['en,zh-cn', 'English and Chinese (Simplified)'], ['en', 'English only']] },
  { group: 'Card database', key: 'PROMO_AS_ART', label: 'Every Pokémon card from a promo set counts as an art card', def: '1', options: yesNo() },
  { group: 'Card database', key: 'DISABLE_REFRESH', label: 'Contact the card service (TCGdex)', def: '0', options: [['0', 'Yes'], ['1', 'No (work offline)']] },
  { group: 'Card database', key: 'REQUEST_DELAY_MS', label: 'Pause between requests to the card service', def: '2000', options: [['1000', '1 second'], ['2000', '2 seconds'], ['5000', '5 seconds'], ['10000', '10 seconds']] },
  { group: 'Card database', key: 'DAILY_REQUESTS', label: 'Requests per day', def: '0', options: [['0', 'No limit'], ['500', '500'], ['1000', '1,000'], ['2000', '2,000'], ['5000', '5,000'], ['10000', '10,000']] },
  { group: 'Card database', key: 'SETS_CHECK_HOURS', label: 'Look for new sets', def: '6', options: [['1', 'Every hour'], ['3', 'Every 3 hours'], ['6', 'Every 6 hours'], ['12', 'Every 12 hours'], ['24', 'Every day'], ['168', 'Every week']] },
  { group: 'Pictures', key: 'IMAGE_HIGH', label: 'Store high resolution pictures of', def: 'all', options: [['all', 'All cards'], ['art', 'Art, owned and wished cards'], ['none', 'No cards (small pictures only)']] },
  { group: 'Pictures', key: 'PICTURE_LOOKUP', label: 'Look up missing pictures on pokemontcg.io', def: '1', options: yesNo() },
  { group: 'Pictures', key: 'PICTURES_PER_DAY', label: 'Picture lookups per day', def: '500', options: [['100', '100'], ['500', '500'], ['1000', '1,000'], ['0', 'No limit']] },
  { group: 'Scanning', key: 'SCAN', label: 'Card scanning', def: '1', options: yesNo('On', 'Off') },
  { group: 'Scanning', key: 'SCAN_AI', label: 'Read cards with', def: 'none', help: 'An AI reads cards much better than the built-in reader. Choose the service, then its model and key.',
    options: [['none', 'Built-in reader only'], ['gemini', 'Google Gemini'], ['openai', 'OpenAI (GPT)'], ['claude', 'Anthropic Claude'], ['mistral', 'Mistral'], ['openrouter', 'OpenRouter'], ['local', 'Local AI (Ollama, LM Studio, llama.cpp)']] },
  { group: 'Scanning', key: 'SCAN_AI_MODEL', label: 'AI model', type: 'model', def: '(the service\'s default)', help: 'The model must understand pictures.' },
  { group: 'Scanning', key: 'SCAN_AI_BACKUP_MODEL', label: 'Backup model (when the first is busy)', type: 'model', def: '(Gemini: gemini-flash-lite-latest, others: none)', none: true },
  { group: 'Scanning', key: 'SCAN_AI_KEY', label: 'AI key', type: 'secret', help: 'Not needed for most local AIs.' },
  { group: 'Scanning', key: 'SCAN_AI_URL', label: 'Address of the AI server', type: 'url', def: '(the service\'s own address)', help: 'Only for a local AI, including /v1, for example http://192.168.1.20:11434/v1' },
  { group: 'Scanning', key: 'SCAN_AI_TIMEOUT', label: 'Wait for the AI at most', def: '45', options: [['30', '30 seconds'], ['45', '45 seconds'], ['60', '1 minute'], ['120', '2 minutes'], ['180', '3 minutes']] },
  { group: 'Scanning', key: 'SCAN_DEBUG', label: 'Write scan details to the log', def: '0', options: yesNo() },
  { group: 'Trainers', key: 'SIGNUP', label: 'New trainers can sign up themselves', def: '1', options: [['1', 'Yes (on the website and in the app)'], ['0', 'No, only the admin adds trainers']] },
  { group: 'Trainers', key: 'SIGNUP_PER_DAY', label: 'Sign-ups allowed per day (all together)', def: '20', options: [['5', '5'], ['20', '20'], ['50', '50'], ['200', '200']] },
  { group: 'Trainers', key: 'MAX_TRAINERS', label: 'Most trainers on this server', def: '200', options: [['25', '25'], ['50', '50'], ['200', '200'], ['1000', '1,000']] },
  { group: 'Android app', key: 'ANDROID_APP', label: 'Offer the Android app (a button on the website, update check in the app)', def: '1', options: yesNo() },
  { group: 'Android app', key: 'ANDROID_RELEASE', label: 'Where the app is downloaded from', type: 'url', def: 'https://github.com/Puppetchu/dex-art-tracker/releases/latest/download/',
    help: 'The address of the folder with dex-art.apk and version.json: the "android-latest" release that GitHub builds for your repository.' },
  { group: 'Network', key: 'TRUST_PROXY', label: 'Behind a reverse proxy (use X-Forwarded-For)', def: '1', options: yesNo() },
  { group: 'Network', key: 'PROXY_HOPS', label: 'Proxies in a row in front of the server', def: '1', options: [['1', '1'], ['2', '2'], ['3', '3']] },
];
const MODEL_SUGGESTIONS = {
  gemini: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-flash-lite-latest'],
  openai: ['gpt-5.4-mini', 'gpt-5-mini'],
  claude: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
  mistral: ['mistral-small-latest', 'mistral-medium-latest'],
  openrouter: ['openai/gpt-5.4-mini', 'openrouter/auto'],
  local: ['qwen2.5vl:7b', 'gemma3:12b', 'llama3.2-vision'],
};
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ENV0 = {}; // the container's own values
function settingOk(f, v) {
  if (typeof v !== 'string') return false;
  if (f.options) return f.options.some(o => o[0] === v);
  if (f.type === 'model') return /^[\w.:/@+-]{1,120}$/.test(v);
  if (f.type === 'url') return /^https?:\/\/[^\s"'<>]{1,300}$/i.test(v);
  if (f.type === 'secret') return v.length <= 400 && !/[\u0000-\u001f\u007f\s]/.test(v);
  return false;
}
let pageSettings = {};
try { pageSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch (e) { pageSettings = {}; }
for (const f of SETTINGS) {
  ENV0[f.key] = process.env[f.key];
  if (Object.prototype.hasOwnProperty.call(pageSettings, f.key)) {
    if (settingOk(f, pageSettings[f.key])) process.env[f.key] = pageSettings[f.key]; else delete pageSettings[f.key];
  }
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE = (process.env.TCGDEX_BASE || 'https://api.tcgdex.net/v2/en').replace(/\/$/, '');
// Languages whose sets are read: en (always), ja (Japanese) and zh-cn (Chinese Simplified). Their ids are stored as
// "ja:<id>" and "zh-cn:<id>" so they never clash with the English ones.
const EXTRA_LANGS = ['ja', 'zh-cn'];
const LANGS = ['en'].concat((process.env.LANGUAGES || 'en,ja').split(',').map(x => x.trim().toLowerCase()).filter(x => EXTRA_LANGS.includes(x)));
const LANG_NAME = { en: 'English', ja: 'Japanese', 'zh-cn': 'Chinese' };
const baseFor = lang => BASE.replace(/\/en$/, '/' + lang);
const langOf = id => { const m = /^(ja|zh-cn):/.exec(String(id)); return m ? m[1] : 'en'; };
const pfx = lang => lang === 'en' ? '' : lang + ':';
const rawId = id => String(id).replace(/^(ja|zh-cn):/, '');
// Every other language TCGdex knows counts as its counterpart print: European prints (French, German, Spanish, Italian,
// Portuguese, Dutch, Polish, Russian) share the English sets and numbers; Asian prints (Korean, Traditional Chinese,
// Indonesian, Thai) follow the Japanese sets. So a French card is found as the English card, a Korean one as the Japanese one.
const EU_LANGS = ['fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru'], ASIA_LANGS = ['ja', 'ko', 'zh', 'id', 'th'];
const ANY_LANG = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese', ko: 'Korean', 'zh-tw': 'Traditional Chinese', 'zh-cn': 'Simplified Chinese', id: 'Indonesian', th: 'Thai' };
function counterpart(l) { // a language code as printed or read -> the language whose sets hold that card ('' when unknown)
  l = String(l || '').toLowerCase().replace('_', '-'); const b = l.slice(0, 2);
  if (b === 'en' || EU_LANGS.includes(b)) return 'en';
  if (b === 'zh' && !/^zh-(tw|hk|hant|mo)/.test(l) && LANGS.includes('zh-cn')) return 'zh-cn'; // Simplified Chinese has its own sets
  if (ASIA_LANGS.includes(b)) return LANGS.includes('ja') ? 'ja' : 'en';
  return '';
}
const langWord = l => ANY_LANG[l] || ANY_LANG[String(l).slice(0, 2)] || l;
// How many of the daily requests may go to prices of regular cards (the rest is for art cards).
const REGULAR_PRICES_PER_DAY = process.env.REGULAR_PRICES_PER_DAY !== undefined ? +process.env.REGULAR_PRICES_PER_DAY : 0; // 0 = no limit
const DAILY_REQUESTS = process.env.DAILY_REQUESTS !== undefined ? (+process.env.DAILY_REQUESTS || 0) : 0; // 0 = no daily limit
const REQUEST_DELAY_MS = process.env.REQUEST_DELAY_MS !== undefined ? +process.env.REQUEST_DELAY_MS : 2000; // pause between requests, 2 seconds by default
const PRICE_MAX_AGE_DAYS = +process.env.PRICE_MAX_AGE_DAYS || 30;
// The set list is checked at start and then every SETS_CHECK_HOURS (6); the older SETS_CHECK_DAYS still works.
const SETS_CHECK_HOURS = +process.env.SETS_CHECK_HOURS || (+process.env.SETS_CHECK_DAYS ? +process.env.SETS_CHECK_DAYS * 24 : 6);
const PRICE_HISTORY_DAILY_DAYS = process.env.PRICE_HISTORY_DAILY_DAYS !== undefined ? (+process.env.PRICE_HISTORY_DAILY_DAYS || 0) : 90; // 0 = keep every day
const RECENT_PRICE_MONTHS = process.env.RECENT_PRICE_MONTHS !== undefined ? (+process.env.RECENT_PRICE_MONTHS || 0) : 6; // 0 = off
const WISH_PRICE_DAYS = 0.9; // wished cards are priced again after this many days (a little under one, so the hourly run does not slip a day)
const PRICE_CANDIDATES = +process.env.PRICE_CANDIDATES || 2;
// Only sets released on or after this date are read. "any" (the default) reads every set, back to the 1996-1999 originals.
// ('0000' instead of '' so sets without a release date still count as "before" and are not asked for again and again.)
const MIN_SET_DATE = (v => !v || /^(any|all|none|0)$/i.test(v) ? '0000' : v)(String(process.env.MIN_SET_DATE || '').trim());
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
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
// The Android app: /android.apk sends the phone to the newest build, /android.json tells the app the newest version.
const APK_BASE = process.env.ANDROID_APP === '0' ? '' : String(process.env.ANDROID_RELEASE || 'https://github.com/Puppetchu/dex-art-tracker/releases/latest/download/').replace(/\/*$/, '/'); // on by default (reverse proxy: use X-Forwarded-For / -Proto). 0 = off

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

