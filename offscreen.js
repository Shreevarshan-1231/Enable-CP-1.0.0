// Runs the OCR engine (Tesseract.js, all files stored inside this extension).
// English and Tamil are loaded together, so either language (or both mixed) is read automatically.
// Nothing is sent over the internet.
const BASE = chrome.runtime.getURL('vendor');           // no trailing slash
const LANGS = ['eng', 'tam'];

// English word list (inside the extension) for the careful spell-check of OCR results
fetch(chrome.runtime.getURL('words-en.txt')).then((r) => r.text())
  .then((t) => { if (self.ecpSetDictionary) self.ecpSetDictionary(t.split('\n')); }).catch(() => {});

let workerPromise = null;
function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    if (typeof Tesseract === 'undefined') throw new Error('The reading engine files are missing from this extension.');
    const worker = await Tesseract.createWorker(LANGS, 1, {
      workerPath: BASE + '/worker.min.js',
      corePath: BASE,
      langPath: BASE,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
    return worker;
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read the screenshot')); i.src = src; });
}

// ---------- picture preparation ----------
// Height (px) of one line of text: rows of the picture that contain ink, grouped into bands.
function lineHeight(v, w, h) {
  const need = Math.max(2, Math.floor(0.004 * w));
  const rows = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0; const o = y * w;
    for (let x = 0; x < w; x++) if (v[o + x] < 128) n++;
    rows[y] = n >= need ? 1 : 0;
  }
  const bands = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    if (rows[y] && start < 0) start = y;
    if (!rows[y] && start >= 0) { bands.push([start, y]); start = -1; }
  }
  if (start >= 0) bands.push([start, h]);
  const merged = [];
  for (const b of bands) {
    if (merged.length && b[0] - merged[merged.length - 1][1] < 3) merged[merged.length - 1][1] = b[1];
    else merged.push([b[0], b[1]]);
  }
  let hs = merged.map((b) => b[1] - b[0]);
  if (!hs.length) return Math.max(8, h);
  const mx = Math.max.apply(null, hs);
  hs = hs.filter((x) => x >= 0.35 * mx).sort((a, b) => a - b);
  const m = hs.length >> 1;
  return hs.length % 2 ? hs[m] : (hs[m - 1] + hs[m]) / 2;
}

// Remove a plain-coloured frame around the content (for example the page background around a dark panel):
// a frame confuses the contrast step and the reader, so it is trimmed off first.
function frameBounds(g, w, h) {
  const UNI = 8, JUMP = 25;
  const rowStat = (y) => { let s = 0, s2 = 0; const o = y * w; for (let x = 0; x < w; x++) { const v = g[o + x]; s += v; s2 += v * v; } const m = s / w; return [m, Math.sqrt(Math.max(0, s2 / w - m * m))]; };
  const colStat = (x) => { let s = 0, s2 = 0; for (let y = 0; y < h; y++) { const v = g[y * w + x]; s += v; s2 += v * v; } const m = s / h; return [m, Math.sqrt(Math.max(0, s2 / h - m * m))]; };
  const side = (stat, n, back) => {
    const lim = Math.min(60, Math.floor(n * 0.3));
    const at = (i) => stat(back ? n - 1 - i : i);
    const first = at(0);
    if (first[1] > UNI) return 0;
    for (let i = 1; i <= lim; i++) if (Math.abs(at(i)[0] - first[0]) > JUMP) return i;
    return 0;
  };
  const t = side(rowStat, h, false), b = side(rowStat, h, true), l = side(colStat, w, false), r = side(colStat, w, true);
  if (w - l - r < 8 || h - t - b < 8) return { x0: 0, y0: 0, w, h };
  return { x0: l, y0: t, w: w - l - r, h: h - t - b };
}

// Crop the chosen area and turn it into dark text on a light background (flipping if needed).
// The enlargement is chosen from the measured text height, in WHOLE steps (1x-4x): too much
// enlargement makes Tamil letters blur together, too little makes small English text unreadable.
async function prepare(dataUrl, rect, vw) {
  const img = await loadImage(dataUrl);
  const k = img.naturalWidth / vw;                       // screenshot pixels per page pixel
  const pad = 12;                                        // look a little beyond the box: a tight box often clips letter edges and tails (g, y, C...)
  const sx = Math.max(0, Math.floor((rect.x - pad) * k));
  const sy = Math.max(0, Math.floor((rect.y - pad) * k));
  const sw = Math.min(img.naturalWidth - sx, Math.ceil((rect.w + pad * 2) * k));
  const sh = Math.min(img.naturalHeight - sy, Math.ceil((rect.h + pad * 2) * k));
  if (sw < 4 || sh < 4) throw new Error('The selected area is too small');

  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const src = ctx.getImageData(0, 0, sw, sh).data;

  const g0 = new Float32Array(sw * sh);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) g0[p] = (src[i] + src[i + 1] + src[i + 2]) / 3;       // equal weights cancel the colour fringes of screen text
  const fb = frameBounds(g0, sw, sh);                    // trim a plain frame around the content
  const w = fb.w, h = fb.h;
  const g = new Float32Array(w * h);
  let sum = 0, min = 255, max = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const val = g0[(y + fb.y0) * sw + (x + fb.x0)];
    g[y * w + x] = val; sum += val; if (val < min) min = val; if (val > max) max = val;
  }
  const dark = sum / g.length < 128;
  const range = Math.max(1, max - min);
  const v = new Float32Array(w * h);                     // dark text on light background, full contrast
  for (let p = 0; p < g.length; p++) { const n = (g[p] - min) * 255 / range; v[p] = dark ? 255 - n : n; }

  // the box the user really drew, in the coordinates of the trimmed crop
  const box = {
    x0: Math.max(0, rect.x * k - sx - fb.x0), y0: Math.max(0, rect.y * k - sy - fb.y0),
    x1: Math.min(w, (rect.x + rect.w) * k - sx - fb.x0), y1: Math.min(h, (rect.y + rect.h) * k - sy - fb.y0)
  };
  const H = lineHeight(v, w, h);
  let scale = Math.max(1, Math.min(4, Math.round(45 / H)));
  while (scale > 1 && (w * scale + 32) * (h * scale + 32) > 3200000) scale--;   // keep it fast
  return { v, w, h, scale, box };
}

// A picture the engine can read: `flip` turns light-on-dark into dark-on-light and the other way round.
function render(base, flip) {
  const { v, w, h, scale } = base;
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  const tctx = t.getContext('2d');
  const id = tctx.createImageData(w, h), d = id.data;
  for (let p = 0, i = 0; p < v.length; p++, i += 4) {
    const x = flip ? 255 - v[p] : v[p];
    d[i] = d[i + 1] = d[i + 2] = x; d[i + 3] = 255;
  }
  tctx.putImageData(id, 0, 0);
  const m = 16, out = document.createElement('canvas');
  out.width = w * scale + m * 2; out.height = h * scale + m * 2;
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, out.width, out.height);
  octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
  octx.drawImage(t, m, m, w * scale, h * scale);
  return out;
}

// How much of the ink in the picture lies inside words the engine found (1 = everything was read).
function coverage(base, data) {
  const { v, w, h, scale, box } = base;
  const mask = new Uint8Array(w * h);
  const pad = 2;
  for (const wd of (self.ecpWordsOf ? self.ecpWordsOf(data) : [])) {
    if (!wd.bbox) continue;
    const x0 = Math.max(0, Math.floor((wd.bbox.x0 - 16) / scale) - pad), x1 = Math.min(w, Math.ceil((wd.bbox.x1 - 16) / scale) + pad);
    const y0 = Math.max(0, Math.floor((wd.bbox.y0 - 16) / scale) - pad), y1 = Math.min(h, Math.ceil((wd.bbox.y1 - 16) / scale) + pad);
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
  }
  let ink = 0, inside = 0;
  const y0 = Math.floor(box.y0), y1 = Math.ceil(box.y1), x0 = Math.floor(box.x0), x1 = Math.ceil(box.x1);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = y * w + x; if (v[p] < 128) { ink++; if (mask[p]) inside++; } }
  return ink ? inside / ink : 1;
}

// ---------- reading ----------
const OUTPUT = { text: true, blocks: true, hocr: false, tsv: false, box: false, unlv: false, osd: false, pdf: false };
async function readPass(worker, canvas, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  return (await worker.recognize(canvas, {}, OUTPUT)).data;
}

// 1) one line-by-line reading. If it is clean code, or it covered all the ink with good confidence, stop.
// 2) otherwise also read the flipped picture in "sparse text" mode (finds text the first reading missed)
// 3) if the result is still weak, one more line-by-line reading of the flipped picture. Best result wins.
async function recognizeBest(worker, base) {
  const P = Tesseract.PSM;
  const main = render(base, false);
  let flipped = null;
  const flip = () => flipped || (flipped = render(base, true));

  const first = await readPass(worker, main, P.SINGLE_BLOCK);
  let best = { score: self.ecpPassScore(first, true), data: first };
  const conf1 = self.ecpMeanConf(first);
  if (conf1 >= 80 && self.ecpLooksLikeCode(first.text || '')) return first;
  if (conf1 >= 70 && coverage(base, first) >= 0.9) return first;

  try {
    const second = await readPass(worker, flip(), P.SPARSE_TEXT);
    const sc = self.ecpPassScore(second, false);
    if (sc > best.score) best = { score: sc, data: second };
  } catch (_) {}
  if (self.ecpMeanConf(best.data) < 60) {
    try {
      const third = await readPass(worker, flip(), P.SINGLE_BLOCK);
      const sc = self.ecpPassScore(third, true);
      if (sc > best.score) best = { score: sc, data: third };
    } catch (_) {}
  }
  return best.data;
}

// Words found in the extra margin (outside the box the user drew) are dropped; words whose centre is inside stay.
function keepInBox(data, base) {
  const { scale, box } = base, tol = 3;
  const inside = (b) => {
    const cx = ((b.x0 + b.x1) / 2 - 16) / scale, cy = ((b.y0 + b.y1) / 2 - 16) / scale;
    return cx >= box.x0 - tol && cx <= box.x1 + tol && cy >= box.y0 - tol && cy <= box.y1 + tol;
  };
  const lines = [];
  for (const l of self.ecpLinesOf(data)) {
    const ws = (l.words || []).filter((w) => !w.bbox || inside(w.bbox));
    if (!ws.length) continue;
    const bb = ws.filter((w) => w.bbox).map((w) => w.bbox);
    lines.push({
      text: ws.map((w) => w.text).join(' ') + '\n',
      bbox: bb.length ? { x0: Math.min(...bb.map((b) => b.x0)), x1: Math.max(...bb.map((b) => b.x1)), y0: Math.min(...bb.map((b) => b.y0)), y1: Math.max(...bb.map((b) => b.y1)) } : l.bbox,
      words: ws
    });
  }
  if (!lines.length) return data;                          // nothing inside the box: keep the full result
  return { text: lines.map((l) => l.text).join(''), confidence: data.confidence, lines, words: lines.flatMap((l) => l.words) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'ecp-warm') {                          // load the engine early, while the user drags the box
    getWorker().catch(() => {});
    return;
  }
  if (msg.type !== 'ecp-ocr') return;
  (async () => {
    try {
      const base = await prepare(msg.dataUrl, msg.rect, msg.vw);
      const worker = await getWorker();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Reading took too long. Try a smaller area.')), 120000));
      const data = await Promise.race([recognizeBest(worker, base), timeout]);
      sendResponse({ text: self.ecpBuildText(keepInBox(data, base)) });
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true;
});
