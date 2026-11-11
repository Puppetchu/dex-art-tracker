'use strict';
// Dex Art Tracker server, part 8 of 9: accounts, logins, dexes and wish lists.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
// ---------- accounts and login ----------
// Every account (trainer) has its own dex; its ticks are stored in states/<id>.json. A login only opens the
// dex it was made on. The admin is not a trainer and has no dex: it logs in on /admin/ only, with its own
// cookie that is only sent to /admin/ (so a reverse proxy can put /admin/ behind its own login). Its password
// is ADMIN_PASSWORD, or the one in admin.json. The admin adds trainers, changes the settings and the shared
// card list (art cards, pictures).
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
const STATES_DIR = path.join(DATA_DIR, 'states');
const ADMIN_ID = '@admin';
// May this trainer's scans use the AI reader (it costs money per scan)? Set per account by the admin; when not set:
// yes for accounts the admin made, no for accounts that signed up themselves.
const aiAllowed = acc => !!acc && (acc.ai === undefined ? !acc.self : !!acc.ai);
// Signing up: a visitor makes their own trainer (dex). Limits against floods: 3 per address per day, SIGNUP_PER_DAY in all, MAX_TRAINERS.
const SIGNUP = process.env.SIGNUP !== '0', SIGNUP_PER_DAY = +process.env.SIGNUP_PER_DAY || 20, MAX_TRAINERS = +process.env.MAX_TRAINERS || 200;
const signups = { day: '', n: 0, ip: new Map() };
fs.mkdirSync(STATES_DIR, { recursive: true });
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// The admin password: ADMIN_PASSWORD if set (then it can only be changed there). Otherwise admin.json:
// first a generated password in plain text, and once changed on the page a salted hash ({salt, hash}).
const ADMIN_FIXED = !!process.env.ADMIN_PASSWORD;
let adminPw = String(process.env.ADMIN_PASSWORD || ''), adminHash = null;
if (ADMIN_FIXED) log('admin password: set by ADMIN_PASSWORD (log in on /admin/)');
else {
  const a = readJSON(ADMIN_FILE) || {};
  if (a.hash && a.salt) { adminHash = { salt: a.salt, hash: a.hash }; log('admin password: changed on the page (stored hashed in admin.json); log in on /admin/'); }
  else {
    adminPw = a.password || '';
    if (!adminPw) { adminPw = crypto.randomBytes(9).toString('base64url'); writeJSON(ADMIN_FILE, { password: adminPw }); }
    log('ADMIN PASSWORD (generated; also saved in admin.json in the data folder; set ADMIN_PASSWORD to choose your own):', adminPw, '- log in on /admin/');
  }
}
const accounts = readJSON(ACC_FILE) || {};
accounts.list = Array.isArray(accounts.list) ? accounts.list : [];
function saveAccounts() { writeJSON(ACC_FILE, accounts); }
// One-time: the admin used to have a dex of its own ("Owner", ticks in state.json). It no longer has one:
// the account goes and its ticks are kept aside as removed-owner-dex.json (delete that file when you like).
if (accounts.list.some(a => a.id === 'main') || fs.existsSync(STATE_FILE)) {
  accounts.list = accounts.list.filter(a => a.id !== 'main');
  try { fs.renameSync(STATE_FILE, path.join(DATA_DIR, 'removed-owner-dex.json')); log('the old Owner dex was removed (its ticks are in removed-owner-dex.json)'); } catch (e) { /* none */ }
}
saveAccounts();
const accById = id => accounts.list.find(a => a.id === String(id || '')) || null;
const publicAccounts = () => accounts.list.map(a => ({ id: a.id, name: a.name }));
const stateFile = id => path.join(STATES_DIR, id + '.json');
const firstDex = () => (accounts.list[0] && accounts.list[0].id) || null;
function allStates() {
  return accounts.list.map(a => { const s = readJSON(stateFile(a.id)) || {}; return { own: s.own || {}, cards: s.cards || {}, pick: s.pick || {}, lists: s.lists }; });
}
// When each owned card was added (for the Showcase's "time added" order): a new card gets the time of this save.
function addedTimes(old, cards) {
  const was = old.added && typeof old.added === 'object' ? old.added : {}, oc = old.cards || {}, out = {}, t = new Date().toISOString();
  for (const id of Object.keys(cards)) {
    if (!cards[id]) continue;
    if (!oc[id]) out[id] = t; else if (was[id]) out[id] = was[id]; // owned from before the times were kept: no time
  }
  return out;
}
// Dexes written by earlier versions, once: the wishes kept in pick and wish become the first wish list, and the old
// history list (the last 300 cards added) gives its times to the cards before it goes.
function migrateStates() {
  for (const a of accounts.list) {
    const s = readJSON(stateFile(a.id)); if (!s) continue;
    let ch = false; const cards = s.cards || {};
    if (!Array.isArray(s.lists)) {
      const ids = [];
      Object.values(s.pick || {}).forEach(id => { id = String(id); if (id && !cards[id] && !ids.includes(id)) ids.push(id); });
      Object.keys(s.wish || {}).forEach(id => { if (s.wish[id] && !cards[id] && !ids.includes(id)) ids.push(id); });
      s.lists = [{ id: 'w1', name: 'Wish list', cards: ids }]; ch = true;
    }
    if (s.wish) { delete s.wish; ch = true; }
    if (s.hist) {
      s.added = s.added && typeof s.added === 'object' ? s.added : {};
      (Array.isArray(s.hist) ? s.hist : []).forEach(h => { if (h && h.id && cards[h.id] && !s.added[h.id]) s.added[h.id] = h.t; });
      delete s.hist; ch = true;
    }
    if (ch) writeJSON(stateFile(a.id), s);
  }
}
migrateStates();
// The wish lists of a dex (lists: [{ id, name, cards: [card ids] }]): every card on any list, any number per
// Pokémon, leaving out cards owned by now.
function wishOf(s) {
  const cards = s.cards || {}, out = [], seen = new Set();
  (Array.isArray(s.lists) ? s.lists : []).forEach(l => (Array.isArray(l.cards) ? l.cards : []).forEach(id => { id = String(id); if (!cards[id] && !seen.has(id)) { seen.add(id); out.push({ dex: null, id }); } }));
  return out;
}
function tradeData() {
  return accounts.list.map(a => {
    const s = readJSON(stateFile(a.id)) || {}, cards = s.cards || {};
    return { id: a.id, name: a.name, cards: Object.keys(cards).filter(id => cards[id]), wish: wishOf(s) };
  });
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32);
function checkAdmin(pw) {
  if (adminHash) return crypto.timingSafeEqual(hashPw(pw, adminHash.salt), Buffer.from(adminHash.hash, 'hex'));
  return !!adminPw && sameText(pw, adminPw);
}
function setAdminPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  adminHash = { salt, hash: hashPw(pw, salt).toString('hex') }; adminPw = ''; writeJSON(ADMIN_FILE, adminHash);
}
function checkPw(acc, pw) {
  if (!acc.hash || !acc.salt) return false;
  return crypto.timingSafeEqual(hashPw(pw, acc.salt), Buffer.from(acc.hash, 'hex'));
}
function setPw(acc, pw) {
  const salt = crypto.randomBytes(16).toString('hex'), hash = hashPw(pw, salt).toString('hex');
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
for (const k of Object.keys(sessions)) if (typeof sessions[k] !== 'object' || sessions[k].acc === 'main') delete sessions[k]; // logins of the old Owner dex end
if (!fs.existsSync(path.join(DATA_DIR, '.admin-path'))) { // one-time: admin logins from before /admin/ end (log in again on /admin/)
  for (const k of Object.keys(sessions)) if (sessions[k].acc === ADMIN_ID) delete sessions[k];
  fs.writeFileSync(path.join(DATA_DIR, '.admin-path'), '1'); saveSessions();
}
const SESSION_MS = 30 * 86400000;
function saveSessions() { const n = Date.now(); Object.keys(sessions).forEach(k => { if (sessions[k].exp < n) delete sessions[k]; }); writeJSON(SESS_FILE, sessions); }
function dropSessions(acc) { Object.keys(sessions).forEach(k => { if (sessions[k].acc === acc) delete sessions[k]; }); saveSessions(); }
// Two cookies: dex_session (a trainer, every page) and dex_admin (the admin, only sent to /admin/).
const cookieName = admin => admin ? 'dex_admin' : 'dex_session';
const tokenOf = (req, admin) => { const n = cookieName(admin) + '='; const m = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(n)); return m ? m.slice(n.length) : ''; };
const hashTok = t => crypto.createHash('sha256').update(t).digest('hex');
function sessionOf(req, admin) {
  const t = tokenOf(req, admin); if (!t) return null;
  const s = sessions[hashTok(t)];
  if (!s || s.exp <= Date.now()) return null;
  return (admin ? s.acc === ADMIN_ID : !!accById(s.acc)) ? s : null;
}
// Behind a reverse proxy the visitor's address is the one the proxy adds at the END of X-Forwarded-For:
// anything before it was sent by the visitor and can be made up (which would get around the
// wrong-password limit). PROXY_HOPS = number of proxies in a row in front of this server (default 1).
const PROXY_HOPS = Math.max(1, +process.env.PROXY_HOPS || 1);
function fromProxy(v) { const l = String(v || '').split(',').map(x => x.trim()).filter(Boolean); return l.length >= PROXY_HOPS ? l[l.length - PROXY_HOPS] : ''; }
const proxySeen = { with: 0, without: 0 }; // page requests with and without a proxy's X-Forwarded-For header
function clientIp(req) { const f = TRUST_PROXY && fromProxy(req.headers['x-forwarded-for']); return f || req.socket.remoteAddress || ''; }
// A note for the admin page when the setting does not fit what the requests show.
function proxyNote() {
  const n = proxySeen.with + proxySeen.without; if (n < 5) return '';
  if (!TRUST_PROXY && proxySeen.with > n * 0.8) return 'Requests arrive through a reverse proxy, but "Behind a reverse proxy" is off: all visitors count as one address, so the limits for sign-ups and wrong passwords hit everyone at once. Switch it on.';
  if (TRUST_PROXY && proxySeen.without > n * 0.8) return 'Requests arrive without a proxy header, but "Behind a reverse proxy" is on: a visitor could then make up an address to get around the limits. Switch it off if the server is reached directly.';
  return '';
}
const isHttps = req => TRUST_PROXY && fromProxy(req.headers['x-forwarded-proto']) === 'https';
const cookie = (req, admin, v, age) => cookieName(admin) + '=' + v + '; HttpOnly; SameSite=Strict; Path=' + (admin ? '/admin/' : '/') + '; Max-Age=' + age + (isHttps(req) ? '; Secure' : '');
const fails = new Map(); // ip -> {n, t}: wrong passwords
const blocked = ip => { const f = fails.get(ip); return !!f && Date.now() - f.t < 15 * 60000 && f.n >= 8; };
const hits = new Map();
const limited = ip => { const n = Date.now(), h = hits.get(ip); if (!h || n - h.t > 60000) { hits.set(ip, { t: n, n: 1 }); return false; } return ++h.n > 600; };

let apkInfo = null, apkAt = 0;
async function apkVersion() { // version.json of the release, read at most every 30 minutes
  if (apkInfo && Date.now() - apkAt < 30 * 60000) return apkInfo;
  try {
    const r = await fetch(APK_BASE + 'version.json', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'dex-art-tracker' } });
    const j = r.ok ? JSON.parse((await r.text()).slice(0, 2000)) : null;
    if (j && Number.isInteger(j.code) && j.code > 0) apkInfo = { code: j.code, name: String(j.name || '').slice(0, 20), built: String(j.built || '').slice(0, 30) };
  } catch (e) { log('android app version not readable:', e.message); }
  apkAt = Date.now();
  return apkInfo;
}
// mode: 'full' (logged in to this dex), 'ro' (view only, with a login link), 'admin' (the admin: views every dex,
// owns none), 'adminlogin' (/admin/ before the admin logged in)
function indexHtml(mode, dexId, sess, nonce) {
  let h = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const hide = 'window.DEX_HIDE_VALUE=' + (mode !== 'admin' && !SHOW_VALUE_PUBLIC) + ';';
  const me = sess ? (sess.acc === ADMIN_ID ? { id: ADMIN_ID, name: 'Admin', admin: true } : accById(sess.acc)) : null;
  const cfg = { dex: dexId, accounts: publicAccounts(), me: me ? { id: me.id, name: me.name, admin: me.id === ADMIN_ID } : null };
  const inj = 'window.DEX_CUR=' + JSON.stringify(PRICE_CUR) + ';' + (mode === 'full' ? 'window.DEX_AUTH=true;' : 'window.DEX_READONLY=true;' + hide + (mode === 'ro' || mode === 'adminlogin' ? 'window.DEX_LOGIN=true;' : ''))
    + (mode === 'admin' || mode === 'adminlogin' ? 'window.DEX_ADMINPATH=true;' : '') + (APK_BASE ? 'window.DEX_APK=true;' : '') + (SIGNUP && mode !== 'admin' && mode !== 'adminlogin' ? 'window.DEX_SIGNUP=true;' : '')
    + 'window.DEX_CFG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';';
  return h.replace('<!--DEX_MODE-->', '<script nonce="' + nonce + '">' + inj + '</script>'); // the only script written into the page: the policy lets it run by its one-time number
}
