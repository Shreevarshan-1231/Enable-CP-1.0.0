// Enable CP - "Snip to copy".
// Drag a box over anything on the screen:
//   * real page text (including Tamil and emoji) is copied EXACTLY, instantly, with no reading mistakes;
//   * pictures, canvas, video and other non-text is read with OCR (English and Tamil together).
// Runs in every frame (so text inside iframes can be found); only the top page shows the screens.
(() => {
  const IS_TOP = window.top === window;

  // =====================================================================
  //  A) finding the real text inside a box (runs in every frame)
  // =====================================================================
  const NOT_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'TITLE']);
  const seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  // letters/syllables/emoji as the reader sees them (Tamil vowel signs and emoji sequences stay in one piece)
  function clusters(text) {
    const out = [];
    if (seg) { for (const g of seg.segment(text)) out.push([g.index, g.index + g.segment.length]); }
    else { for (let i = 0; i < text.length;) { const n = text.codePointAt(i) > 0xffff ? 2 : 1; out.push([i, i + n]); i += n; } }
    return out;
  }
  function topElementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    return el;
  }
  const related = (a, b) => a === b || (a && b && (a.contains(b) || b.contains(a)));

  function textPieces(R, pieces) {
    const roots = [document];
    const range = document.createRange();
    let nodes = 0;
    while (roots.length) {
      const root = roots.pop();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (NOT_TEXT.has(n.tagName)) return NodeFilter.FILTER_REJECT;
            if (n.shadowRoot) roots.push(n.shadowRoot);
            return NodeFilter.FILTER_SKIP;
          }
          return n.nodeValue && /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (++nodes > 40000) return;
        const parent = n.parentElement;
        if (!parent) continue;
        range.selectNodeContents(n);
        let hit = false;
        for (const r of range.getClientRects()) {
          if ((r.width || r.height) && r.right > R.x0 && r.left < R.x1 && r.bottom > R.y0 && r.top < R.y1) { hit = true; break; }
        }
        if (!hit) continue;
        if (parent.checkVisibility && !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const cs = getComputedStyle(parent);
        const pre = /^(pre|break-spaces)/.test(cs.whiteSpace);
        const checkTop = cs.pointerEvents !== 'none';
        const text = n.nodeValue;
        let grp = null;
        const flush = () => {
          const g = grp; grp = null;
          if (!g) return;
          const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2;
          if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;            // not on screen
          if (checkTop) { const top = topElementAt(cx, cy); if (top && !related(top, parent)) return; }   // covered / clipped
          pieces.push({ t: text.slice(g.start, g.end).replace(/[\r\n]+$/, ''), x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, pre });
        };
        for (const [a, b] of clusters(text)) {
          range.setStart(n, a); range.setEnd(n, b);
          const r = range.getBoundingClientRect();
          if (!r.width && !r.height) continue;                                            // collapsed white space
          const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
          if (cx < R.x0 || cx > R.x1 || cy < R.y0 || cy > R.y1) continue;                // outside the box
          if (grp && a >= grp.end && Math.abs(cy - grp.cy) < 0.6 * Math.max(r.height, grp.h)) {
            grp.end = b; grp.x1 = Math.max(grp.x1, r.right); grp.y0 = Math.min(grp.y0, r.top); grp.y1 = Math.max(grp.y1, r.bottom);
          } else {
            flush();
            grp = { start: a, end: b, x0: r.left, x1: r.right, y0: r.top, y1: r.bottom, cy, h: r.height };
          }
        }
        flush();
      }
    }
  }

  function mediaArea(R) {
    let area = 0;
    for (const el of document.querySelectorAll('img,canvas,video,svg,picture,object,embed')) {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, R.x1) - Math.max(r.left, R.x0), h = Math.min(r.bottom, R.y1) - Math.max(r.top, R.y0);
      if (w > 0 && h > 0) area += w * h;
    }
    return area;
  }

  // ask an iframe for its part of the box (works across websites through window messages)
  function askFrame(win, rect) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      let t = 0;
      const onMsg = (e) => {
        const d = e.data;
        if (e.source === win && d && d.ecp === 'extract-res' && d.id === id) { cleanup(); resolve(d); }
      };
      const cleanup = () => { window.removeEventListener('message', onMsg); clearTimeout(t); };
      t = setTimeout(() => { cleanup(); resolve(null); }, 350);
      window.addEventListener('message', onMsg);
      try { win.postMessage({ ecp: 'extract-req', id, rect }, '*'); } catch (_) { cleanup(); resolve(null); }
    });
  }

  async function extractTree(rect, depth) {
    const R = { x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h };
    const pieces = [];
    textPieces(R, pieces);
    let media = mediaArea(R);
    if ((depth || 0) < 4) {
      const frames = Array.from(document.querySelectorAll('iframe,frame'));
      await Promise.all(frames.map(async (f) => {
        const r = f.getBoundingClientRect();
        const left = r.left + f.clientLeft, top = r.top + f.clientTop;
        const ix0 = Math.max(R.x0, left), iy0 = Math.max(R.y0, top);
        const ix1 = Math.min(R.x1, left + f.clientWidth), iy1 = Math.min(R.y1, top + f.clientHeight);
        if (ix1 <= ix0 || iy1 <= iy0 || !f.contentWindow) return;
        const res = await askFrame(f.contentWindow, { x: ix0 - left, y: iy0 - top, w: ix1 - ix0, h: iy1 - iy0 });
        if (!res || !Array.isArray(res.pieces)) return;
        for (const p of res.pieces) pieces.push({ t: p.t, pre: p.pre, x0: p.x0 + left, x1: p.x1 + left, y0: p.y0 + top, y1: p.y1 + top });
        media += res.media || 0;
      }));
    }
    return { pieces, media };
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || d.ecp !== 'extract-req' || e.source !== window.parent) return;
    let res = { pieces: [], media: 0 };
    try { res = await extractTree(d.rect, 1); } catch (_) {}
    try { window.parent.postMessage({ ecp: 'extract-res', id: d.id, pieces: res.pieces, media: res.media }, '*'); } catch (_) {}
  });

  // pieces -> lines of text (reading order: top to bottom, left to right)
  function buildFromPieces(pieces) {
    if (!pieces.length) return '';
    const ps = pieces.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    const lines = [];
    for (const p of ps) {
      const cy = (p.y0 + p.y1) / 2, h = Math.max(1, p.y1 - p.y0);
      const L = lines.find((l) => Math.abs(cy - l.cy) < 0.5 * Math.max(h, l.h));
      if (L) { L.items.push(p); L.cy = (L.cy * L.n + cy) / (L.n + 1); L.n++; L.h = Math.max(L.h, h); }
      else lines.push({ cy, h, n: 1, items: [p] });
    }
    lines.sort((a, b) => a.cy - b.cy);
    return lines.map((l) => {
      l.items.sort((a, b) => a.x0 - b.x0);
      let s = '', prevEnd = null;
      l.items.forEach((it, idx) => {
        let t = it.t.replace(/\u00a0/g, ' ');
        if (!it.pre) t = t.replace(/[ \t\r\n]+/g, ' ');
        if (idx === 0 && !it.pre) t = t.replace(/^ +/, '');
        if (s && prevEnd != null && it.x0 - prevEnd > 0.15 * l.h && !/\s$/.test(s) && !/^\s/.test(t)) s += ' ';
        s += t; prevEnd = it.x1;
      });
      return s.replace(/[ \t]+$/, '');
    }).filter((x, i) => x.trim() || lines[i].items.some((it) => it.pre)).join('\n');
  }

  // Snip shortcut inside the page: Alt+Shift+S (works even if Chrome's shortcut list is not set up)
  const isSnipKey = (e) => e.isTrusted && !e.repeat && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS' &&
    document.documentElement.getAttribute('data-ecp') !== 'off';
  if (!IS_TOP) {                                               // inside an iframe: ask the top page to start the snip
    window.addEventListener('keydown', (e) => {
      if (!isSnipKey(e)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      try { window.top.postMessage({ ecp: 'start-snip' }, '*'); } catch (_) {}
    }, true);
    return;
  }

  // =====================================================================
  //  B) the screens (top page only)
  // =====================================================================
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- drag-a-box overlay ----------------
  let overlayHost = null, onEsc = null;
  function closeOverlay() {
    if (overlayHost) { overlayHost.remove(); overlayHost = null; }
    if (onEsc) { window.removeEventListener('keydown', onEsc, true); onEsc = null; }
  }

  function startSnip() {
    closePanel();
    closeOverlay();
    try { chrome.runtime.sendMessage({ type: 'ecp-warmup' }).catch(() => {}); } catch (_) {}   // load the engine while the user drags
    overlayHost = document.createElement('div');
    overlayHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;';
    const sr = overlayHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      '.ov{position:fixed;inset:0;cursor:crosshair;background:rgba(0,0,0,.25);user-select:none;font:14px system-ui,sans-serif}' +
      '.hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#1d4ed8;color:#fff;padding:8px 14px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none}' +
      '.box{position:fixed;border:2px solid #38bdf8;background:rgba(56,189,248,.14);display:none;pointer-events:none}';
    const ov = el('div', 'ov');
    const hint = el('div', 'hint', 'Drag over the text you want to copy  \u00b7  Esc to cancel');
    const box = el('div', 'box');
    ov.append(hint, box);
    sr.append(style, ov);
    document.documentElement.appendChild(overlayHost);

    let sx = 0, sy = 0, dragging = false;
    const rectOf = (e) => ({ x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY), w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy) });
    const draw = (e) => {
      const r = rectOf(e);
      box.style.left = r.x + 'px'; box.style.top = r.y + 'px'; box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
    };
    ov.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true; sx = e.clientX; sy = e.clientY;
      box.style.display = 'block'; hint.style.display = 'none'; draw(e);
    });
    ov.addEventListener('mousemove', (e) => { if (dragging) draw(e); });
    ov.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      const r = rectOf(e);
      closeOverlay();
      if (r.w < 8 || r.h < 8) return;
      snipBox(r);
    });
    onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeOverlay(); } };
    window.addEventListener('keydown', onEsc, true);
  }

  window.addEventListener('keydown', (e) => {
    if (!isSnipKey(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    startSnip();
  }, true);
  window.addEventListener('message', (e) => {                  // the shortcut was pressed inside an iframe
    if (e.source !== window && e.data && e.data.ecp === 'start-snip') startSnip();
  });

  // ---------------- what to do with the box ----------------
  let pendingText = '';                                        // page text found in the box (used if OCR has nothing better)
  async function snipBox(r) {
    pendingText = '';
    // 1) real page text: exact, instant
    let smart = '', media = 0;
    try { const res = await extractTree(r, 0); smart = buildFromPieces(res.pieces); media = res.media; } catch (_) {}
    const chars = smart.replace(/\s/g, '').length;
    const mediaRatio = Math.min(1, media / Math.max(1, r.w * r.h));
    if (chars >= 1 && mediaRatio < 0.4) { showResult(smart); return; }
    pendingText = smart;
    // 2) pictures, canvas, video...: read with OCR
    await sleep(120);                                          // let the box disappear before the screenshot
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ecp-capture', rect: r, vw: window.innerWidth });
      if (!res || !res.ok) {
        if (smart) showResult(smart);
        else showMessage('Could not take the screenshot', 'Chrome did not allow capturing this page. Snip does not work on chrome:// pages or the Chrome Web Store.');
        return;
      }
      showBusy();
    } catch (e) {
      if (smart) showResult(smart);
      else showMessage('Please reload this page', 'The extension was updated or restarted. Press Ctrl+R to reload the page, then try again.');
    }
  }

  // ---------------- result panel ----------------
  let panelHost = null, card = null, escPanel = null;
  const PANEL_CSS =
    '.card{width:360px;max-width:90vw;box-sizing:border-box;background:#fff;color:#111827;border:1px solid #cbd5e1;border-radius:12px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,.35);padding:12px;font:13px/1.45 system-ui,sans-serif}' +
    '.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}' +
    '.title{font-weight:600;color:#1d4ed8}' +
    '.status{color:#475569;margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.ok{color:#15803d}.err{color:#b91c1c}' +
    'textarea{display:block;width:100%;height:170px;box-sizing:border-box;font:13px/1.45 ui-monospace,Consolas,"Noto Sans Tamil","Latha",monospace;padding:8px;' +
    'border:1px solid #cbd5e1;border-radius:8px;resize:vertical;background:#f8fafc;color:#111827;' +
    'white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden;overflow-y:auto;tab-size:4}' +
    '.row{display:flex;gap:8px;margin-top:8px}' +
    'button{font:13px system-ui,sans-serif;padding:7px 12px;border-radius:8px;border:1px solid #cbd5e1;background:#f1f5f9;color:#111827;cursor:pointer}' +
    'button.p{background:#1d4ed8;border-color:#1d4ed8;color:#fff}' +
    'button:hover{filter:brightness(.95)}' +
    // WhatsApp-style "typing" dots while reading
    '.typing{display:inline-flex;align-items:center;gap:5px;padding:12px 16px;background:#e2e8f0;border-radius:18px 18px 18px 4px}' +
    '.typing i{width:8px;height:8px;border-radius:50%;background:#64748b;animation:bounce 1.2s infinite ease-in-out}' +
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}' +
    '@keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:.45}30%{transform:translateY(-6px);opacity:1}}' +
    '@media (prefers-color-scheme:dark){.card{background:#1f2937;color:#f3f4f6;border-color:#374151}.status{color:#cbd5e1}' +
    'textarea{background:#111827;color:#f3f4f6;border-color:#374151}button{background:#374151;color:#f3f4f6;border-color:#4b5563}button.p{background:#2563eb;border-color:#2563eb}' +
    '.title{color:#93c5fd}.typing{background:#374151}.typing i{background:#cbd5e1}}';

  function closePanel() {
    if (panelHost) { panelHost.remove(); panelHost = null; card = null; }
    if (escPanel) { window.removeEventListener('keydown', escPanel, true); escPanel = null; }
  }
  function render(build) {
    if (!panelHost || !panelHost.isConnected) {
      panelHost = document.createElement('div');
      panelHost.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      const sr = panelHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      card = el('div', 'card');
      sr.append(style, card);
      document.documentElement.appendChild(panelHost);
      escPanel = (e) => { if (e.key === 'Escape') closePanel(); };
      window.addEventListener('keydown', escPanel, true);
    }
    card.textContent = '';
    const top = el('div', 'top');
    top.append(el('span', 'title', 'Enable CP \u00b7 Snip to copy'));
    const x = el('button', '', 'Close');
    x.addEventListener('click', closePanel);
    top.append(x);
    card.append(top);
    build(card);
  }

  function showBusy() {
    render((c) => {
      const t = el('div', 'typing');
      t.setAttribute('role', 'status'); t.setAttribute('aria-label', 'Reading');
      t.append(el('i'), el('i'), el('i'));
      c.append(t);
    });
  }
  function showMessage(title, msg) {
    render((c) => { c.append(el('p', 'status err', title)); c.append(el('p', 'status', msg)); });
  }
  async function copyText(text, ta) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    try { ta.focus(); ta.select(); return document.execCommand('copy'); } catch (_) {}
    return false;
  }
  function showResult(text) {
    render((c) => {
      const status = el('p', 'status', 'Copied to clipboard. You can edit the text below, then press Copy again.');
      const ta = document.createElement('textarea');
      ta.value = text; ta.spellcheck = false; ta.wrap = 'soft';
      const row = el('div', 'row');
      const copy = el('button', 'p', 'Copy');
      const again = el('button', '', 'Snip again');
      row.append(copy, again);
      c.append(status, ta, row);
      const doCopy = async () => {
        const ok = await copyText(ta.value, ta);
        status.textContent = ok ? 'Copied to clipboard. You can edit the text below, then press Copy again.' : 'Press Copy to put it on the clipboard.';
        status.className = ok ? 'status ok' : 'status';
      };
      copy.addEventListener('click', doCopy);
      again.addEventListener('click', startSnip);
      doCopy();
    });
  }
  function showError(error) {
    const e = String(error || '');
    if (/missing from this extension|Failed to load|importScripts|NetworkError/i.test(e)) {
      showMessage('The reading engine could not start', 'Open chrome://extensions and click the reload arrow on Enable CP, then try again. If it keeps happening, re-download the extension.');
    } else if (/too long/i.test(e)) {
      showMessage('Reading took too long', 'Try a smaller area, then snip again.');
    } else {
      showMessage('Something went wrong', e);
    }
  }

  // ---------------- messages from the extension ----------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ecp-start-snip') { startSnip(); sendResponse({ ok: true }); }
    else if (msg.type === 'ecp-snip-result') {
      if (msg.error) { if (pendingText) showResult(pendingText); else showError(msg.error); }
      else if (!msg.text || !msg.text.trim()) {
        if (pendingText) showResult(pendingText);
        else showMessage('No text found', 'Try selecting a larger area, or zoom the page in (Ctrl and +), then snip again.');
      } else showResult(msg.text);
      sendResponse({ ok: true });
    }
  });
})();
