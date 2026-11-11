'use strict';
// Dex Art Tracker server, part 9 of 9: the web server: every address and the background work.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
// ---------- HTTP ----------
// OpenCV (the video scan's card finder) builds some of its functions from text when it starts, which needs
// 'unsafe-eval'. Scripts written into the page (inline scripts, onerror= and the like) stay blocked all the same.
const CSP_SCRIPT_EXTRA = "'unsafe-eval' 'wasm-unsafe-eval'";
const APP_FILES = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json', 'no-cache'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png', 'public, max-age=604800'],
  '/icons/maskable-512.png': ['icons/maskable-512.png', 'image/png', 'public, max-age=604800'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png', 'public, max-age=604800'],
  '/favicon.ico': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
  '/cardfind.js': ['cardfind.js', 'text/javascript; charset=utf-8', 'no-cache'], // the card finder of the video scan
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', 'no-cache'],   // the page's script
  '/app.css': ['app.css', 'text/css; charset=utf-8', 'no-cache'],        // and its styles
};
// OpenCV for the page's video scan (the same build the server uses), sent compressed: about 11 MB, kept by the phone.
let cvGz = null;
function sendOpenCV(req, res) {
  const file = path.join(__dirname, 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js');
  try {
    const head = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=2592000, immutable', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      if (!cvGz) cvGz = require('zlib').gzipSync(fs.readFileSync(file), { level: 6 });
      res.writeHead(200, Object.assign(head, { 'Content-Encoding': 'gzip', 'Content-Length': cvGz.length }));
      return res.end(cvGz);
    }
    res.writeHead(200, head); fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(404); res.end('Not found'); }
}
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
  let p = u.pathname, adminPath = false;
  try {
    // / is the page for everyone (trainers log in there). /admin/ is the same page for the admin: the only place
    // where the admin can log in, so a reverse proxy can put /admin/ behind its own login.
    if (p === '/admin') { res.writeHead(301, { Location: p + '/' + u.search }); return res.end(); }
    // /view/ was the address of the main page until 2.5: old links and the first Android app are sent on to /
    if (p === '/view' || p === '/view/') { res.writeHead(301, { Location: '/' + u.search }); return res.end(); }
    else if (p.startsWith('/admin/')) { p = p.slice(6); adminPath = true; }
    // Stored pictures: /img/c/<card id>/<low|high> and /img/s/<set id>. Looked up in the index, never by path.
    if (req.method === 'GET' && p.startsWith('/img/')) {
      const m = /^\/img\/(c|s)\/([^/]{1,200})(?:\/(low|high))?$/.exec(p);
      let id = null; try { id = m && decodeURIComponent(m[2]); } catch (e) { id = null; }
      const rec = id && (m[1] === 'c' ? imgs.c[id] : imgs.s[id]);
      if (!rec || !Object.prototype.hasOwnProperty.call(m[1] === 'c' ? imgs.c : imgs.s, id)) { res.writeHead(404); return res.end('Not found'); }
      return sendImage(res, m[1] === 'c' ? imgPath('c', id, m[3] === 'high' && rec.h ? 'high' : 'low') : imgPath('s', id));
    }
    // The Android app: the download (the newest release build) and the newest version number for the app's update check.
    if (req.method === 'GET' && (p === '/android.apk' || p === '/android.json')) {
      if (!APK_BASE) return sendJSON(res, 404, { error: 'The Android app is not offered on this server' });
      if (p === '/android.apk') { res.writeHead(302, { Location: APK_BASE + 'dex-art.apk', 'Cache-Control': 'no-cache' }); return res.end(); }
      const v = await apkVersion();
      return v ? sendJSON(res, 200, Object.assign({ apk: 'android.apk' }, v)) : sendJSON(res, 503, { error: 'The newest app version could not be read' });
    }
    // App files for installing the page as an app (fixed list, read from the public folder).
    if (req.method === 'GET' && p === '/vendor/opencv.js') return sendOpenCV(req, res);
    if (req.method === 'GET' && APP_FILES[p]) {
      const [file, type, cache] = APP_FILES[p];
      return fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
        res.end(buf);
      });
    }
    const sess = sessionOf(req, adminPath); // on /admin/ only the admin login counts, elsewhere only trainers
    const authed = !!sess, isAdmin = !!sess && sess.acc === ADMIN_ID;
    const ip = clientIp(req);
    if (p.startsWith('/api/')) proxySeen[req.headers['x-forwarded-for'] ? 'with' : 'without']++;
    if (!authed && limited(ip)) { res.writeHead(429); return res.end('Slow down'); }
    // Which dex is looked at: ?dex=<account id>, else your own one when logged in, else the main one.
    const dexQ = u.searchParams.get('dex');
    const dexId = accById(dexQ) ? dexQ : (sess && accById(sess.acc) ? sess.acc : firstDex());
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      // Content security policy: scripts only from this server (plus the one settings script, by its one-time number),
      // so text that ends up in the page (a card or trainer name) can never run as a script. Pictures may come from
      // any https address (the card picture sites). OpenCV for the video scan needs to compile its own code.
      const nonce = crypto.randomBytes(16).toString('base64');
      const csp = ["default-src 'self'", "script-src 'self' 'nonce-" + nonce + "' " + CSP_SCRIPT_EXTRA, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
        "connect-src 'self' data:", "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': csp });
      return res.end(indexHtml(adminPath ? (isAdmin ? 'admin' : 'adminlogin') : (sess && dexId && sess.acc === dexId ? 'full' : 'ro'), dexId, sess, nonce));
    }
    if (req.method === 'GET' && p === '/api/accounts') return sendJSON(res, 200, publicAccounts());
    // Every dex's owned cards and wish list, for the trade matches.
    if (req.method === 'GET' && p === '/api/trades') return sendJSON(res, 200, tradeData());
    if (req.method === 'GET' && p === '/data/cards.json') return sendCompressed(req, res, CARDS_FILE);
    if (req.method === 'GET' && p === '/data/artists.json') { if (!fs.existsSync(ARTISTS_OUT)) exportArtists(); return sendCompressed(req, res, ARTISTS_OUT); }
    if (req.method === 'GET' && p === '/data/names.json') return sendFile(res, NAMES_FILE);
    if (req.method === 'GET' && p === '/api/status') return sendJSON(res, 200, authed ? status() : { count: lastExport.art, regular: lastExport.regular, running: false, backlog: 0, pricesDue: 0, sets: { scanned: lastExport.sets } });
    if (req.method === 'GET' && p === '/api/set') {
      const sid = u.searchParams.get('id') || '';
      const s = sid.startsWith('artist:') ? artistPayload(sid.slice(7)) : setPayload(sid);
      return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: sid.startsWith('artist:') ? 'unknown artist' : 'unknown set' });
    }
    if (req.method === 'GET' && p === '/api/state') return sendJSON(res, 200, (dexId && readJSON(stateFile(dexId))) || {});
    // Price history of up to 300 cards (the wish list graphs): { cur, h: { id: [[day, price], ...] } }
    if (req.method === 'GET' && p === '/api/prices') {
      const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 300), out = {}, k = PRICE_CUR === 'us' ? 2 : 1;
      for (const id of ids) { const h = priceHist[id]; if (h) out[id] = h.filter(r => r[k] != null).map(r => [r[0], r[k]]); }
      return sendJSON(res, 200, { cur: PRICE_CUR, h: out });
    }
    if (req.method === 'GET' && p === '/api/admin/settings') {
      if (!isAdmin) return sendJSON(res, authed ? 403 : 401, { error: 'Only the admin can do that' });
      return sendJSON(res, 200, {
        fields: SETTINGS.map(f => {
          const secret = f.type === 'secret', has = k => Object.prototype.hasOwnProperty.call(pageSettings, k);
          return Object.assign({}, f, {
            value: secret ? undefined : (has(f.key) ? pageSettings[f.key] : ''),
            set: secret ? has(f.key) && !!pageSettings[f.key] : undefined,
            container: secret ? (ENV0[f.key] ? 'set' : null) : (ENV0[f.key] != null && ENV0[f.key] !== '' ? ENV0[f.key] : null),
          });
        }),
        models: MODEL_SUGGESTIONS, restarts: process.env.DEX_SUPERVISED === '1', notes: [proxyNote()].filter(Boolean),
      });
    }
    if (req.method === 'GET' && p === '/api/admin/accounts') {
      if (!isAdmin) return sendJSON(res, authed ? 403 : 401, { error: 'Only the admin can do that' });
      return sendJSON(res, 200, { aiSetUp: !!AI_CFG, list: accounts.list.map(a => ({ id: a.id, name: a.name, created: a.created, self: a.self ? 1 : undefined, ai: aiAllowed(a) })) });
    }
    if (req.method === 'GET' && p === '/api/lang-check') {
      if (!isAdmin) return sendJSON(res, 401, { error: 'login as the admin required' });
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
      const given = String(b.password || '');
      const asAdmin = adminPath; // the login box on /admin/ is the admin login; everywhere else a trainer's
      const acc = asAdmin ? null : accById(b.dex);
      if (!asAdmin && !acc) return sendJSON(res, 404, { error: 'That dex does not exist' });
      if (asAdmin ? !checkAdmin(given) : !checkPw(acc, given)) {
        const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 15 * 60000 ? { n: f.n + 1, t: Date.now() } : { n: 1, t: Date.now() });
        await sleep(1000);
        return sendJSON(res, 401, { error: 'Wrong password' });
      }
      fails.delete(ip);
      const tok = crypto.randomBytes(24).toString('base64url');
      sessions[hashTok(tok)] = { exp: Date.now() + SESSION_MS, acc: asAdmin ? ADMIN_ID : acc.id }; saveSessions();
      if (asAdmin) log('admin logged in');
      res.setHeader('Set-Cookie', cookie(req, asAdmin, tok, SESSION_MS / 1000));
      return sendJSON(res, 200, { ok: true, admin: asAdmin });
    }
    if (req.method === 'POST' && p === '/api/signup') {
      if (!SIGNUP || adminPath) return sendJSON(res, 403, { error: 'Signing up is switched off on this server. Ask the admin for a dex.' });
      const b = JSON.parse(await readBody(req, 1e4));
      if (b.website) return sendJSON(res, 400, { error: 'Could not sign up' }); // a field people never see: only bots fill it in
      const day = new Date().toISOString().slice(0, 10);
      if (signups.day !== day) { signups.day = day; signups.n = 0; signups.ip.clear(); }
      if ((signups.ip.get(ip) || 0) >= 3) return sendJSON(res, 429, { error: 'Too many new trainers from this connection today. Try again tomorrow.' });
      if (signups.n >= SIGNUP_PER_DAY || accounts.list.length >= MAX_TRAINERS) return sendJSON(res, 429, { error: 'No new trainers can sign up right now. Try again later or ask the admin.' });
      const pw = String(b.password || '');
      if (pw.length < 8) return sendJSON(res, 400, { error: 'A password needs at least 8 characters' });
      let name; try { name = cleanName(b.name); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      const acc = { id: crypto.randomBytes(6).toString('hex'), name, created: new Date().toISOString(), self: 1, ai: false };
      setPw(acc, pw); accounts.list.push(acc); saveAccounts();
      signups.n++; signups.ip.set(ip, (signups.ip.get(ip) || 0) + 1);
      const tok = crypto.randomBytes(24).toString('base64url');
      sessions[hashTok(tok)] = { exp: Date.now() + SESSION_MS, acc: acc.id }; saveSessions();
      res.setHeader('Set-Cookie', cookie(req, false, tok, SESSION_MS / 1000));
      log('new trainer signed up:', acc.name);
      return sendJSON(res, 200, { ok: true, id: acc.id, name: acc.name });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      const t = tokenOf(req, adminPath); if (t) { delete sessions[hashTok(t)]; saveSessions(); }
      res.setHeader('Set-Cookie', cookie(req, adminPath, '', 0));
      return sendJSON(res, 200, { ok: true });
    }
    // Getting the price of a card that has none works for everyone, also visitors of a dex (they are rate limited above)
    if (!authed && !(req.method === 'POST' && p === '/api/card/fetch')) return sendJSON(res, 401, { error: 'login required' });
    if (req.method === 'PUT' && p === '/api/state') {
      if (isAdmin) return sendJSON(res, 403, { error: 'The admin has no dex of its own' });
      if (dexQ && dexQ !== sess.acc) return sendJSON(res, 403, { error: 'You can only change your own dex' });
      const s = JSON.parse(await readBody(req, 5e6));
      if (!s || typeof s.own !== 'object' || Array.isArray(s.own)) return sendJSON(res, 400, { error: 'bad state' });
      const cards = s.cards && typeof s.cards === 'object' && !Array.isArray(s.cards) ? s.cards : {};
      const old = readJSON(stateFile(sess.acc)) || {};
      const added = addedTimes(old, cards);
      // wish lists: at most 50, each with a short name and at most 5000 cards
      const lists = !Array.isArray(s.lists) ? old.lists : s.lists.slice(0, 50).filter(l => l && typeof l === 'object').map((l, i) => ({
        id: String(l.id || 'w' + (i + 1)).slice(0, 24), name: String(l.name || 'Wish list').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Wish list',
        cards: (Array.isArray(l.cards) ? l.cards : []).slice(0, 5000).map(String).filter((x, j, a) => x.length <= 80 && a.indexOf(x) === j) }));
      writeJSON(stateFile(sess.acc), { own: s.own, cards, pick: s.pick || {}, lists, cur: PRICE_CUR, added });
      return sendJSON(res, 200, { ok: true, added });
    }
    // Every account owner can change their own trainer name.
    if (req.method === 'POST' && p === '/api/account/name') {
      const b = JSON.parse(await readBody(req, 1e4));
      const acc = accById(sess.acc);
      if (!acc) return sendJSON(res, 400, { error: 'The admin has no trainer name' });
      acc.name = cleanName(b.name, acc.id); saveAccounts();
      return sendJSON(res, 200, { ok: true, name: acc.name });
    }
    // Every account owner can change their own password (the old one is asked first).
    // Other devices logged in to this dex are logged out; this one stays logged in.
    if (req.method === 'POST' && p === '/api/account/password') {
      const b = JSON.parse(await readBody(req, 1e4));
      const acc = isAdmin ? null : accById(sess.acc);
      if (isAdmin && ADMIN_FIXED) return sendJSON(res, 409, { error: 'The admin password is set with ADMIN_PASSWORD in the container settings. Change it there.' });
      if (blocked(ip)) return sendJSON(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
      if (isAdmin ? !checkAdmin(String(b.old || '')) : !checkPw(acc, String(b.old || ''))) {
        const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 15 * 60000 ? { n: f.n + 1, t: Date.now() } : { n: 1, t: Date.now() });
        await sleep(1000);
        return sendJSON(res, 401, { error: 'The current password is wrong' });
      }
      const pw = String(b.password || '');
      if (pw.length < 8) return sendJSON(res, 400, { error: 'A password needs at least 8 characters' });
      if (isAdmin) setAdminPw(pw); else { setPw(acc, pw); saveAccounts(); }
      const mine = hashTok(tokenOf(req, adminPath)), who = isAdmin ? ADMIN_ID : acc.id;
      Object.keys(sessions).forEach(k => { if (sessions[k].acc === who && k !== mine) delete sessions[k]; }); saveSessions();
      log('password changed:', isAdmin ? 'admin' : acc.name);
      return sendJSON(res, 200, { ok: true });
    }
    // The admin creates accounts, gives them a new password and deletes them.
    if (req.method === 'POST' && p.startsWith('/api/admin/')) {
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the admin can do that' });
      const b = JSON.parse(await readBody(req, 1e4));
      // Settings: {values: {KEY: "value"}}; "" = back to the container's value; a key left out stays as it is.
      if (p === '/api/admin/settings') {
        const v = b && typeof b.values === 'object' && b.values ? b.values : {};
        const next = Object.assign({}, pageSettings);
        for (const f of SETTINGS) {
          if (!Object.prototype.hasOwnProperty.call(v, f.key)) continue;
          const x = v[f.key] == null ? '' : String(v[f.key]).trim();
          if (x === '') { delete next[f.key]; continue; }
          if (!settingOk(f, x)) return sendJSON(res, 400, { error: 'Not a valid choice for "' + f.label + '"' });
          next[f.key] = x;
        }
        writeJSON(SETTINGS_FILE, next); pageSettings = next;
        log('settings changed on the admin page:', Object.keys(v).filter(k => SETTINGS.some(f => f.key === k)).join(', ') || 'nothing');
        const restarts = process.env.DEX_SUPERVISED === '1';
        if (restarts) setTimeout(() => shutDown(75), 400);
        return sendJSON(res, 200, { ok: true, restarting: restarts });
      }
      const givenPw = String(b.password || '');
      if (givenPw && givenPw.length < 8) return sendJSON(res, 400, { error: 'A password needs at least 8 characters' });
      if (p === '/api/admin/accounts') {
        const acc = { id: crypto.randomBytes(6).toString('hex'), name: cleanName(b.name), created: new Date().toISOString(), ai: b.ai !== false };
        const pw = givenPw || newPw();
        setPw(acc, pw);
        accounts.list.push(acc); saveAccounts();
        log('account created:', acc.name);
        return sendJSON(res, 200, { ok: true, id: acc.id, name: acc.name, password: pw });
      }
      const acc = accById(b.id);
      if (!acc) return sendJSON(res, 404, { error: 'Unknown account' });
      if (p === '/api/admin/accounts/ai') { // AI scanning on or off for this trainer
        acc.ai = !!b.on; saveAccounts();
        log('AI scanning', acc.ai ? 'on' : 'off', 'for', acc.name);
        return sendJSON(res, 200, { ok: true, ai: acc.ai });
      }
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
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the admin can refresh the database' });
      if (DISABLE_REFRESH) return sendJSON(res, 409, { error: 'refresh disabled' });
      if (running) return sendJSON(res, 202, { started: false });
      if (Date.now() - lastManual < 600000) return sendJSON(res, 429, { error: 'wait a few minutes' });
      lastManual = Date.now();
      exclusive(manualRun);
      return sendJSON(res, 202, { started: true });
    }
    // Import: match the rows of a CSV export (Collectr and the like) to cards. The page adds them itself.
    if (req.method === 'POST' && p === '/api/import') {
      if (isAdmin) return sendJSON(res, 403, { error: 'The admin has no dex to import into' });
      const b = JSON.parse(await readBody(req, 6e6));
      try { return sendJSON(res, 200, importMatch(String(b.csv || ''))); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
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
    // A wish list as text for Cardmarket's "Add Deck List" (Wants): one card per line, "1 Persian GX Cat Walk Vengeance
    // Slash Back GX Unbroken Bonds": the name, the ability and attack names (that is how Cardmarket tells Pokémon cards
    // apart) and optionally the set. Cards whose attacks are not known yet are fetched first (at most 40 per export).
    if (req.method === 'POST' && p === '/api/cardmarket') {
      const b = JSON.parse(await readBody(req, 1e5));
      const allIds = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x, i, a) => a.indexOf(x) === i), ids = allIds.slice(0, 500);
      const withSet = b.sets !== false, idx = regIndex(), where = cardWhere();
      const get = id => (db.cards[id] && !db.cards[id].x ? db.cards[id] : idx.get(id));
      let fetched = 0, t0 = Date.now();
      const tidy = t => String(t).replace(/[\u2019\u2018]/g, "'").replace(/-(GX|EX|V|VMAX|VSTAR|V-UNION)\b/g, ' $1').replace(/\s+/g, ' ').trim();
      const lines = [], unsure = [];
      for (const id of ids) {
        let c = get(id); if (!c) continue;
        const en = langOf(id) === 'en', isPok = (c.d && c.d.length) || (where.get(id) && where.get(id)[1].d && where.get(id)[1].d.length);
        if (en && isPok && !c.atk && fetched < 40 && !DISABLE_REFRESH && Date.now() - t0 < 15000) { // the card service may be slow or away: then without attacks
          fetched++;
          const job = (db.cards[id] && !db.cards[id].x ? fetchCard(id, true) : priceRegular(id, idx, true)).then(() => true, () => false);
          const ok = await Promise.race([job, new Promise(r => setTimeout(() => r(false), Math.max(0, 15000 - (Date.now() - t0))))]);
          if (!ok) t0 = 0; // failed or too slow: the rest goes without attacks (a slow fetch still finishes in the background)
          c = get(id) || c;
        }
        const w = where.get(id), set = w ? db.sets[w[0]] : null;
        let name = tidy(c.n), line;
        if (en) line = '1 ' + name + (c.atk ? ' ' + c.atk.map(tidy).join(' ') : '') + (withSet && set ? ' ' + tidy(set.name) : '');
        else { // Cardmarket uses English names, also for Japanese and Chinese cards: the Pokémon's English name
          const dex = (c.d && c.d[0]) || (w && w[1].d && w[1].d[0]), en2 = dex && NM && NM.names && NM.names[dex];
          const suf = (/(VMAX|VSTAR|V-UNION|GX|EX|ex|V)\s*$/.exec(String(c.n)) || [])[1];
          line = '1 ' + (en2 ? en2 + (suf ? ' ' + suf : '') : name);
          unsure.push(line.slice(2) + ' (' + (set ? set.name : id) + ')');
        }
        if (en && isPok && !c.atk) unsure.push(name + ' (' + (set ? set.name : id) + '): attacks not known yet');
        lines.push(line);
      }
      if (fetched) persist(true);
      return sendJSON(res, 200, { text: lines.join('\n'), n: lines.length, left: allIds.length - ids.length, unsure });
    }
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
      try { return sendJSON(res, 200, await runScan(buf, isAdmin || aiAllowed(accById(sess.acc)))); }
      catch (e) { log('scan failed:', e.message); return sendJSON(res, 400, { error: /Cannot find module/i.test(e.message) ? 'Scanning is not fully installed on this server (' + (e.message.match(/'([^']+)'/) || [, 'a module'])[1] + ' is missing): rebuild the container with the current package.json' : 'Could not read that photo: ' + e.message.split('\n')[0] }); }
    }
    // Set a card's picture by hand (admin): a picture address, or empty to go back to automatic.
    if (req.method === 'POST' && p === '/api/card/picture') {
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the admin can change pictures' });
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
    // Set a set's picture (logo) by hand (admin): a picture address or an uploaded file; empty: back to the automatic one.
    if (req.method === 'POST' && p === '/api/set/picture') {
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the admin can change pictures' });
      const b = JSON.parse(await readBody(req, 22e6));
      const sid = String(b.id || ''), url = String(b.url || '').trim(), data = typeof b.data === 'string' ? b.data : '';
      if (!db.sets[sid]) return sendJSON(res, 404, { error: 'unknown set' });
      if (!url && !data) { // back to automatic: the stored picture goes, the server looks for one again
        delete imgs.s[sid]; delete imgs.fail['s:' + sid]; try { fs.unlinkSync(imgPath('s', sid)); } catch (e) { /* none */ }
        saveImgs(true); exportCards(); return sendJSON(res, 200, { ok: true });
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
      try {
        const base = await checkedImage(buf); // re-encoded: only the picture itself is kept
        writeAtomic(imgPath('s', sid), await base.resize({ height: LOGO_H, withoutEnlargement: true }).webp({ quality: 90 }).toBuffer());
      } catch (e) { return sendJSON(res, 400, { error: 'That is not a picture that can be used: ' + e.message }); }
      imgs.s[sid] = { v: Date.now().toString(36), t: new Date().toISOString(), m: 1 }; delete imgs.fail['s:' + sid]; saveImgs(true);
      exportCards();
      log('set picture set by hand:', db.sets[sid].name);
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/card/mark') {
      // The art list is shared by every dex, so only the admin changes it.
      if (!isAdmin) return sendJSON(res, 403, { error: 'Only the admin can change the art list' });
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

// Save what is still in memory before stopping (on "docker stop", and when restarting for new settings).
let stoppingNow = false;
function shutDown(code) {
  if (stoppingNow) return; stoppingNow = true;
  try { persist(true); } catch (e) { log('saving the database failed:', e.message); }
  try { saveImgs(true); } catch (e) { /* nothing to save */ }
  try { saveHist(false); } catch (e) { /* nothing to save */ }
  if (code === 75) log('restarting to apply the new settings');
  server.close(); setTimeout(() => process.exit(code), 200);
}
process.on('SIGTERM', () => shutDown(0));
process.on('SIGINT', () => shutDown(0));

server.listen(PORT, () => {
  log('listening on', PORT, '| data dir', DATA_DIR, '|', DAILY_REQUESTS ? 'up to ' + DAILY_REQUESTS + ' requests per day' : 'no daily limit', '|', REQUEST_DELAY_MS / 1000 + ' s between requests');
  try { exportCards(); } catch (e) { log('export failed:', e.message); }
  tick();
  setInterval(tick, 3600 * 1000);
});
