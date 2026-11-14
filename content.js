// Enable CP 2 - runs in the page's own JS world (MAIN) at document_start, in every frame.
//
// Approach: "detect the block, then do it ourselves".
//  - Copy/Cut : if the site cancels the event without putting the right text on the
//               clipboard, we read the selection ourselves and write it to the clipboard.
//  - Paste    : if the site cancels the paste (or nothing changed), we insert the text
//               ourselves (editor API -> execCommand -> value setter -> synthetic paste).
//  - Shortcuts: a site can no longer cancel Ctrl+C/X/V/A, F12, Ctrl+U, etc.
//  - Own clipboard: whatever you copy is remembered, and used if the system clipboard
//               can't be read.
(() => {
  const isOn = () => {
    const r = document.documentElement;
    return !r || r.getAttribute('data-ecp') !== 'off';
  };
  const log = (...a) => { try { console.debug('[Enable CP]', ...a); } catch (_) {} };
  const say = log;                 // nothing is ever shown on the page; details only go to the debug console

  let lastInfo = '';
  let buffer = '';               // Enable CP's own clipboard
  let sawCopy = false, sawPaste = false, internalCopy = false;
  const synthetic = new WeakSet();   // paste events we created ourselves
  const written = new WeakMap();     // DataTransfer -> text/plain the site wrote
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  const EDITOR_SEL = '.monaco-editor,.ace_editor,.CodeMirror,.cm-editor';
  const INTERACTIVE_SEL = 'a,button,input,textarea,select,label,summary,[contenteditable],[draggable="true"],' +
    '[role="button"],[role="menuitem"],[role="tab"],[role="option"],[role="slider"],' + EDITOR_SEL;

  const closest = (el, sel) => (el && el.closest ? el.closest(sel) : null);
  const inKnownEditor = (el) => !!closest(el, EDITOR_SEL);

  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  // ---------- Editor adapters ----------
  function findMonaco(el) {
    try {
      const mon = window.monaco;
      if (!mon || !mon.editor || typeof mon.editor.getEditors !== 'function') return null;
      const eds = mon.editor.getEditors();
      if (!eds || !eds.length) return null;
      let ed = eds.find((x) => { try { return x.hasTextFocus(); } catch (_) { return false; } });
      if (!ed) {
        const root = closest(el, '.monaco-editor');
        if (root) ed = eds.find((x) => { try { return x.getDomNode() === root; } catch (_) { return false; } });
      }
      return ed || null;
    } catch (_) { return null; }
  }
  const findAce = (el) => { try { const r = closest(el, '.ace_editor'); return (r && r.env && r.env.editor) || null; } catch (_) { return null; } };
  const findCM5 = (el) => { try { const r = closest(el, '.CodeMirror'); return (r && r.CodeMirror) || null; } catch (_) { return null; } };

  // CodeMirror 6 (the editor CodeTantra uses): reach its EditorView through the DOM
  const findCM6 = (el) => {
    try {
      const root = closest(el, '.cm-editor');
      if (!root) return null;
      const nodes = [root.querySelector('.cm-content'), root, root.querySelector('.cm-scroller')];
      for (const n of nodes) {
        if (!n) continue;
        for (const k of Object.getOwnPropertyNames(n)) {            // cmView (older), cmTile (newer), ...
          if (!/^cm/i.test(k)) continue;
          const cv = n[k];
          const v = cv && (cv.view || (cv.root && cv.root.view) || (cv.docView && cv.docView.view));
          if (v && typeof v.dispatch === 'function' && v.state && v.state.doc) return v;
        }
      }
    } catch (_) {}
    return null;
  };

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (inKnownEditor(el)) return true;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'url', 'tel', 'email', 'password'].includes(ty) && !el.readOnly && !el.disabled;
    }
    return !!el.isContentEditable;
  }

  // ---------- Read the current selection ----------
  function getSelectedText() {
    const el = deepActive();
    try {
      const mon = findMonaco(el);
      if (mon) {
        const model = mon.getModel();
        const t = (mon.getSelections() || []).map((s) => model.getValueInRange(s)).join('\n');
        if (t) return t;
      }
      const ace = findAce(el);
      if (ace) { const t = ace.getSelectedText(); if (t) return t; }
      const cm = findCM5(el);
      if (cm) { const t = cm.getSelection(); if (t) return t; }
      const cm6 = findCM6(el);
      if (cm6) {
        const st = cm6.state;
        const t = st.selection.ranges.map((r) => st.sliceDoc(r.from, r.to)).filter(Boolean).join('\n');
        if (t) return t;
      }
      if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'password'))) {
        const s = el.selectionStart, e = el.selectionEnd;
        if (typeof s === 'number' && e > s) return el.value.slice(s, e);
      }
    } catch (_) {}
    const sel = window.getSelection();
    return sel ? sel.toString() : '';
  }

  // Something that changes whenever the editor's content changes
  function snapshot(el) {
    try {
      const mon = findMonaco(el);
      if (mon && mon.getModel()) return 'm' + mon.getModel().getVersionId();
      const ace = findAce(el);
      if (ace) return 'a' + ace.getValue();
      const cm = findCM5(el);
      if (cm) return 'c' + cm.getValue();
      const cm6 = findCM6(el);
      if (cm6) return 'z' + cm6.state.doc.toString();
      const root = closest(el, EDITOR_SEL);
      if (root) return 'd' + root.textContent;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return 'v' + el.value;
      if (el && el.isContentEditable) return 't' + el.textContent;
    } catch (_) {}
    return '';
  }

  // ---------- Write the clipboard ----------
  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); log('copied via Clipboard API'); return true; } catch (_) {}
    const prev = deepActive();
    const ws = window.getSelection();
    const ranges = [];
    for (let i = 0; ws && i < ws.rangeCount; i++) ranges.push(ws.getRangeAt(i));
    let ps, pe;
    try { ps = prev.selectionStart; pe = prev.selectionEnd; } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    (document.body || document.documentElement).appendChild(ta);
    ta.select();
    let ok = false;
    internalCopy = true;
    try { ok = document.execCommand('copy'); } catch (_) {}
    internalCopy = false;
    ta.remove();
    try { if (prev && prev.focus) prev.focus({ preventScroll: true }); } catch (_) {}
    try { if (typeof ps === 'number') prev.setSelectionRange(ps, pe); } catch (_) {}
    try { if (ws) { ws.removeAllRanges(); ranges.forEach((r) => ws.addRange(r)); } } catch (_) {}
    if (ok) log('copied via execCommand');
    return ok;
  }

  // ---------- Insert text ----------
  const viaApi = (el, text) => {
    const mon = findMonaco(el);
    if (mon) {
      const sels = mon.getSelections() || [];
      mon.pushUndoStop();
      mon.executeEdits('enable-cp', sels.map((r) => ({ range: r, text, forceMoveMarkers: true })));
      mon.pushUndoStop();
      return 'monaco';
    }
    const ace = findAce(el);
    if (ace) { ace.insert(text, true); return 'ace'; }
    const cm = findCM5(el);
    if (cm) { cm.replaceSelection(text, 'end'); return 'codemirror5'; }
    const cm6 = findCM6(el);
    if (cm6) {
      const before = cm6.state.doc;
      cm6.dispatch(Object.assign({}, cm6.state.replaceSelection(text), { scrollIntoView: true }));
      if (!text || !cm6.state.doc.eq(before)) return 'codemirror6';
    }
    return null;
  };
  const viaExec = (el, text) => {
    if (!isEditable(el)) return null;
    if (el.focus) el.focus({ preventScroll: true });
    return document.execCommand(text ? 'insertText' : 'delete', false, text);
  };
  const viaValue = (el, text) => {
    if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return null;
    const s = el.selectionStart, e = el.selectionEnd;
    if (typeof s !== 'number') return null;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, el.value.slice(0, s) + text + el.value.slice(e));
    el.setSelectionRange(s + text.length, s + text.length);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    return true;
  };
  const viaSynthetic = (el, text) => {
    if (!el) return null;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    synthetic.add(ev);
    el.dispatchEvent(ev);
    return true;
  };

  async function insertWithVerify(el, text) {
    const apiResult = (() => { try { return viaApi(el, text); } catch (_) { return null; } })();
    if (apiResult) { log('inserted via', apiResult, 'API'); return true; }
    const methods = [['execCommand', viaExec], ['value', viaValue], ['synthetic paste', viaSynthetic]];
    for (const [name, fn] of methods) {
      const before = snapshot(el);
      let r = null;
      try { r = fn(el, text); } catch (_) { r = null; }
      if (r === null) continue;
      await sleep(120);
      if (snapshot(el) !== before) { log('inserted via', name); return true; }
    }
    const cv = (() => { try { const c = closest(el, '.cm-editor'); return c && c.querySelector('.cm-content'); } catch (_) { return null; } })();
    lastInfo = 'target=' + (el ? el.tagName + '.' + String(el.className).slice(0, 30) : 'none') +
               ', cm6 handle=' + (findCM6(el) ? 'yes' : 'no') + ', cmView=' + (cv && cv.cmView ? 'yes' : 'no');
    log('could not insert text (' + lastInfo + ')');
    return false;
  }

  // ---------- Copy / Cut ----------
  function onCopyCut(e) {
    if (!isOn()) return;
    if (internalCopy) { e.stopImmediatePropagation(); return; }   // our own temp copy: hide from site
    sawCopy = true;
    const el = deepActive();
    const sel = getSelectedText();
    const dt = e.clipboardData;
    if (sel) buffer = sel;
    setTimeout(async () => {
      const w = dt ? written.get(dt) : undefined;
      if (!sel && w) buffer = w;
      if (!sel) { if (!w) say(e.type + ': could not find any selected text'); return; }
      const blocked = e.defaultPrevented && (w === undefined || norm(w) !== norm(sel));
      if (!blocked) { say(e.type + ' OK (' + sel.length + ' characters)'); return; }
      const ok = await writeClipboard(sel);
      say(ok ? e.type + ' was blocked - copied ' + sel.length + ' characters anyway'
             : e.type + ' was blocked and the clipboard could not be written');
      if (ok && e.type === 'cut' && isEditable(el)) {
        try { viaApi(el, '') || viaExec(el, ''); } catch (_) {}
      }
    }, 200);
  }
  window.addEventListener('copy', onCopyCut, true);
  window.addEventListener('cut', onCopyCut, true);

  // Remember what the site writes to the clipboard on copy
  const origSetData = DataTransfer.prototype.setData;
  DataTransfer.prototype.setData = function (type) {
    try { if (/^(text\/plain|text)$/i.test(String(type))) written.set(this, String(arguments[1])); } catch (_) {}
    return origSetData.apply(this, arguments);
  };

  // ---------- Paste ----------
  window.addEventListener('paste', (e) => {
    if (!isOn() || synthetic.has(e)) return;
    sawPaste = true;
    const cd = e.clipboardData;
    let text = '';
    try { text = cd ? cd.getData('text/plain') : ''; } catch (_) {}
    if (!text && cd) { try { const h = cd.getData('text/html'); if (h) text = htmlText(h); } catch (_) {} }   // formatted text only (other apps)
    if (!text && cd && cd.files && cd.files.length) return;      // only a picture or file: leave it to the site
    if (!text) text = buffer;                                     // fall back to Enable CP's own clipboard
    const el = deepActive();
    if (!text) { say('paste: clipboard is empty'); return; }
    if (!isEditable(el)) return;
    const before = snapshot(el);
    setTimeout(async () => {
      if (!isOn()) return;
      if (snapshot(el) !== before) return;                        // paste worked normally
      const ok = await insertWithVerify(el, text);
      say(ok ? 'paste was blocked - inserted ' + text.length + ' characters'
             : 'paste was blocked and I could not insert the text [' + lastInfo + ']');
    }, 200);
  }, true);

  // ---------- Keyboard: unblock shortcuts + fallbacks if no clipboard event arrives ----------
  const isClipboardKey = (e) => {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    return (mod && ['c', 'x', 'v', 'a', 'insert'].includes(k)) || (e.shiftKey && ['insert', 'delete'].includes(k));
  };
  const isUnlockKey = (e) => {
    if (typeof e.key !== 'string') return false;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    return isClipboardKey(e) || k === 'f12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) || (mod && k === 'u');
  };

  const htmlText = (h) => { try { return new DOMParser().parseFromString(String(h), 'text/html').body.textContent || ''; } catch (_) { return ''; } };

  window.addEventListener('keydown', (e) => {
    if (!isOn() || !e.isTrusted || typeof e.key !== 'string') return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const isCopy = (mod && k === 'c') || (mod && k === 'insert');
    const isCut = (mod && k === 'x') || (e.shiftKey && k === 'delete');
    const isPaste = (mod && k === 'v') || (e.shiftKey && k === 'insert');
    const el = deepActive();

    if (isCopy || isCut) {
      const sel = getSelectedText();
      if (!sel) return;
      buffer = sel;
      sawCopy = false;
      setTimeout(async () => {
        if (sawCopy) return;                                      // normal copy event happened
        const ok = await writeClipboard(sel);
        say(ok ? 'site swallowed Ctrl+C - copied ' + sel.length + ' characters anyway' : 'Ctrl+C was swallowed and the clipboard could not be written');
        if (ok && isCut && isEditable(el)) { try { viaApi(el, '') || viaExec(el, ''); } catch (_) {} }
      }, 200);
    }
    if (isPaste) {
      sawPaste = false;
      setTimeout(async () => {
        if (sawPaste) return;                                     // normal paste event happened
        const target = deepActive();
        if (!isEditable(target)) return;
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch (_) {}
        if (!text) text = buffer;
        if (!text) return;
        const ok = await insertWithVerify(target, text);
        say(ok ? 'site swallowed Ctrl+V - inserted ' + text.length + ' characters anyway' : 'Ctrl+V was swallowed and I could not insert the text');
      }, 200);
    }
  }, true);

  // ---------- Neutralise site attempts to cancel shortcuts / selection ----------
  const shouldProtect = (e) => {
    if (!e || !isOn()) return false;
    const t = e.type;
    if (t === 'keydown' || t === 'keyup' || t === 'keypress') {
      return typeof e.key === 'string' && isUnlockKey(e) && !inKnownEditor(e.target);
    }
    if (t === 'mousedown') {
      return e.button === 0 && e.target && e.target.closest && !e.target.closest(INTERACTIVE_SEL);
    }
    return false;
  };
  const origPD = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function preventDefault() {
    if (shouldProtect(this)) return;
    return origPD.apply(this, arguments);
  };
  try {
    const rv = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');
    if (rv && rv.set) {
      Object.defineProperty(Event.prototype, 'returnValue', {
        configurable: true, enumerable: rv.enumerable, get: rv.get,
        set(v) { if (v === false && shouldProtect(this)) return; rv.set.call(this, v); }
      });
    }
  } catch (_) {}

  // Right-click, selection start and drag (non-draggable items) are hidden from the site
  ['contextmenu', 'selectstart', 'dragstart'].forEach((type) => {
    window.addEventListener(type, (e) => {
      if (!isOn()) return;
      if (type === 'dragstart' && closest(e.target, '[draggable="true"]')) return;
      e.stopImmediatePropagation();
    }, true);
  });

  // ---------- Text selection inside Shadow DOM ----------
  const sheets = new Set();
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const sr = origAttach.apply(this, arguments);
    try {
      const s = new CSSStyleSheet();
      s.replaceSync('*,*::before,*::after{-webkit-user-select:text!important;user-select:text!important}');
      s.disabled = !isOn();
      sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, s];
      sheets.add(s);
    } catch (_) {}
    return sr;
  };
  const obs = new MutationObserver(() => { const on = isOn(); sheets.forEach((s) => { s.disabled = !on; }); });
  const watch = () => {
    if (document.documentElement) obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ecp'] });
    else setTimeout(watch, 10);
  };
  watch();

  // ---------- Auto-scroll while selecting text with the mouse ----------
  (() => {
    const ZONE = 56;
    let drag = null, raf = 0, px = 0, py = 0;
    const isDoc = (el) => el === document.scrollingElement || el === document.documentElement || el === document.body;
    const rectOf = (el) => {
      if (isDoc(el)) return { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const r = el.getBoundingClientRect();
      return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) };
    };
    const chainOf = (start) => {                                   // real scrollers first, then panels with overflow:hidden that still scroll by script
      const real = [], soft = [];
      for (let el = start; el && el.nodeType === 1; el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null) {
        if (isDoc(el)) continue;
        const cs = getComputedStyle(el);
        const tall = el.scrollHeight > el.clientHeight + 1, wide = el.scrollWidth > el.clientWidth + 1;
        if (!tall && !wide) continue;
        if (/(auto|scroll|overlay)/.test(cs.overflowY + ' ' + cs.overflowX)) real.push(el);
        else if (/hidden/.test(cs.overflowY + ' ' + cs.overflowX) && el.clientHeight > 40) soft.push(el);
      }
      return real.concat([document.scrollingElement || document.documentElement], soft);
    };
    const speed = (d) => Math.min(40, 6 + d * 0.5);               // faster the further past the edge

    function extend() {                                           // grow the selection to the text now under the pointer
      const sel = window.getSelection();
      if (!sel || !sel.anchorNode) return;
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
      const x = Math.min(Math.max(px, 1), innerWidth - 2), y = Math.min(Math.max(py, 1), innerHeight - 2);
      try {
        let node = null, off = 0;
        if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
        else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
        if (node) sel.extend(node, off);
      } catch (_) {}
    }

    function step() {
      raf = 0;
      if (!drag || !isOn()) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        for (const el of drag.chain) {
          const r = rectOf(el);
          let dx = 0, dy = 0;
          if (py > r.bottom - ZONE) dy = speed(py - (r.bottom - ZONE)); else if (py < r.top + ZONE) dy = -speed(r.top + ZONE - py);
          if (px > r.right - ZONE) dx = speed(px - (r.right - ZONE)); else if (px < r.left + ZONE) dx = -speed(r.left + ZONE - px);
          if (!dx && !dy) continue;                               // not near the edge of this container
          const l0 = el.scrollLeft, t0 = el.scrollTop;
          if (drag.last && drag.last.el === el && (drag.last.l !== l0 || drag.last.t !== t0)) { drag.last = { el, l: l0, t: t0 }; break; }   // the browser is already scrolling it
          el.scrollLeft = l0 + dx; el.scrollTop = t0 + dy;
          drag.last = { el, l: el.scrollLeft, t: el.scrollTop };
          if (el.scrollLeft !== l0 || el.scrollTop !== t0) { extend(); break; }
        }
      }
      raf = requestAnimationFrame(step);
    }
    const stop = () => { drag = null; if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    window.addEventListener('mousedown', (e) => {
      if (!isOn() || !e.isTrusted || e.button !== 0) return;
      const t = e.target;
      if (t && t.closest && t.closest('input,textarea,select,button,a,[draggable="true"],' + EDITOR_SEL)) return;
      drag = { chain: chainOf(t), last: null };
      px = e.clientX; py = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    }, true);
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (!(e.buttons & 1)) { stop(); return; }
      px = e.clientX; py = e.clientY;
    }, true);
    window.addEventListener('mouseup', stop, true);
    window.addEventListener('blur', stop);
    window.addEventListener('dragstart', stop, true);
  })();
})();
