// The card finder: rectangles with the shape of a Pokémon card on a photo or video frame, found with OpenCV.
// Shared by the server (scanning a photo) and the page (the live video scan), so both find cards the same way.
// findCards(cv, rgba, W, H, maxCards) -> groups of 4-corner shapes, biggest first: [[{pts:[tl,tr,br,bl], area, landscape}, ...], ...]
// (a group is one card: its edge, plus its picture panel or sleeve when those were found too).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.cardfind = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function orderCorners(pts) { // top-left, top-right, bottom-right, bottom-left
    const s = pts.map(p => p.x + p.y), d = pts.map(p => p.x - p.y);
    return [pts[s.indexOf(Math.min(...s))], pts[d.indexOf(Math.max(...d))], pts[s.indexOf(Math.max(...s))], pts[d.indexOf(Math.min(...d))]];
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // a card seen at an angle is still a four-sided shape with corners near 90 degrees and opposite sides about as long:
  // long thin triangles and skewed shapes (lines of several cards joined up) are not cards
  function cardLike(pts) {
    for (let i = 0; i < 4; i++) {
      const a = pts[(i + 3) % 4], b = pts[i], c = pts[(i + 1) % 4];
      const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y, l = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
      if (!l) return false;
      const ang = Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / l))) * 180 / Math.PI;
      if (ang < 62 || ang > 118) return false;
    }
    const [tl, tr, br, bl] = pts, r1 = dist(tl, tr) / dist(bl, br), r2 = dist(tl, bl) / dist(tr, br);
    return Math.min(r1, 1 / r1) > 0.72 && Math.min(r2, 1 / r2) > 0.72;
  }
  // an empty sleeve or pocket is almost one colour inside; a card has a picture and text
  function hasContent(rgba, W, H, pts) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let n = 0, s = 0, s2 = 0;
    for (let gy = 1; gy < 10; gy++) for (let gx = 1; gx < 8; gx++) {
      const x = Math.round(x0 + (x1 - x0) * (0.2 + 0.6 * gx / 8)), y = Math.round(y0 + (y1 - y0) * (0.2 + 0.6 * gy / 10));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4, g = rgba[i] * 0.3 + rgba[i + 1] * 0.59 + rgba[i + 2] * 0.11; n++; s += g; s2 += g * g;
    }
    return n > 10 && Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n))) > 16;
  }
  function findCards(cv, rgba, W, H, maxCards) {
    const mats = [];
    const keep = m => { mats.push(m); return m; };
    try {
      const box = q => ({ x0: Math.min(...q.pts.map(p => p.x)), x1: Math.max(...q.pts.map(p => p.x)), y0: Math.min(...q.pts.map(p => p.y)), y1: Math.max(...q.pts.map(p => p.y)) });
      const src = keep(cv.matFromImageData({ data: rgba, width: W, height: H })), gray = keep(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      const quads = [];
      const iou = (a, b) => { const p = box(a), o = box(b), ix = Math.max(0, Math.min(p.x1, o.x1) - Math.max(p.x0, o.x0)), iy = Math.max(0, Math.min(p.y1, o.y1) - Math.max(p.y0, o.y0)), i = ix * iy;
        return i / ((p.x1 - p.x0) * (p.y1 - p.y0) + (o.x1 - o.x0) * (o.y1 - o.y0) - i); };
      function shapesIn(bin) { // the card-shaped outlines in a black and white picture
        const contours = keep(new cv.MatVector()), hier = keep(new cv.Mat());
        cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
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
            const q = { pts: [tl, tr, br, bl], area, landscape: w > h };
            if (ratio > 0.6 && ratio < 0.82 && area > W * H * 0.015 && cardLike(q.pts) && hasContent(rgba, W, H, q.pts) && !quads.some(o => iou(o, q) > 0.8)) quads.push(q);
          }
          hull.delete(); ap.delete(); c.delete();
        }
      }
      // three ways to see the cards, as each misses some: edges joined up (cards with broken edges), thin edges (cards
      // close together, as in a binder, stay apart), and light shapes on a dark background (sleeves in a black binder)
      const edges = keep(new cv.Mat()), thin = keep(new cv.Mat()), bright = keep(new cv.Mat());
      cv.Canny(gray, edges, 40, 120);
      cv.dilate(edges, thin, keep(cv.Mat.ones(2, 2, cv.CV_8U)));
      cv.dilate(edges, edges, keep(cv.Mat.ones(5, 5, cv.CV_8U)));
      shapesIn(edges); shapesIn(thin);
      cv.threshold(gray, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.erode(bright, bright, keep(cv.Mat.ones(3, 3, cv.CV_8U)), new cv.Point(-1, -1), 2);
      shapesIn(bright);
      const within = (a, b) => { const p = box(a), o = box(b), m = 0.02 * Math.max(W, H); return p.x0 >= o.x0 - m && p.x1 <= o.x1 + m && p.y0 >= o.y0 - m && p.y1 <= o.y1 + m; };
      // An upright card whose own edge was not found can show up as two lying pieces, one above the other (its top and
      // bottom half, or its picture and its text): two such pieces that together make an upright card shape are one card.
      // (Two cards side by side are standing pieces that make a lying shape: those stay apart.)
      for (let again = true; again;) {
        again = false;
        for (let i = 0; i < quads.length && !again; i++) for (let j = i + 1; j < quads.length && !again; j++) {
          const a = quads[i], b = quads[j];
          if (!a.landscape || !b.landscape || within(a, b) || within(b, a)) continue;
          const pts = orderCorners(a.pts.concat(b.pts)), [tl, tr, br, bl] = pts;
          const w = (dist(tl, tr) + dist(bl, br)) / 2, h = (dist(tl, bl) + dist(tr, br)) / 2, area = w * h;
          if (w < h && w / h > 0.66 && w / h < 0.77 && area <= (a.area + b.area) * 1.3 && area >= Math.max(a.area, b.area) * 1.5 && cardLike(pts)) {
            quads.splice(j, 1); quads[i] = { pts, area, landscape: false, joined: true }; again = true;
          }
        }
      }
      quads.sort((a, b) => b.area - a.area);
      // a shape around two or more card-sized shapes of about the same size is a binder page or a row of cards, not one card
      // (an upright card with two lying pieces inside is its picture and text: those were joined above, or are details)
      for (let i = 0; i < quads.length; i++) {
        const q = quads[i], kids = quads.filter(o => o !== q && within(o, q) && o.area / q.area > 0.06 && o.area / q.area < 0.6);
        const apart = kids.filter(o => !kids.some(p => p !== o && within(o, p) && p.area > o.area)); // the outer edge of each
        const same = apart.filter(o => apart.some(p => p !== o && p.landscape === o.landscape && Math.min(p.area, o.area) / Math.max(p.area, o.area) > 0.6));
        if (same.length >= 2 && !(same.every(o => o.landscape) && !q.landscape)) { quads.splice(i, 1); i--; }
      }
      const groups = [];
      for (const q of quads) {
        const g = groups.find(gr => within(q, gr[0]) && q.area / gr[0].area > 0.35);
        if (g) { if (g.length < 3) g.push(q); } else if (!groups.some(gr => within(q, gr[0]) || iou(q, gr[0]) > 0.4)) groups.push([q]); // cards do not overlap much: a shape over a found card is that card
      }
      // cards on one photo are about the same size: a much smaller shape on its own is a detail (a box, a sticker), not a card
      // (with three or more, the typical card size decides, so one big wrong shape cannot push the real cards out)
      const sizes = groups.map(g => g[0].area).sort((a, b) => a - b), ref = sizes.length >= 3 ? sizes[Math.floor(sizes.length / 2)] : sizes[sizes.length - 1] || 0;
      return groups.filter(g => g[0].area >= ref * 0.4 && (sizes.length < 3 || g[0].area <= ref * 2.5)).slice(0, maxCards || 12);
    } finally { mats.forEach(m => { try { m.delete(); } catch (e) { /* gone */ } }); }
  }
  return { findCards, orderCorners, dist };
}));
