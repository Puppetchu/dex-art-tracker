'use strict';
// Dex Art Tracker server, part 5 of 9: pictures: pokemontcg.io lookups and the pictures stored on the server.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
// ---------- pictures from pokemontcg.io ----------
// Cards the page shows that have no TCGdex picture, promo sets first, then newest sets. English only:
// pokemontcg.io has no Japanese cards. A card without a result is asked about again after 30 days.
function picsNeeded() {
  const out = [];
  const sets = Object.entries(db.sets).filter(([, s]) => s.scan && (!s.lang || s.lang === 'en'))
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
//  - Custom picture addresses (admin) may be any https site, but never a private, local or
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
  if (langOf(sid) === 'en') l.push('https://images.pokemontcg.io/' + encodeURIComponent(ptcgSetId(sid)) + '/logo.png');
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
