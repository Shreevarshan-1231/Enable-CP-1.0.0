// Turns OCR output into clean text and restores the indentation of code.
(function (root) {
  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function getLines(data) {
    if (data && Array.isArray(data.lines) && data.lines.length) return data.lines;
    const out = [];
    ((data && data.blocks) || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => out.push(l))));
    return out;
  }
  // ---- fixes for the most common OCR mix-ups (capital I vs small l) ----
  function looksLikeCode(t) {
    return /[{};=<>#]|\(\)|\[\]/.test(t) || /^\s*(def|import|from|for|if|while|class|return|print|public|void)\b/m.test(t);
  }
  const AI_WORDS = new Set(('mode modes overview overviews assistant assistants chat chatbot chatbots bot bots model models ' +
    'tool tools search image images generated generator powered driven based art agent agents app apps engine summary ' +
    'studio writer translate translation feature features answer answers results detector content video videos voice ' +
    'course courses code coding powered-by prompt prompts training safety ethics').split(' '));

  function fixMistakes(text) {
    // 1) a small l squeezed between capitals is really a capital I:  AlMode -> AIMode
    text = text.replace(/(?<=[A-Z])l(?=[A-Z])/g, 'I');
    // 2) all-capital words with one stray small l:  GPl -> GPI,  lBM -> IBM
    text = text.replace(/\b[A-Za-z0-9]+\b/g, function (tok) {
      if (/^[A-Z0-9]*l[A-Z0-9]*$/.test(tok) && (tok.match(/[A-Z]/g) || []).length >= 2) return tok.replace(/l/g, 'I');
      return tok;
    });
    // 3a) "Al" is really "AI" when it sits in front of typical AI wording (Al Mode, Al Overview, Al-powered...)
    text = text.replace(/\bAl(?=[\s-]+[A-Za-z])([\s-]+)([A-Za-z]+)/g, function (m, sep, next) {
      return AI_WORDS.has(next.toLowerCase()) ? 'AI' + sep + next : m;
    });
    // 3b) ...or next to other all-capital tech words (ML and Al, Al and ML)
    text = text.replace(/\b([A-Z]{2,})([\s,\/&]+(?:and|or)?[\s,]*)Al\b/g, '$1$2AI');
    text = text.replace(/\bAl\b([\s,\/&]+(?:and|or)?[\s,]*)([A-Z]{2,})\b/g, 'AI$1$2');
    // 3c) normal text only: the OCR sometimes glues "AI" to the next word ("AIMode" -> "AI Mode")
    if (!looksLikeCode(text)) text = text.replace(/\bAI(?=[A-Z][a-z])/g, 'AI ');
    // 4) normal sentences only (not code): "lnformation", "lmages", "l am"
    if (!looksLikeCode(text)) {
      text = text.replace(/\bl(?=[bcdfghjkmnpqrstvwxz][a-z])/g, 'I');
      text = text.replace(/\bl\b(?=\s+[a-z])/g, 'I');
    }
    return text;
  }


  // ---- careful English spell-check for OCR mistakes ----
  // Only words that are NOT real words, that the reader itself was unsure about, and that become a real word
  // through a visually plausible change (like a/g, rn/m, i/l) are fixed, and only when there is exactly one answer.
  let DICT = null;
  const PAIRS = ['ag', 'ao', 'ac', 'ec', 'eo', 'co', 'io', 'il', 'it', 'lt', 'ft', 'uv', 'un', 'vy', 'nh', 'hb', 'gq', 'pq', 'dc', 'du', 'mn', 'ue', 'sz', 'gy', 'jy', 'ij', 'ou', 'nr', 'hn', 'tf', 'wv'];
  const SUB = {};
  PAIRS.forEach((p) => { (SUB[p[0]] = SUB[p[0]] || []).push(p[1]); (SUB[p[1]] = SUB[p[1]] || []).push(p[0]); });
  const MERGE = [['rn', 'm'], ['cl', 'd'], ['vv', 'w'], ['ii', 'u'], ['li', 'h']];
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

  // tier 1: changes that look like a real reading mistake (look-alike letters, rn/m, cl/d...)
  // tier 2: one letter too many, too few, or two letters swapped
  function candidates(w) {
    const t1 = new Set(), t2 = new Set();
    for (let i = 0; i < w.length; i++) {
      for (const r of (SUB[w[i]] || [])) t1.add(w.slice(0, i) + r + w.slice(i + 1));
      t2.add(w.slice(0, i) + w.slice(i + 1));
      if (i + 1 < w.length) t2.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
    }
    for (let i = 0; i <= w.length; i++) for (const c of LETTERS) t2.add(w.slice(0, i) + c + w.slice(i));
    for (const [a, b] of MERGE) {
      let k = w.indexOf(a); while (k >= 0) { t1.add(w.slice(0, k) + b + w.slice(k + a.length)); k = w.indexOf(a, k + 1); }
      k = w.indexOf(b); while (k >= 0) { t1.add(w.slice(0, k) + a + w.slice(k + b.length)); k = w.indexOf(b, k + 1); }
    }
    t1.delete(w); t2.delete(w);
    return [t1, t2];
  }
  function fixWord(core, conf, atStart) {
    if (!DICT || core.length < 4 || conf >= 90) return core;
    if (!/^[A-Za-z]+$/.test(core)) return core;
    const lower = core.toLowerCase();
    if (DICT.has(lower)) return core;
    const cap = core[0] !== core[0].toLowerCase();
    if (/[A-Z]/.test(core.slice(1))) return core;                 // CamelCase / ALL CAPS: leave
    if (cap && !atStart) return core;                             // names in the middle of a sentence: leave
    let fixed = null;
    for (const tier of candidates(lower)) {
      const found = [];
      for (const c of tier) if (DICT.has(c)) found.push(c);
      if (found.length === 1) { fixed = found[0]; break; }
      if (found.length > 1) return core;                          // ambiguous: leave it alone
    }
    if (!fixed) return core;
    return cap ? fixed[0].toUpperCase() + fixed.slice(1) : fixed;
  }
  function spellFix(data) {
    if (!DICT) return;
    const lines = getLines(data);
    // never touch program code
    if (looksLikeCode(lines.map((l) => l.text || '').join('\n'))) return;
    lines.forEach((l) => {
      const toks = (l.text || '').replace(/\n$/, '').split(/(\s+)/);
      const words = (l.words || []);
      const real = toks.filter((t) => t && !/^\s+$/.test(t));
      if (!words.length || real.length !== words.length) return;
      let k = 0, first = true;
      const out = toks.map((t) => {
        if (!t || /^\s+$/.test(t)) return t;
        const wd = words[k++]; const conf = wd && typeof wd.confidence === 'number' ? wd.confidence : 100;
        const wasFirst = first; first = false;
        const atStart = wasFirst || /[.!?]$/.test(toks[toks.indexOf(t) - 2] || '');
        return t.split(/([\/\-_.,:;()"'!?]+)/).map((part, pi) => (/^[A-Za-z]+$/.test(part) ? fixWord(part, conf, atStart && pi === 0) : part)).join('');
      });
      l.text = out.join('') + '\n';
    });
  }
  function setDictionary(list) { DICT = new Set(list); }

  // ---- quality score of one OCR result (sum of confidence of the confident words) ----
  function wordsOf(data) {
    if (data && Array.isArray(data.words) && data.words.length) return data.words;
    const out = [];
    getLines(data).forEach((l) => (l.words || []).forEach((w) => out.push(w)));
    return out;
  }
  function scoreData(data) {
    let sc = 0;
    wordsOf(data).forEach((w) => {
      // letters, digits and combining marks in ANY language (Tamil vowel signs are combining marks)
      const t = Array.from((w.text || '').replace(/[^\p{L}\p{N}\p{M}]/gu, ''));
      if (t.length >= 2 && w.confidence >= 60) sc += w.confidence;
    });
    return sc;
  }

  // score used to choose between reading passes (line-by-line mode gets a bonus so code keeps its shape)
  function passScore(data, lineMode) {
    return scoreData(data) * (lineMode ? 1.25 : 1);
  }

  function meanConf(data) {
    const ws = wordsOf(data);
    if (!ws.length) return 0;
    let t = 0; ws.forEach((w) => { t += w.confidence || 0; });
    return t / ws.length;
  }

  function buildText(data) {
    try { spellFix(data); } catch (_) {}
    let t = fixMistakes(buildRaw(data));
    // the Tamil model adds invisible joiner characters; they break searching and matching, so drop them
    t = t.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
    try { t = t.normalize('NFC'); } catch (_) {}
    return t;
  }
  function buildRaw(data) {
    const lines = getLines(data).filter((l) => l && l.text && l.text.trim() && l.bbox);
    if (!lines.length) return ((data && data.text) || '').replace(/\r/g, '').replace(/\s+$/, '');

    // width of one character, measured from the longer words (works best for code)
    const widths = [];
    lines.forEach((l) => (l.words || []).forEach((w) => {
      const t = (w.text || '').trim();
      if (t.length >= 4 && w.bbox) widths.push((w.bbox.x1 - w.bbox.x0) / t.length);
    }));
    let cw = median(widths);
    if (!cw) cw = median(lines.map((l) => (l.bbox.x1 - l.bbox.x0) / Math.max(1, l.text.trim().length)));

    // more exact: distance between the starts of neighbouring words = (word length + 1 space) characters
    const pairs = [];
    lines.forEach((l) => {
      const ws = l.words || [];
      for (let i = 0; i + 1 < ws.length; i++) {
        const a = ws[i], b = ws[i + 1], len = (a.text || '').trim().length;
        if (!a.bbox || !b.bbox || len < 1) continue;
        const gap = b.bbox.x0 - a.bbox.x1;
        if (gap > 0.2 * cw && gap < 1.6 * cw) pairs.push((b.bbox.x0 - a.bbox.x0) / (len + 1));
      }
    });
    if (pairs.length >= 2) cw = median(pairs);

    const minX = Math.min.apply(null, lines.map((l) => l.bbox.x0));
    const isCode = looksLikeCode(lines.map((l) => l.text).join('\n'));   // only code needs its indentation back
    return lines.map((l) => {
      let n = isCode && cw > 0 ? (l.bbox.x0 - minX) / cw : 0;
      n = n < 1.5 ? 0 : Math.min(40, Math.round(n));
      return ' '.repeat(n) + l.text.trim();
    }).join('\n');
  }
  root.ecpBuildText = buildText;
  root.ecpFixMistakes = fixMistakes;
  root.ecpScoreData = scoreData;
  root.ecpMeanConf = meanConf;
  root.ecpSetDictionary = setDictionary;
  root.ecpWordsOf = wordsOf;
  root.ecpLinesOf = getLines;
  root.ecpPassScore = passScore;
  root.ecpLooksLikeCode = looksLikeCode;
  if (typeof module !== 'undefined') module.exports = { buildText, fixMistakes, scoreData, passScore, looksLikeCode, meanConf, setDictionary, fixWord };
})(typeof self !== 'undefined' ? self : this);
