'use strict';
// Dex Art Tracker server, part 6 of 9: card scanning.
// The parts are loaded in order by ../server.js and share one scope: a function or value defined in one part
// can be used in the others.
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
  await ocr.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '300' }); // sparse text: lines anywhere in the area
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
const cardfind = require('./public/cardfind.js'); // the card finder, shared with the page's video scan
const { orderCorners, dist } = cardfind;
// Rectangles with card proportions, grouped: a card, its inner picture panel and its sleeve are one group.
async function cardOutlines(rgba, W, H) {
  const { cv } = await cvReady();
  return cardfind.findCards(cv, rgba, W, H, MAX_CARDS); // the same finder runs on the phone (public/cardfind.js)
}
// The card inside four corners, straightened to CARD_W x CARD_H (with 4.5% room around it).
async function straighten(rgba, W, H, q, grow) {
  let cv;
  try { ({ cv } = await cvReady()); }
  catch (e) { // no OpenCV: cut the (upright) box out without correcting perspective
    const xs = q.pts.map(z => z.x), ys = q.pts.map(z => z.y);
    const left = Math.max(0, Math.floor(Math.min(...xs))), top = Math.max(0, Math.floor(Math.min(...ys)));
    const width = Math.min(W - left, Math.ceil(Math.max(...xs)) - left), height = Math.min(H - top, Math.ceil(Math.max(...ys)) - top);
    return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: W, height: H, channels: 4 } })
      .extract({ left, top, width, height }).resize(CARD_W, CARD_H, { fit: 'fill' }).removeAlpha().png().toBuffer();
  }
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
  gemini: { model: 'gemini-flash-latest', backup: 'gemini-flash-lite-latest', url: 'https://generativelanguage.googleapis.com/v1beta' },
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
// a second model to use when the first is busy or out of quota (comma-separated for more; "none" for none)
if (AI) AI.backup = String(process.env.SCAN_AI_BACKUP_MODEL || AI_DEFAULTS[AI.name].backup || '').split(',').map(x => x.trim()).filter(x => x && x !== 'none' && x !== AI.model);
const AI_CFG = AI; // the AI reader as set up (scanPhoto has its own AI: empty for trainers without AI scanning)
if (AI) log('scanning: cards are read by ' + AI.name + ' (' + AI.model + (AI.backup.length ? ', backup ' + AI.backup.join(', ') : '') + ')' + (AI.key || AI.name === 'local' ? '' : ' - SCAN_AI_KEY is not set'));

const AI_FIELDS = '"name": the card name exactly as printed at the top, with suffixes like ex, V, VMAX, VSTAR or GX (for a Trainer or Energy card: its title); '
  + '"number": the collector number exactly as printed, usually small at the bottom left or bottom right, for example "201/198", "TG05/TG30", "GG09/GG70", "SWSH050" or "050", or null if you cannot read it; '
  + '"set_code": the short set code printed at the bottom left next to the regulation mark and the number on newer cards, for example "PAL", "SVI", "MEW", "PFL" or "TEF" (not the language letters such as EN or JP), or null if there is none; '
  + '"set": the name of the expansion the card is from, if the set symbol, set code or number tells you (for example "Paldea Evolved" or "Base Set"), or null; '
  + '"pokemon": the English name of the Pokémon on the card (translate it if the card is not in English), or null; '
  + '"language": the language code of the card text: en, fr, de, es, it, pt, nl, pl, ru, ja, ko, zh-cn (Simplified Chinese), zh-tw (Traditional Chinese), id or th. '
  + 'Copy the number character by character: do not guess digits you cannot see';
const AI_ONE = 'This is a photo of one Pokémon Trading Card Game card. It may be in a plastic sleeve, slightly blurry, shiny or upside down. '
  + 'Read what is printed on it. Reply with only one JSON object and nothing else: {' + AI_FIELDS + '}.';
const AI_MANY = 'This photo shows one or more Pokémon Trading Card Game cards. Some may be in sleeves, blurry, shiny or upside down. '
  + 'Only include cards that are completely or almost completely in the photo: leave out cards that are cut off at the edge of the photo, so a single card photo gives one card. '
  + 'Read each card. Reply with only JSON and nothing else: {"cards": [ one object per card, from top left to bottom right, each {' + AI_FIELDS + '} ]}.';

function aiJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('the AI did not answer with JSON');
  return JSON.parse(t.slice(a, b + 1));
}
async function aiAskOnce(jpeg, prompt, model) {
  const b64 = jpeg.toString('base64'), dataUrl = 'data:image/jpeg;base64,' + b64;
  const opts = (headers, body) => ({ method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': 'dex-art-tracker' }, headers), body: JSON.stringify(body), signal: AbortSignal.timeout(AI.timeout) });
  let r, j;
  if (AI.name === 'gemini') {
    r = await fetch(AI.url + '/models/' + encodeURIComponent(model) + ':generateContent', opts({ 'x-goog-api-key': AI.key },
      { contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }], generationConfig: { responseMimeType: 'application/json' } }));
    j = await r.json().catch(() => ({}));
    if (!r.ok) throw aiErr(r.status, 'Gemini: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
    return ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('');
  }
  if (AI.name === 'claude') {
    r = await fetch(AI.url + '/messages', opts({ 'x-api-key': AI.key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 600, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, { type: 'text', text: prompt }] }] }));
    j = await r.json().catch(() => ({}));
    if (!r.ok) throw aiErr(r.status, 'Claude: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  }
  // OpenAI, OpenRouter, Mistral and local servers: the OpenAI-style chat completions request
  // OpenAI (also through OpenRouter) looks at a smaller copy unless asked for "high" detail: the card number is small print
  const image = AI.name === 'mistral' ? dataUrl : (AI.name === 'openai' || AI.name === 'openrouter' ? { url: dataUrl, detail: 'high' } : { url: dataUrl });
  const headers = AI.key ? { Authorization: 'Bearer ' + AI.key } : {};
  if (AI.name === 'openrouter') Object.assign(headers, { 'X-Title': 'Dex Art Tracker' });
  const req = { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: image }] }] };
  if (AI.name === 'openai') req.response_format = { type: 'json_object' }; // always a JSON answer
  r = await fetch(AI.url + '/chat/completions', opts(headers, req));
  j = await r.json().catch(() => ({}));
  if (!r.ok) throw aiErr(r.status, AI.name + ': ' + ((j.error && (j.error.message || j.error)) || 'HTTP ' + r.status));
  const c = ((j.choices || [])[0] || {}).message || {};
  return Array.isArray(c.content) ? c.content.map(p => p.text || '').join('') : String(c.content || '');
}
function aiErr(status, msg) {
  const e = new Error(msg); e.status = status;
  // busy for a moment (worth trying again) versus out of quota for the day (try the backup model straight away)
  e.busy = (status === 429 || status >= 500 || /high demand|overloaded|unavailable|try again/i.test(msg)) && !/quota|exhausted|per day|billing/i.test(msg);
  e.quota = status === 429 && !e.busy;
  return e;
}
// Asks the chosen model; when it is busy it tries again twice (after 2 and 5 seconds),
// then the backup model(s) from SCAN_AI_BACKUP_MODEL.
async function aiAsk(jpeg, prompt) {
  let last;
  for (const model of [AI.model, ...AI.backup]) {
    for (const wait of [0, 2000, 5000]) {
      if (wait) await sleep(wait);
      try {
        const out = await aiAskOnce(jpeg, prompt, model);
        if (model !== AI.model) slog('AI: answered by backup model', model);
        return out;
      } catch (e) {
        last = e;
        if (!e.busy) break; // a wrong key, unknown model or used-up quota: waiting will not help
        slog('AI:', model, 'is busy', wait ? '(again)' : '');
      }
    }
    if (last && !last.busy && !last.quota && !(last.status === 404)) throw last; // e.g. a wrong key: the backup would fail too
  }
  throw last;
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
  const code = String(o.set_code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
  const setName = SET_CODES[code] || (o.set ? String(o.set).slice(0, 60) : '');
  const printed = String(o.language || '').toLowerCase().slice(0, 7), lang = counterpart(printed); // a French card is looked up as the English one
  const note = lang && printed.slice(0, 2) !== lang.slice(0, 2) ? langWord(printed) + ' card, found as the ' + langWord(lang) + ' print' : '';
  return { words, num, ai: true, set: setName ? setWords(setName) : '', setByCode: !!SET_CODES[code], lang, said: [name, raw, code || o.set, note].filter(Boolean).join(' · ') };
}
async function aiReadCard(card) { // one straightened card
  const jpeg = await sharp(card).resize({ width: 1024 }).jpeg({ quality: 90 }).toBuffer(); // sharp enough for the small print
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
  // the set the AI read (its set code is printed on the card, so it counts most; a set name it recognised counts less)
  let setHit = 0;
  if (read.set) {
    const sw = x.sw || (x.sw = setWords(x.s.name));
    if (sw === read.set) setHit = read.setByCode ? 5 : 3;
    else if (sw.includes(read.set) || read.set.includes(sw)) setHit = read.setByCode ? 3 : 1.5;
  }
  // the card's language: an English card is not the Japanese print of the same card, and the other way round
  const sl = x.s.lang || 'en', rl = read.lang || ''; // read.lang is already the counterpart (en, ja or zh-cn)
  const langHit = !rl ? 0 : (sl === rl ? 1 : -4);
  return { numHit, totHit, nameHit: Math.max(0, nameHit), dexHit, setHit, text: (numHit ? 4 : 0) + (totHit ? 2 : 0) + Math.max(0, nameHit) * 3 + dexHit * 1.5 + setHit + langHit };
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
    why: [x.numHit ? 'number' : null, x.totHit ? 'set size' : null, x.setHit >= 3 ? 'set' : null, x.nameHit >= 0.6 ? 'name' : (x.dexHit >= 0.6 ? 'pokémon' : null), x.pic != null && x.pic > 0.7 ? 'picture' : null].filter(Boolean),
    sure: x.score >= best - 0.01 && x.score >= 7 && best - second >= 2 ? 1 : 0,
  });
}
const useful = m => m.list.length && (m.list[0].numHit || m.list[0].nameHit >= 0.6 || m.list[0].dexHit >= 0.6 || (m.list[0].pic != null && m.list[0].pic > 0.6));
let cvMissingLogged = false;
async function scanPhoto(buf, useAI) {
  const AI = useAI === false ? null : AI_CFG; // this trainer may not use the AI reader: the built-in reader only
  const base = await checkedImage(buf);
  // find the cards on a 1400 px copy; straighten them from a sharper copy
  const small = await base.clone().resize(1400, 1400, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const big = await base.clone().resize(2600, 2600, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const k = big.info.width / small.info.width, bigData = new Uint8ClampedArray(big.data);
  const scaleQ = q => ({ landscape: q.landscape, pts: q.pts.map(p => ({ x: p.x * k, y: p.y * k })) });
  let t0 = Date.now();
  let groups = [];
  try { groups = await cardOutlines(new Uint8ClampedArray(small.data), small.info.width, small.info.height); }
  catch (e) { if (!cvMissingLogged) { cvMissingLogged = true; log('card finder unavailable (' + e.message.split('\n')[0] + '); reading the middle of the photo instead. Rebuild the container with the current package.json.'); } }
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
  // One or two shapes found: with an AI, the whole photo decides how many cards there are. A single card is then read
  // from the whole photo, so a shape that cut the card in half or caught only its picture cannot spoil the reading.
  if (AI && !aiProblem && groups.length && groups.length <= 2 && !groups[0][0].scaled) {
    try {
      const reads = await aiReadPhoto(buf); aiUsed = true;
      slog('AI read the photo (' + groups.length + ' shapes found):', JSON.stringify(reads.map(x => x.said)));
      // one big card shape (a quarter of the photo or more) is one card, whatever else the AI noticed at the edges
      const oneBig = groups.length === 1 && groups[0][0].area >= small.info.width * small.info.height * 0.25;
      if (reads.length === 1 || (oneBig && reads.length > 1)) {
        // the card's picture for comparing: the shapes together (two pieces of one card) or the one shape
        let q = groups[0][0];
        if (groups.length === 2) {
          const pts = orderCorners(groups[0][0].pts.concat(groups[1][0].pts)), [tl, tr, br, bl] = pts;
          const w = (dist(tl, tr) + dist(bl, br)) / 2, h = (dist(tl, bl) + dist(tr, br)) / 2, r = Math.min(w, h) / Math.max(w, h);
          if (r > 0.66 && r < 0.77) q = { landscape: w > h, pts }; // together they make one card
        }
        const card = await straighten(bigData, big.info.width, big.info.height, scaleQ(q), 1.045);
        let m = null;
        for (const read of reads) { const x = await matchCard(card, read); if (!m || x.best > m.best) m = x; } // the reading that fits this card best
        m.card = card;
        if (useful(m)) found.push(m);
        groups = [];
      } else if (reads.length > groups.length) { // more cards than shapes: go by what the AI saw
        for (const read of reads) { const m = await matchCard(null, read); if (useful(m)) found.push(m); }
        if (found.length) groups = [];
      } // as many cards as shapes: each shape is read on its own below
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
    aiOff: useAI === false && !!AI_CFG ? true : undefined, // an AI is set up, but not for this trainer
    aiProblem: aiProblem ? aiProblem.slice(0, 160) : undefined,
  };
}
async function runScan(buf, useAI) {
  ocrWaiting++;
  const job = ocrChain.catch(() => {}).then(() => scanPhoto(buf, useAI));
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
    for (const [id, c] of Object.entries(db.cards)) if (c.x && !c.m && langOf(id) === 'ja') delete db.cards[id];
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
    await refreshLocNames();
    if (!db.logosDone && canSpend()) { // one request: fetch set pictures for sets stored by an older version
      const list = await paced('/sets');
      if (Array.isArray(list)) { applyLogos(list); db.logosDone = true; persist(true); }
    }
    if ((bootCheck || !db.setsChecked || ageDays(db.setsChecked) * 24 >= SETS_CHECK_HOURS || LANGS.some(l => !db.langsDone[l])) && canSpend()) { bootCheck = false; await syncSets(); }
    for (const lang of LANGS) {
      if (db.langsDone[lang] && (!db.rar[lang] || db.rar[lang].v !== 5 || ageDays(db.rar[lang].t) >= Math.max(1, SETS_CHECK_HOURS / 24)) && canSpend()) await rarityScan(lang);
    }
    await backfill();
    if (!db.initialDone && db.setsChecked && LANGS.every(l => db.rar[l]) && pendingCards().length === 0) {
      db.initialDone = true; unlimited = false;
      log('first build of the database finished');
    }
    if (db.initialDone && !unlimited) await syncArtists();
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
