/* Sides Enlarger core engine.
 * Runs in browser and Node. Dependencies injected: { pdfjsLib, PDFLib }.
 *
 * Pipeline:
 *  A) pdf.js text extraction -> per-document geometric calibration
 *     (cue / dialogue / parenthetical x-bands) -> per-line classification.
 *  B) pdf-lib content-stream rewrite: dialogue text runs get a scaled text
 *     matrix anchored on their own baseline; everything else is emitted
 *     byte-for-byte untouched. Page-for-page parity is structural: nothing
 *     ever moves vertically, so nothing can reflow.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.createSidesEngine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------- small stats helpers ----------
  const median = a => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const quantile = (a, q) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const fmt = n => {
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? '0' : String(r);
  };

  // ---------- matrices (PDF order: [a b c d e f]) ----------
  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  // ---------- phase A: extraction + classification ----------
  const LEAD = 12, EDGE = 14; // pts: nominal leading, min page margin kept

  function buildLines(items) {
    // cluster text items into visual lines by baseline y
    const sorted = [...items].sort((p, q) => q.y - p.y || p.x - q.x);
    const lines = [];
    for (const it of sorted) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(L.y - it.y) <= 2.0) L.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    for (const L of lines) {
      L.items.sort((p, q) => p.x - q.x);
      L.y = median(L.items.map(i => i.y));
      L.x0 = L.items[0].x;
      L.x1 = Math.max(...L.items.map(i => i.x + i.w));
      // segments: item clusters split at horizontal gaps > 40pt (dual dialogue).
      // Join item text with a space only across a real word-sized gap:
      // glyph-per-item PDFs abut (gap ~0) and must not become "R U M A".
      L.segments = [];
      for (const it of L.items) {
        const S = L.segments[L.segments.length - 1];
        if (S && it.x - S.x1 <= 40) {
          const gap = it.x - S.x1;
          const wordGap = Math.max(1.5, 0.25 * (it.size || 12));
          S.items.push(it); S.x1 = Math.max(S.x1, it.x + it.w);
          S.text += (gap > wordGap ? ' ' : '') + it.str;
        }
        else L.segments.push({ x0: it.x, x1: it.x + it.w, items: [it], text: it.str });
      }
      L.text = L.segments.map(s => s.text).join('   ');
    }
    return lines;
  }

  const capsy = t => {
    const letters = (t || '').replace(/[^A-Za-z]/g, '');
    return letters.length >= 2 && letters === letters.toUpperCase();
  };
  // A cue may carry revision marks in the far-right margin ("TRACY  *"):
  // those margin segments must not disqualify it. pageW=0 keeps the strict
  // single-segment rule (calibration's first pass has no page context).
  const isCueLine = (L, band, pageW) => {
    const segs = pageW
      ? L.segments.filter(sg => sg.x0 < pageW - 80)
      : L.segments;
    if (segs.length !== 1 || segs[0] !== L.segments[0]) return false;
    const text = segs[0].text;
    return capsy(text) && text.trim().length <= 42 &&
      L.x0 >= band[0] && L.x0 <= band[1] &&
      !/\b(INT|EXT)\s*[.\/]/.test(text) &&
      !/(CUT TO|FADE (IN|OUT)|DISSOLVE)/.test(text);
  };

  function calibrate(pages) {
    const CUE_BAND = [200, 340]; // 2.8"–4.7" initial guess, then refined
    const cueXs = [];
    for (const P of pages) for (const L of P.lines) if (isCueLine(L, CUE_BAND, P.width)) cueXs.push(L.x0);
    if (cueXs.length < 2) return null;
    const cueX = median(cueXs);
    // dialogue x0: lines directly below a cue, indented left of it.
    // Skip parentheticals (they sit in their own column) and take the median,
    // not the mode: per-page photocopy drift clusters samples per page, and a
    // mode would lock onto one page's drift instead of the document center.
    const dialXs = [];
    for (const P of pages) {
      for (let i = 0; i < P.lines.length; i++) {
        if (!isCueLine(P.lines[i], [cueX - 12, cueX + 12], P.width)) continue;
        const nxt = P.lines[i + 1];
        if (nxt && P.lines[i].y - nxt.y < 3 * LEAD && !/^\(/.test(nxt.text.trim()) &&
            nxt.x0 > cueX - 130 && nxt.x0 < cueX - 30) dialXs.push(nxt.x0);
      }
    }
    const dialX = dialXs.length ? median(dialXs) : cueX - 86;
    const parenXs = [];
    for (const P of pages) for (const L of P.lines)
      if (/^\(/.test(L.text.trim()) && L.x0 > dialX + 6 && L.x0 < dialX + 70) parenXs.push(L.x0);
    const parenX = parenXs.length ? median(parenXs) : dialX + 43;
    return { cueX, dialX, parenX };
  }

  // ---------- character extraction ----------
  // A cue like "SAM", "SAM (CONT'D)", "SAM (V.O.) *" is all one character: SAM.
  // Trailing revision asterisks cluster onto cue lines; parentheticals are
  // annotations, not identity.
  function normalizeCueName(text) {
    let t = String(text || '').replace(/\*/g, ' ');
    t = t.replace(/\s*\([^)]*\)/g, ' ');       // (CONT'D) (V.O.) (O.S.) (ON PHONE)...
    t = t.replace(/[.,:;]+\s*$/, '');
    return t.replace(/\s+/g, ' ').trim().toUpperCase();
  }
  // Furniture that can pass the caps/position tests but is never a character.
  // Names may contain '#' (MERC #1), '/' (GIRLS/CASSIDY) and function words
  // (ELEANOR FROM HR) — no stop-word filtering.
  const NOT_A_NAME = /^(CUT TO|SMASH CUT|DISSOLVE|FADE (IN|OUT|TO)|MATCH CUT|TIME CUT|INTERCUT|CONTINUED|OMITTED|MONTAGE|END OF|THE END|INSERT|CHYRON|SUPER|TITLE|ANGLE ON|CLOSE ON|BACK TO)\b/;
  const NAME_CHARSET = /^[A-Z0-9#/&'’.\- ]+$/;
  const isPlausibleName = n =>
    !!n && /[A-Z]/.test(n) && NAME_CHARSET.test(n) &&
    !NOT_A_NAME.test(n) && n.split(' ').length <= 8;

  // Aggregate cue-led blocks (built by classifyPage) into unique character
  // names with dialogue-line counts. The dialogue-follow requirement (a block
  // must contain at least one dialogue line) is the noise filter: shouted
  // action and INSERT/CHYRON labels never have a dialogue block under them.
  function collectCharacters(pages) {
    const map = new Map();
    const get = name => {
      let e = map.get(name);
      if (!e) map.set(name, e = { name, lines: 0, blocks: 0, firstPage: 0, dual: false });
      return e;
    };
    for (const P of pages) {
      for (const B of (P.blocks || [])) {
        const dial = B.lines.filter(l => l.cls === 'dialogue').length;
        if (!dial || !isPlausibleName(B.name)) continue;
        const e = get(B.name);
        if (!e.firstPage) e.firstPage = P.index;
        e.lines += dial; e.blocks++;
      }
      // dual-dialogue cue rows: surface the names for user review (never let
      // them corrupt the main list — they merge if the name already exists)
      for (const n of (P.dualNames || [])) {
        const e = get(n);
        if (!e.firstPage) e.firstPage = P.index;
        e.dual = true;
      }
    }
    return [...map.values()].sort((a, b) => b.lines - a.lines || (a.name < b.name ? -1 : 1));
  }

  function classifyPage(P, cal) {
    // walk top -> bottom; dialogue = in a block opened by a character cue.
    // Also collects the cue-led blocks (P.blocks) used for character
    // extraction and highlighting, and dual-cue names (P.dualNames).
    let inBlock = false, dualMode = false, prevY = null, cur = null;
    P.blocks = []; P.dualNames = [];
    for (const L of P.lines) {
      if (prevY !== null && prevY - L.y > 28) { inBlock = false; cur = null; } // big vertical gap
      prevY = L.y;
      // a cue with a revision star in the margin is 2 segments but NOT dual:
      // dual detection looks at body segments only
      const bodySegs = L.segments.filter(sg => sg.x0 < P.width - 80);
      const dualCueRow = bodySegs.length >= 2 &&
        bodySegs.every(s => capsy(s.text) && s.text.trim().length <= 30);
      if (dualCueRow) {
        L.cls = 'dual'; dualMode = true; inBlock = false; cur = null; P.hasDual = true;
        for (const s of bodySegs) {
          const n = normalizeCueName(s.text);
          // scene numbers print in both margins of a slugline and read as a
          // "dual cue" row; a spaceless letter+digit run is never a character
          if (isPlausibleName(n) && !/^[A-Z]{0,3}\d+[A-Z0-9]*$/.test(n)) P.dualNames.push(n);
        }
        continue;
      }
      if (dualMode) {
        if (L.segments.length >= 2) { L.cls = 'dual'; P.hasDual = true; continue; }
        dualMode = false;
      }
      if (isCueLine(L, [cal.cueX - 12, cal.cueX + 12], P.width)) {
        L.cls = 'cue'; inBlock = true;
        setDialExtent(L, P.width); // cue extents/star cap for scaling
        cur = { name: normalizeCueName(L.text), cue: L, lines: [] };
        P.blocks.push(cur);
        continue;
      }
      if (inBlock && (near(L.x0, cal.dialX, 9) || near(L.x0, cal.parenX, 9))) {
        L.cls = /^\(\s*MORE\s*\)\s*$/i.test(L.text.trim()) ? 'more' : 'dialogue';
        setDialExtent(L, P.width);
        if (cur) cur.lines.push(L);
        continue;
      }
      L.cls = 'other'; inBlock = false; cur = null;
    }
  }

  // Dialogue extent excludes right-margin marks (revision asterisks, scene
  // continuation *, etc.) which sit far right and must never be scaled or
  // counted toward the fit calculation. If such marks exist on the line,
  // record where they start so enlargement never grows into them.
  function setDialExtent(L, pageW) {
    const marginStart = pageW - 80; // ~1.1" from right edge
    const segs = L.segments.filter(s => s.x0 < marginStart);
    if (segs.length) {
      L.dx0 = Math.min(...segs.map(s => s.x0));
      L.dx1 = Math.max(...segs.map(s => s.x1));
      const marks = L.segments.filter(s => s.x0 >= marginStart);
      if (marks.length) L.starX0 = Math.min(...marks.map(s => s.x0));
    } else { L.dx0 = L.x0; L.dx1 = L.x1; }
  }

  function pageScale(P, requested, colW, dialX) {
    // Every dialogue run is scaled uniformly about the column-center anchor
    // C = dialX + colW/2 (x' = C + s*(x - C)), so letter pitch, word gaps and
    // indents all grow together. Max uniform scale so every dialogue line
    // stays on the page (and clear of right-margin revision marks); back off
    // (never reflow) when it doesn't fit.
    const C = dialX + colW / 2;
    let s = requested;
    for (const L of P.lines) {
      if (!((L.cls === 'dialogue' || L.cls === 'cue') && L.enlarge !== false)) continue;
      const x0 = L.dx0 != null ? L.dx0 : L.x0;
      const x1 = L.dx1 != null ? L.dx1 : L.x1;
      // left edge: C + s*(x0 - C) >= EDGE
      const sLeft = x0 < C ? (C - EDGE) / (C - x0) : Infinity;
      // right edge: C + s*(x1 - C) <= right limit (page edge, or just short
      // of a revision mark sitting in the margin on this same line)
      const rightLimit = L.starX0 != null ? Math.min(P.width - EDGE, L.starX0 - 4) : P.width - EDGE;
      const sRight = x1 > C ? (rightLimit - C) / (x1 - C) : Infinity;
      s = Math.min(s, sLeft, sRight);
    }
    return Math.max(1, Math.floor(s * 100) / 100);
  }

  // ---------- content stream lexer ----------
  const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
  const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

  function tokenize(src) {
    // src: latin1 string (1 char == 1 byte). Yields {t, raw, val?}
    const toks = [];
    let i = 0;
    const n = src.length;
    const isWS = c => WS.has(src.charCodeAt(c));
    while (i < n) {
      const c = src[i];
      if (isWS(i)) { i++; continue; }
      if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
      if (c === '(') { // literal string, nested parens + escapes
        let depth = 0, j = i;
        for (; j < n; j++) {
          const ch = src[j];
          if (ch === '\\') { j++; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
        }
        toks.push({ t: 'str', raw: src.slice(i, j) }); i = j; continue;
      }
      if (c === '<') {
        if (src[i + 1] === '<') { // dict: copy raw to matching >>
          let depth = 0, j = i;
          while (j < n) {
            if (src[j] === '<' && src[j + 1] === '<') { depth++; j += 2; continue; }
            if (src[j] === '>' && src[j + 1] === '>') { depth--; j += 2; if (!depth) break; continue; }
            if (src[j] === '(') { let d2 = 0; for (; j < n; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '(') d2++; else if (src[j] === ')') { d2--; if (!d2) { j++; break; } } } continue; }
            j++;
          }
          toks.push({ t: 'dict', raw: src.slice(i, j) }); i = j; continue;
        }
        let j = i + 1; while (j < n && src[j] !== '>') j++;
        toks.push({ t: 'str', raw: src.slice(i, j + 1) }); i = j + 1; continue;
      }
      if (c === '[') { toks.push({ t: 'arrOpen', raw: '[' }); i++; continue; }
      if (c === ']') { toks.push({ t: 'arrClose', raw: ']' }); i++; continue; }
      if (c === '/') {
        let j = i + 1;
        while (j < n && !isWS(j) && !DELIM.has(src[j])) j++;
        toks.push({ t: 'name', raw: src.slice(i, j) }); i = j; continue;
      }
      if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
        let j = i + 1;
        while (j < n && /[0-9.+\-eE]/.test(src[j])) j++;
        const raw = src.slice(i, j);
        toks.push({ t: 'num', raw, val: parseFloat(raw) }); i = j; continue;
      }
      { // operator / keyword
        let j = i;
        while (j < n && !isWS(j) && !DELIM.has(src[j])) j++;
        toks.push({ t: 'op', raw: src.slice(i, j) }); i = j;
      }
    }
    return toks;
  }

  function toInstructions(toks, src) {
    // group tokens into {operands:[tok], op} — arrays become one operand
    const out = [];
    let operands = [];
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t === 'arrOpen') {
        const parts = ['['];
        k++;
        for (; k < toks.length && toks[k].t !== 'arrClose'; k++) parts.push(toks[k].raw);
        parts.push(']');
        operands.push({ t: 'arr', raw: parts.join(' ') });
        continue;
      }
      if (tk.t === 'op') {
        if (tk.raw === 'true' || tk.raw === 'false' || tk.raw === 'null') { operands.push(tk); continue; }
        if (tk.raw === 'BI') {
          // inline image: swallow tokens up to ID, then raw-scan handled upstream
          out.push({ op: 'BI_RAW', operands: [], raw: null, biStart: k });
          operands = [];
          continue;
        }
        out.push({ op: tk.raw, operands });
        operands = [];
        continue;
      }
      operands.push(tk);
    }
    return out;
  }

  // ---------- decryption (Standard security handler, empty user password) ----
  // Production sides are routinely permission-locked (RC4-128 / AES-128 with an
  // empty user password). pdf.js decrypts transparently for reading; for the
  // rewrite we decrypt every stream & string in place, then drop /Encrypt.
  const PAD = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
  ];

  // Minimal MD5 (public-domain style implementation), returns Uint8Array(16)
  function md5(bytes) {
    const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
               4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const n = bytes.length;
    const total = (((n + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes); buf[n] = 0x80;
    const bitLen = n * 8;
    buf[total - 8] = bitLen & 0xff; buf[total - 7] = (bitLen >>> 8) & 0xff;
    buf[total - 6] = (bitLen >>> 16) & 0xff; buf[total - 5] = (bitLen >>> 24) & 0xff;
    // (PDF inputs are < 512MB; higher length bytes stay 0)
    let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
    const M = new Int32Array(16);
    const rotl = (x, c) => (x << c) | (x >>> (32 - c));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        M[i] = buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24);
      }
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, s[i])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((w, i) => {
      out[i * 4] = w & 0xff; out[i * 4 + 1] = (w >>> 8) & 0xff;
      out[i * 4 + 2] = (w >>> 16) & 0xff; out[i * 4 + 3] = (w >>> 24) & 0xff;
    });
    return out;
  }

  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xff;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = new Uint8Array(data.length);
    let i = 0; j = 0;
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 0xff;
      j = (j + S[i]) & 0xff;
      const t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
    }
    return out;
  }

  async function aesCbcDecrypt(key, data) {
    if (data.length < 16) return new Uint8Array(0);
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
    if (!subtle) throw new Error('AES-encrypted PDF needs a secure context (https) to decrypt.');
    const iv = data.slice(0, 16);
    let body = data.slice(16);
    if (!body.length) return new Uint8Array(0);
    const k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
    try {
      const plain = await subtle.decrypt({ name: 'AES-CBC', iv }, k, body);
      return new Uint8Array(plain);
    } catch (e) {
      throw new Error('AES decryption failed (bad padding) — file may use an unsupported variant.');
    }
  }

  function buildDecryptor(PDFLib, ctx) {
    const encRef = ctx.trailerInfo.Encrypt;
    if (!encRef) return null;
    const enc = ctx.lookup(encRef);
    const g = k => enc.get(PDFLib.PDFName.of(k));
    const filter = g('Filter');
    if (!filter || filter.asString() !== '/Standard') {
      throw new Error('This PDF uses a non-standard security handler; cannot process it locally.');
    }
    const V = g('V') ? g('V').asNumber() : 0;
    const R = g('R') ? g('R').asNumber() : 2;
    if (R > 4) throw new Error('This PDF uses AES-256 (newer encryption). Ask production for a standard export, or print-to-PDF first.');
    const length = g('Length') ? g('Length').asNumber() : 40;
    const O = ctx.lookup(g('O')).asBytes();
    let P = ctx.lookup(g('P')).asNumber();
    // method for streams/strings (V4 crypt filters)
    let aes = false;
    if (V === 4) {
      const cf = g('CF') && ctx.lookup(g('CF'));
      const stmf = g('StmF');
      const fname = stmf ? stmf.asString().slice(1) : 'Identity';
      if (fname !== 'Identity' && cf) {
        const f = cf.get(PDFLib.PDFName.of(fname)) && ctx.lookup(cf.get(PDFLib.PDFName.of(fname)));
        const cfm = f && f.get(PDFLib.PDFName.of('CFM'));
        if (cfm && cfm.asString() === '/AESV2') aes = true;
        else if (cfm && cfm.asString() === '/AESV3') throw new Error('AES-256 PDF encryption is not supported.');
      }
    }
    const encryptMetadata = g('EncryptMetadata') ? String(g('EncryptMetadata')) !== 'false' : true;
    const idArr = ctx.lookup(ctx.trailerInfo.ID);
    const id0 = idArr ? ctx.lookup(idArr.get(0)).asBytes() : new Uint8Array(0);

    const keyLen = R === 2 ? 5 : Math.floor(length / 8);
    const pBytes = new Uint8Array(4);
    const p = P >>> 0; // two's complement as unsigned
    pBytes[0] = p & 0xff; pBytes[1] = (p >>> 8) & 0xff; pBytes[2] = (p >>> 16) & 0xff; pBytes[3] = (p >>> 24) & 0xff;
    const material = concatBytes([new Uint8Array(PAD), O.slice(0, 32), pBytes, id0,
      (R >= 4 && !encryptMetadata) ? new Uint8Array([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0)]);
    let key = md5(material).slice(0, keyLen);
    if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.slice(0, keyLen)).slice(0, keyLen);

    const objKey = (num, gen) => {
      const extra = aes ? [0x73, 0x41, 0x6C, 0x54] : [];
      const m = concatBytes([key,
        new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]),
        new Uint8Array(extra)]);
      return md5(m).slice(0, Math.min(keyLen + 5, 16));
    };
    return {
      aes,
      decrypt: async (num, gen, data) => aes ? aesCbcDecrypt(objKey(num, gen), data) : rc4(objKey(num, gen), data),
    };
  }

  function concatBytes(list) {
    let n = 0;
    for (const b of list) n += b.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }

  async function decryptInPlace(PDFLib, pdfDoc) {
    const ctx = pdfDoc.context;
    const dec = buildDecryptor(PDFLib, ctx);
    if (!dec) return false;
    const encRefStr = ctx.trailerInfo.Encrypt && ctx.trailerInfo.Encrypt.toString();
    const strCache = new Map();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref.toString() === encRefStr) continue;
      const num = ref.objectNumber, gen = ref.generationNumber;
      // streams
      if (obj instanceof PDFLib.PDFRawStream) {
        const t = obj.dict.get(PDFLib.PDFName.of('Type'));
        if (t && t.toString() === '/XRef') continue; // never encrypted
        obj.contents = await dec.decrypt(num, gen, obj.contents);
        continue;
      }
      // strings anywhere inside this object
      await visitStrings(PDFLib, obj, async bytes => dec.decrypt(num, gen, bytes), strCache);
    }
    delete ctx.trailerInfo.Encrypt;
    return true;
  }

  async function visitStrings(PDFLib, obj, fn, seen) {
    if (!obj || typeof obj !== 'object') return;
    if (seen.has(obj)) return;
    seen.set(obj, true);
    if (obj instanceof PDFLib.PDFDict) {
      for (const [k, v] of obj.entries()) {
        const nv = await replaceString(PDFLib, v, fn);
        if (nv) obj.set(k, nv);
        else await visitStrings(PDFLib, v, fn, seen);
      }
    } else if (obj instanceof PDFLib.PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        const nv = await replaceString(PDFLib, v, fn);
        if (nv) obj.set(i, nv);
        else await visitStrings(PDFLib, v, fn, seen);
      }
    } else if (obj instanceof PDFLib.PDFRawStream) {
      await visitStrings(PDFLib, obj.dict, fn, seen);
    }
  }

  async function replaceString(PDFLib, v, fn) {
    if (v instanceof PDFLib.PDFString || v instanceof PDFLib.PDFHexString) {
      const plain = await fn(v.asBytes());
      let hex = '';
      for (const b of plain) hex += (b < 16 ? '0' : '') + b.toString(16);
      return PDFLib.PDFHexString.of(hex.toUpperCase());
    }
    return null;
  }

  // ---------- phase B: rewrite ----------
  // Returns { out, changed, bail }. `onDo(name, ctmAtInvoke)` handles form
  // XObject recursion; text may live inside forms (real production sides do
  // exactly this), so scaling has to descend through `Do`.
  //
  // Clip awareness: rectangular clip paths (`re W n`, table cells, row bands)
  // are tracked in device space. When `collect` is given the walk runs in
  // MEASURE mode: nothing is emitted or mutated; instead every show op that
  // would scale reports its line and the active clip x-range, so the caller
  // can cap the page scale to keep text inside its clips.
  function rewriteStream(src, ctm0, dialogLines, sPage, anchorX, stats, onDo, collect) {
    if (src.indexOf('BI') !== -1 && /(^|[\s>\]])BI[\s\/]/.test(src)) {
      // inline images present: bail out of scaling this stream rather than corrupt
      stats.warnings.push('stream contains inline images; left unscaled');
      return { out: null, changed: false, bail: true };
    }
    const instrs = toInstructions(tokenize(src), src);
    const out = [];
    const emitRaw = ins => { out.push(ins.operands.map(o => o.raw).join(' ') + (ins.operands.length ? ' ' : '') + ins.op); };
    const emit = s => out.push(s);

    let ctm = ctm0 ? ctm0.slice() : [1, 0, 0, 1, 0, 0];
    const gsStack = [];
    let tm = null, tlm = null, tl = 0;
    let scaledRun = false; // currently inside an injected-scale run
    let changedHere = false;
    // device-space x-range of the active rectangular clip (if any)
    let clipLo = -Infinity, clipHi = Infinity, clipUnknown = false;
    let pathRects = [], pathOther = false, pendingClip = false;
    const applyPendingClip = () => {
      if (pendingClip) {
        if (pathOther || !pathRects.length) clipUnknown = true;
        else {
          clipLo = Math.max(clipLo, Math.min(...pathRects.map(r => r[0])));
          clipHi = Math.min(clipHi, Math.max(...pathRects.map(r => r[1])));
        }
        pendingClip = false;
      }
      pathRects = []; pathOther = false;
    };

    const restoreIfScaled = () => {
      if (scaledRun) { emit(tlm.map(fmt).join(' ') + ' Tm'); scaledRun = false; }
    };
    const num = (ins, idx) => (ins.operands[idx] && ins.operands[idx].val) || 0;

    const classifyShow = () => {
      if (!tlm) return null;
      const dev = apply(mul(tlm, ctm), 0, 0);
      for (const L of dialogLines) {
        const lo = (L.dx0 != null ? L.dx0 : L.x0) - 2;
        const hi = (L.dx1 != null ? L.dx1 : L.x1) + 2;
        if (Math.abs(dev[1] - L.y) <= 2.5 && dev[0] >= lo && dev[0] <= hi) return { L, devX: dev[0] };
      }
      return null;
    };
    const beginScaledIfDialogue = () => {
      if (scaledRun) return; // continuing same run: advances already scaled
      const hit = classifyShow();
      if (!hit || (hit.L.cls !== 'dialogue' && hit.L.cls !== 'cue') || hit.L.enlarge === false || sPage <= 1.001) return;
      if (collect) { // measure mode: report line + active clip, mutate nothing
        collect.push({ L: hit.L, clipLo, clipHi, clipUnknown });
        return;
      }
      // Uniform scale about the page's column anchor: x' = C + s*(x - C),
      // anchored on this line's own baseline (nothing moves vertically).
      // Every run on a line gets the same affine map, so multi-run lines
      // (word-per-op or glyph-per-op PDFs) keep letter pitch, word gaps and
      // indents consistent instead of crowding around fixed origins.
      // The per-op delta is computed from device x; ctm x-scale is assumed
      // ~1 (translation/flip only), as everywhere else in this rewriter.
      const ax = ctm[0] || 1;
      const delta = (sPage - 1) * (hit.devX - anchorX) / ax;
      const m = [tlm[0] * sPage, tlm[1] * sPage, tlm[2] * sPage, tlm[3] * sPage,
                 tlm[4] + delta, tlm[5]];
      emit(m.map(fmt).join(' ') + ' Tm');
      scaledRun = true;
      changedHere = true;
      stats.scaledOps++;
    };

    for (const ins of instrs) {
      switch (ins.op) {
        case 'q': gsStack.push([ctm, clipLo, clipHi, clipUnknown]); emitRaw(ins); break;
        case 'Q': {
          const g = gsStack.pop();
          if (g) { ctm = g[0]; clipLo = g[1]; clipHi = g[2]; clipUnknown = g[3]; }
          else { ctm = [1, 0, 0, 1, 0, 0]; clipLo = -Infinity; clipHi = Infinity; clipUnknown = false; }
          restoreIfScaled(); emitRaw(ins); break;
        }
        case 'cm': {
          const m = [0, 1, 2, 3, 4, 5].map(i => num(ins, i));
          ctm = mul(m, ctm); emitRaw(ins); break;
        }
        case 're': {
          const x = num(ins, 0), y = num(ins, 1), w = num(ins, 2), h = num(ins, 3);
          const pts = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x, y + h), apply(ctm, x + w, y + h)];
          pathRects.push([Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0]))]);
          emitRaw(ins); break;
        }
        case 'm': case 'l': case 'c': case 'v': case 'y': case 'h':
          pathOther = true; emitRaw(ins); break;
        case 'W': case 'W*':
          pendingClip = true; emitRaw(ins); break;
        case 'n': case 'f': case 'F': case 'f*': case 'S': case 's':
        case 'B': case 'B*': case 'b': case 'b*':
          applyPendingClip(); emitRaw(ins); break;
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); scaledRun = false; emitRaw(ins); break;
        case 'ET': restoreIfScaled(); tm = tlm = null; emitRaw(ins); break;
        case 'TL': tl = num(ins, 0); emitRaw(ins); break;
        case 'Td': {
          restoreIfScaled();
          tlm = mul([1, 0, 0, 1, num(ins, 0), num(ins, 1)], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'TD': {
          restoreIfScaled();
          tl = -num(ins, 1);
          tlm = mul([1, 0, 0, 1, num(ins, 0), num(ins, 1)], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'Tm': {
          restoreIfScaled();
          tlm = [0, 1, 2, 3, 4, 5].map(i => num(ins, i));
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'T*': {
          restoreIfScaled();
          tlm = mul([1, 0, 0, 1, 0, -tl], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice(); emitRaw(ins); break;
        }
        case 'Tj': case 'TJ': {
          beginScaledIfDialogue();
          emitRaw(ins); break;
        }
        case "'": {
          restoreIfScaled();
          tlm = mul([1, 0, 0, 1, 0, -tl], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice();
          // decompose so the scaled matrix can be injected between move & show
          beginScaledIfDialogue();
          if (scaledRun) emit(ins.operands.map(o => o.raw).join(' ') + ' Tj');
          else { emit('T*'); emit(ins.operands.map(o => o.raw).join(' ') + ' Tj'); }
          if (!scaledRun) break;
          break;
        }
        case '"': {
          restoreIfScaled();
          emit(fmt(num(ins, 0)) + ' Tw'); emit(fmt(num(ins, 1)) + ' Tc');
          tlm = mul([1, 0, 0, 1, 0, -tl], tlm || [1, 0, 0, 1, 0, 0]);
          tm = tlm.slice();
          beginScaledIfDialogue();
          const strTok = ins.operands[2] ? ins.operands[2].raw : '()';
          if (scaledRun) emit(strTok + ' Tj');
          else { emit('T*'); emit(strTok + ' Tj'); }
          break;
        }
        case 'Do': {
          const nameTok = ins.operands[0];
          if (onDo && nameTok && nameTok.raw[0] === '/') {
            try { if (onDo(nameTok.raw.slice(1), ctm)) changedHere = changedHere || false; } catch (e) { stats.warnings.push('form xobject skipped: ' + (e && e.message || e)); }
          }
          emitRaw(ins); break;
        }
        case 'BI_RAW': return { out: null, changed: false, bail: true };
        default:
          emitRaw(ins);
      }
    }
    return { out: out.join('\n'), changed: changedHere, bail: false };
  }

  // Header/footer furniture for whole-page mode: rows in the top/bottom page
  // zones whose digit-stripped text repeats on at least half the pages (show
  // name headers, CONTINUED: rows, (CONTINUED) footers, page-number rows).
  // Furniture is page identity: it never scales, and its tight internal line
  // gaps must not cap the body's enlargement.
  function markFurniture(pages) {
    const zoneOf = (L, P) => (L.y > P.height * 0.85 ? 'top' : (L.y < P.height * 0.12 ? 'bot' : null));
    const keyOf = L => L.text.replace(/[0-9]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
    const seen = new Map(); // zone+key -> Set of page indexes
    for (const P of pages) {
      for (const L of P.lines) {
        const z = zoneOf(L, P);
        if (!z || L.cls === 'dialogue' || L.cls === 'cue') continue;
        const k = z + '|' + keyOf(L);
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k).add(P.index);
      }
    }
    const need = Math.max(2, Math.ceil(pages.length / 2));
    for (const P of pages) {
      for (const L of P.lines) {
        const z = zoneOf(L, P);
        if (!z || L.cls === 'dialogue' || L.cls === 'cue') continue;
        const k = keyOf(L);
        if (!k || (seen.get(z + '|' + k) || new Set()).size >= need) L.furn = true;
      }
    }
  }

  // ---------- highlighting ----------
  // Translucent-pastel effect via a Multiply-blend fill painted AFTER the page
  // content: white paper becomes the pastel, black glyphs stay black, and any
  // opaque white background fills inside form XObjects (real sides have them)
  // can't hide the highlight. Glyphs are never altered or overlaid with
  // opaque ink — text stays crisp, selectable and printable, and every color
  // is light enough (luminance >= ~0.87) that grayscale printing keeps full
  // text contrast.
  const PALETTE = [
    { key: 'yellow',   hex: '#FFF39E', rgb: [1.000, 0.953, 0.620] },
    { key: 'mint',     hex: '#D5F4DA', rgb: [0.835, 0.957, 0.855] },
    { key: 'sky',      hex: '#D3E9FA', rgb: [0.827, 0.914, 0.980] },
    { key: 'lavender', hex: '#E5DDF7', rgb: [0.898, 0.867, 0.969] },
    { key: 'peach',    hex: '#FFE3CB', rgb: [1.000, 0.890, 0.796] },
    { key: 'pink',     hex: '#FBDAE7', rgb: [0.984, 0.855, 0.906] },
    { key: 'sage',     hex: '#E2EDD8', rgb: [0.886, 0.929, 0.847] },
    { key: 'sand',     hex: '#F0E6D1', rgb: [0.941, 0.902, 0.820] },
  ];

  function roundedRectPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    const k = 0.5523 * r;
    const f = fmt;
    return [
      `${f(x + r)} ${f(y)} m`,
      `${f(x + w - r)} ${f(y)} l`,
      `${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)} c`,
      `${f(x + w)} ${f(y + h - r)} l`,
      `${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)} c`,
      `${f(x + r)} ${f(y + h)} l`,
      `${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)} c`,
      `${f(x)} ${f(y + r)} l`,
      `${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)} c`,
      'h',
    ].join('\n');
  }

  // One rounded rect per cue-led block of a highlighted character: covers the
  // cue line, parentheticals, (MORE) and every dialogue line, at the page's
  // APPLIED scale (same uniform-anchor map as the rewriter, so the rect lands
  // on the enlarged text). Dual-dialogue blocks are never painted.
  // pageAnchor (whole-page mode): every line, cue included, scales about the
  // page's content-center anchor instead of only dialogue about the column.
  function highlightRectsForPage(P, cal, s, hl, pageAnchor) {
    const out = [];
    if (!P.blocks || !P.blocks.length) return out;
    const C = pageAnchor != null ? pageAnchor : cal.dialX + cal.colW / 2;
    for (const B of P.blocks) {
      const idx = hl[B.name];
      const pal = idx != null && PALETTE[idx];
      if (!pal) continue;
      if (!B.lines.some(l => l.cls === 'dialogue')) continue;
      let x0 = Infinity, x1 = -Infinity, top = -Infinity, bot = Infinity;
      for (const L of [B.cue, ...B.lines]) {
        const scaled = s > 1.001 && (pageAnchor != null
          ? L.ax0 != null
          : ((L.cls === 'dialogue' || L.cls === 'cue') && L.enlarge !== false));
        const eff = scaled ? s : 1;
        const lx0 = pageAnchor != null && L.ax0 != null ? L.ax0 : (L.dx0 != null ? L.dx0 : L.x0);
        const lx1 = pageAnchor != null && L.ax1 != null ? L.ax1 : (L.dx1 != null ? L.dx1 : L.x1);
        x0 = Math.min(x0, scaled ? C + s * (lx0 - C) : lx0);
        x1 = Math.max(x1, scaled ? C + s * (lx1 - C) : lx1);
        const size = median(L.items.map(i => i.size)) || 12;
        top = Math.max(top, L.y + 0.78 * size * eff);
        bot = Math.min(bot, L.y - 0.24 * size * eff);
      }
      out.push({ x: x0 - 3, y: bot - 1.5, w: x1 - x0 + 6, h: top - bot + 3, rgb: pal.rgb, name: B.name });
    }
    return out;
  }

  // ---------- public API ----------
  return function createSidesEngine({ pdfjsLib, PDFLib }) {

    async function extract(bytes) {
      const task = pdfjsLib.getDocument({
        data: bytes.slice(), useSystemFonts: true, isEvalSupported: false, disableFontFace: true,
      });
      const doc = await task.promise;
      const pages = [];
      let totalChars = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const items = tc.items
          .filter(it => it.str && it.str.trim().length)
          .map(it => ({
            str: it.str,
            x: it.transform[4], y: it.transform[5],
            w: it.width, size: Math.hypot(it.transform[2], it.transform[3]),
          }));
        for (const it of items) totalChars += it.str.length;
        pages.push({ index: p, width: vp.viewBox[2] - vp.viewBox[0], height: vp.viewBox[3] - vp.viewBox[1], lines: buildLines(items) });
      }
      await doc.destroy();
      return { pages, totalChars };
    }

    const scannedError = () => {
      const err = new Error('No extractable text found — this looks like a scanned PDF. Sides Enlarger v1 needs a text-based PDF (ask production for the original export).');
      err.code = 'SCANNED';
      return err;
    };

    // Extraction-only pass: characters + per-page summary, no rewrite.
    async function analyze(bytes) {
      const { pages, totalChars } = await extract(bytes);
      if (totalChars < 40) throw scannedError();
      const cal = calibrate(pages);
      if (cal) for (const P of pages) classifyPage(P, cal);
      return {
        calibration: cal,
        characters: cal ? collectCharacters(pages) : [],
        pages: pages.map(P => ({ page: P.index, dialogueLines: P.lines.filter(l => l.cls === 'dialogue').length, hasDual: !!P.hasDual })),
      };
    }

    async function process(bytes, opts = {}) {
      const requested = Math.min(1.5, Math.max(1.0, opts.scale || 1.25));
      const { pages, totalChars } = await extract(bytes);

      if (totalChars < 40) throw scannedError();

      // mode: 'dialogue' (default) scales dialogue runs in place around their
      // baselines; 'page' zooms the ENTIRE page uniformly toward the margins.
      const mode = opts.mode === 'page' ? 'page' : 'dialogue';
      // optional selective enlargement: only these characters' dialogue grows
      let enlargeSet = null;
      if (mode === 'dialogue' && opts.enlargeOnly != null) {
        enlargeSet = new Set((opts.enlargeOnly || []).map(normalizeCueName).filter(Boolean));
      }

      // requested highlights: { CHARACTER NAME: palette index }
      const hl = {};
      if (opts.highlights) {
        for (const k of Object.keys(opts.highlights)) {
          const idx = opts.highlights[k];
          if (idx == null || !PALETTE[idx]) continue;
          const n = normalizeCueName(k);
          if (n) hl[n] = idx;
        }
      }

      const cal = calibrate(pages);
      const report = { requestedScale: requested, mode, calibration: cal, pages: [], warnings: [] };
      report.enlargeOnly = enlargeSet ? Array.from(enlargeSet) : null;
      if (!cal) {
        report.warnings.push('Could not locate character cues geometrically — layout too unusual. PDF returned unchanged.');
        report.characters = [];
        return { bytes, report };
      }
      const wantHl = Object.keys(hl).length > 0;

      // classify + per-page scale
      const widths = [];
      for (const P of pages) {
        classifyPage(P, cal);
        for (const L of P.lines) if (L.cls === 'dialogue') widths.push((L.dx1 != null ? L.dx1 : L.x1) - (L.dx0 != null ? L.dx0 : L.x0));
      }
      const colW = Math.min(300, Math.max(200, quantile(widths, 0.9) || 252));
      cal.colW = colW;
      const anchorC = cal.dialX + colW / 2; // uniform-scale anchor (see pageScale)
      report.characters = collectCharacters(pages);
      // the character name grows with its block: a block's cue is eligible
      // whenever the block has eligible dialogue (a bare cue-shaped label
      // with no dialogue under it never scales)
      for (const P of pages) {
        for (const B of (P.blocks || [])) {
          const on = (enlargeSet ? enlargeSet.has(B.name) : true) &&
            B.lines.some(l => l.cls === 'dialogue');
          B.cue.enlarge = on;
          if (enlargeSet) for (const L of B.lines) L.enlarge = on;
        }
        // defensive: any dialogue line outside a block stays untouched
        if (enlargeSet) for (const L of P.lines) if (L.cls === 'dialogue' && L.enlarge === undefined) L.enlarge = false;
      }
      if (wantHl) {
        report.highlights = {};
        for (const n of Object.keys(hl)) report.highlights[n] = { palette: hl[n], key: PALETTE[hl[n]].key, rgb: PALETTE[hl[n]].rgb };
      }

      const pdfDoc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
      const ctx = pdfDoc.context;
      const wasEncrypted = await decryptInPlace(PDFLib, pdfDoc);
      if (wasEncrypted) report.warnings.push('Input was permission-locked (encrypted); output is a decrypted copy — treat it with the same care as the original.');
      const pdfPages = pdfDoc.getPages();
      if (pdfPages.length !== pages.length) throw new Error('internal: page count mismatch between parsers');

      const N = PDFLib.PDFName.of.bind(PDFLib.PDFName);
      const latinOf = u8 => { let s = ''; for (let b = 0; b < u8.length; b++) s += String.fromCharCode(u8[b]); return s; };
      const bytesOfLatin = str => { const a = new Uint8Array(str.length); for (let b = 0; b < str.length; b++) a[b] = str.charCodeAt(b) & 0xff; return a; };
      const decodeStream = st => {
        const hasFilter = st.dict && st.dict.get(N('Filter'));
        if (st instanceof PDFLib.PDFRawStream) return hasFilter ? PDFLib.decodePDFRawStream(st).decode() : st.contents;
        if (st.getContents) return st.getContents();
        return new Uint8Array(0);
      };
      const putStreamPlain = (st, str) => {
        const b = bytesOfLatin(str);
        st.contents = b;
        st.dict.set(N('Length'), PDFLib.PDFNumber.of(b.length));
        st.dict.delete(N('Filter'));
        st.dict.delete(N('DecodeParms'));
        st.dict.delete(N('DL'));
      };
      const matrixOf = dict => {
        const mArr = dict && dict.get(N('Matrix'));
        const r = mArr && ctx.lookup(mArr);
        if (r && r.size && r.size() === 6) return [0, 1, 2, 3, 4, 5].map(k => ctx.lookup(r.get(k)).asNumber());
        return [1, 0, 0, 1, 0, 0];
      };
      const visitedForms = new Set();

      // Recursively rewrite a content string, descending into form XObjects.
      // `resources` is the PDFDict in whose /XObject a `Do` name resolves.
      // `visited` guards shared forms per traversal; `collect` switches the
      // whole walk into measure mode (see rewriteStream).
      const rewriteLevel = (src, ctm0, resources, dialogLines, sPage, anchorX, stats, visited, collect) => {
        const onDo = (name, ctmAtDo) => {
          if (!resources) return false;
          const xoDictRef = resources.get(N('XObject'));
          const xoDict = xoDictRef && ctx.lookup(xoDictRef);
          if (!xoDict) return false;
          const ref = xoDict.get(N(name));
          if (!ref) return false;
          const form = ctx.lookup(ref);
          if (!form || !form.dict) return false;
          const sub = form.dict.get(N('Subtype'));
          if (!sub || sub.toString() !== '/Form') return false; // images etc: leave
          const key = ref.objectNumber + '_' + ref.generationNumber;
          if (visited.has(key)) return false; // already handled (shared form)
          visited.add(key);
          const innerCtm = mul(matrixOf(form.dict), ctmAtDo);
          const fResRef = form.dict.get(N('Resources'));
          const fRes = fResRef ? ctx.lookup(fResRef) : resources;
          const innerSrc = latinOf(decodeStream(form));
          const res = rewriteLevel(innerSrc, innerCtm, fRes, dialogLines, sPage, anchorX, stats, visited, collect);
          if (res.changed && !res.bail && res.out != null) { putStreamPlain(form, res.out); return true; }
          return false;
        };
        return rewriteStream(src, ctm0, dialogLines, sPage, anchorX, stats, onDo, collect);
      };

      // ---- highlight painting plumbing (shared ExtGState, appended stream) ----
      let hlGsRef = null;
      const HL_GS = N('GSsidesHL');
      const ensureHlGs = page => {
        if (!hlGsRef) {
          const gs = ctx.obj({});
          gs.set(N('Type'), N('ExtGState'));
          gs.set(N('BM'), N('Multiply'));
          gs.set(N('ca'), PDFLib.PDFNumber.of(1));
          gs.set(N('CA'), PDFLib.PDFNumber.of(1));
          hlGsRef = ctx.register(gs);
        }
        let res = page.node.Resources ? page.node.Resources() : ctx.lookup(page.node.get(N('Resources')));
        if (!res) { res = ctx.obj({}); page.node.set(N('Resources'), res); }
        let egDict = res.get(N('ExtGState')) && ctx.lookup(res.get(N('ExtGState')));
        if (!egDict) { egDict = ctx.obj({}); res.set(N('ExtGState'), egDict); }
        egDict.set(HL_GS, hlGsRef);
      };
      const paintHighlights = (page, rects) => {
        ensureHlGs(page);
        let ops = 'q\n/GSsidesHL gs\n';
        for (const R of rects) {
          ops += `${fmt(R.rgb[0])} ${fmt(R.rgb[1])} ${fmt(R.rgb[2])} rg\n`;
          ops += roundedRectPath(R.x, R.y, R.w, R.h, 3.5) + '\nf\n';
        }
        ops += 'Q';
        const streamRef = ctx.register(ctx.flateStream(bytesOfLatin(ops)));
        const cur = page.node.get(N('Contents'));
        const resolved = ctx.lookup(cur);
        const arr = ctx.obj([]);
        if (resolved instanceof PDFLib.PDFArray) {
          for (let k = 0; k < resolved.size(); k++) arr.push(resolved.get(k));
        } else if (cur) arr.push(cur);
        arr.push(streamRef);
        page.node.set(N('Contents'), arr);
      };

      if (mode === 'page') {
        // "Make it all bigger": every body text line grows around its own
        // unmoved baseline under one per-page horizontal map x' = s*x + t,
        // fitted so the widest stage-direction line spans the full printable
        // width and dialogue widens by the same factor. Margin furniture
        // (left scene numbers, revision stars, page numbers) and repeated
        // header/footer rows stay put exactly. Growth is capped by the page
        // edges, margin marks, clips, and line spacing so ascenders and
        // descenders of adjacent lines don't collide. Baselines never move,
        // so parity stays structural.
        const E = 10, ML = 70;
        markFurniture(pages);
        for (let i = 0; i < pdfPages.length; i++) {
          const P = pages[i];
          const page = pdfPages[i];
          const marginR = P.width - 80;
          const pageReport = { page: i + 1, appliedScale: requested, dialogueLines: P.lines.filter(l => l.cls === 'dialogue').length, warnings: [] };
          report.pages.push(pageReport);

          // a script page has dialogue on it; title pages, coverage, call
          // sheets and revision tables don't, and are never enlarged
          if (!pageReport.dialogueLines) {
            pageReport.appliedScale = 1;
            if (requested > 1.001) pageReport.warnings.push('no dialogue on this page: left at original size (title, coverage and call-sheet pages are not enlarged)');
            continue;
          }

          // split each line: body items scale; margin-mark items and
          // header/footer furniture don't. Item-level split by x thresholds
          // (NOT gap-based segments): left scene numbers sit closer than a
          // segment gap to the slug text and must never ride with the body.
          const body = [];
          const sRows = []; // all printed rows, for the line-spacing fit
          let bx0 = Infinity, bx1 = -Infinity;
          for (const L of P.lines) {
            if (!L.items.length) continue;
            const bs = L.furn ? [] : L.items.filter(t => t.x + t.w > ML && t.x < marginR);
            if (!bs.length) { L.ax0 = L.ax1 = null; sRows.push({ L, fixed: true }); continue; }
            L.ax0 = Math.min(...bs.map(t => t.x));
            L.ax1 = Math.max(...bs.map(t => t.x + t.w));
            const lm = L.items.filter(t => t.x + t.w <= ML);
            const rm = L.items.filter(t => t.x >= marginR);
            L.leftStop = lm.length ? Math.max(...lm.map(t => t.x + t.w)) + 4 : E;
            L.rightStop = rm.length ? Math.min(...rm.map(t => t.x)) - 4 : P.width - E;
            bx0 = Math.min(bx0, L.ax0); bx1 = Math.max(bx1, L.ax1);
            body.push(L);
            sRows.push({ L, fixed: false });
          }
          if (!body.length) { pageReport.appliedScale = 1; continue; }

          // spacing limit: descender above + ascender below <= baseline gap
          // (Courier metrics ~0.157/0.629 em, held slightly safe). Fixed rows
          // (furniture, margin marks) don't scale, so only the scaled side of
          // a mixed pair consumes the gap.
          let sV = requested;
          sRows.sort((p, q) => q.L.y - p.L.y);
          for (let k = 0; k + 1 < sRows.length; k++) {
            const gap = sRows[k].L.y - sRows[k + 1].L.y;
            if (gap < 6) continue; // same visual row (dual columns etc.)
            const du = 0.16 * (median(sRows[k].L.items.map(t => t.size)) || 12);
            const al = 0.64 * (median(sRows[k + 1].L.items.map(t => t.size)) || 12);
            let lim = Infinity;
            if (!sRows[k].fixed && !sRows[k + 1].fixed) lim = gap / (du + al);
            else if (sRows[k].fixed && !sRows[k + 1].fixed) lim = al > 0.01 ? (gap - du) / al : Infinity;
            else if (!sRows[k].fixed && sRows[k + 1].fixed) lim = du > 0.01 ? (gap - al) / du : Infinity;
            sV = Math.min(sV, lim);
          }

          // every body line becomes an eligible "dialogue" proxy spanning its
          // body extent, carrying its own horizontal stops
          const proxies = body.map(L => ({
            y: L.y, x0: L.ax0, x1: L.ax1, dx0: L.ax0, dx1: L.ax1,
            cls: 'dialogue', leftStop: L.leftStop, rightStop: L.rightStop,
          }));
          const resolved = ctx.lookup(page.node.get(N('Contents')));
          const streams = [];
          if (resolved instanceof PDFLib.PDFArray) {
            for (let k = 0; k < resolved.size(); k++) streams.push(ctx.lookup(resolved.get(k)));
          } else if (resolved) streams.push(resolved);
          let latin = '';
          for (const st of streams) latin += latinOf(decodeStream(st)) + '\n';
          const pageRes = page.node.Resources ? page.node.Resources() : ctx.lookup(page.node.get(N('Resources')));

          // the horizontal map is x' = s*x + t; find the largest s (then a t)
          // that keeps every body line inside its stops
          const tRange = s => {
            let lo = -Infinity, hi = Infinity;
            for (const pr of proxies) {
              lo = Math.max(lo, pr.leftStop - s * pr.dx0);
              hi = Math.min(hi, pr.rightStop - s * pr.dx1);
            }
            return [lo, hi];
          };
          const maxFeasible = () => {
            let loS = 1, hiS = requested;
            const r = tRange(hiS);
            if (r[0] <= r[1] + 1e-6) return hiS;
            for (let it = 0; it < 24; it++) {
              const mid = (loS + hiS) / 2;
              const rm = tRange(mid);
              if (rm[0] <= rm[1] + 1e-6) loS = mid; else hiS = mid;
            }
            return loS;
          };
          const sGeoNoClip = maxFeasible();

          // clip limit (measure pass): text must never grow out of its clip
          // rect (table cells, row bands) or it gets cut off invisibly. Clips
          // tighten the per-line stops before the final fit.
          let clipBlocked = false;
          if (requested > 1.001) {
            const constraints = [];
            const mstats = { scaledOps: 0, warnings: [] };
            rewriteLevel(latin, [1, 0, 0, 1, 0, 0], pageRes, proxies, requested, 0, mstats, new Set(), constraints);
            for (const c of constraints) {
              if (c.clipUnknown) { clipBlocked = true; break; }
              if (c.clipLo > -Infinity) c.L.leftStop = Math.max(c.L.leftStop, c.clipLo + 0.5);
              if (c.clipHi < Infinity) c.L.rightStop = Math.min(c.L.rightStop, c.clipHi - 0.5);
            }
          }
          const sGeo = clipBlocked ? 1 : maxFeasible();

          const s = Math.max(1, Math.floor(Math.min(requested, sV, sGeo) * 100) / 100);
          pageReport.appliedScale = s;
          if (s < requested - 0.005) {
            pageReport.warnings.push(sGeo < sGeoNoClip - 0.005 && sGeo <= sV
              ? `clipped layout (table cells) limits enlargement to ${s.toFixed(2)}x on this page`
              : (sV <= sGeo
                ? `line spacing limits enlargement to ${s.toFixed(2)}x on this page`
                : `text reaches the page edge at ${s.toFixed(2)}x on this page`));
          }

          if (s > 1.001) {
            // place the map: center the grown body in its feasible band, and
            // express s*x + t as the equivalent anchor A = t/(1-s) so the
            // rewriter, highlights and verifier share one form
            const [tLo, tHi] = tRange(s);
            const tCenter = P.width / 2 - s * (bx0 + bx1) / 2;
            const t = Math.min(Math.max(tCenter, tLo), tHi);
            const anchor = t / (1 - s);
            pageReport.anchor = Math.round(anchor * 100) / 100;

            const stats = { scaledOps: 0, warnings: [] };
            const res = rewriteLevel(latin, [1, 0, 0, 1, 0, 0], pageRes, proxies, s, anchor, stats, visitedForms);
            for (const w of stats.warnings) if (pageReport.warnings.indexOf(w) === -1) pageReport.warnings.push(w);
            if (!stats.scaledOps) {
              pageReport.warnings.push('rewriter matched no text — page left unchanged');
              pageReport.appliedScale = 1;
            } else if (res.changed && !res.bail && res.out != null) {
              const ref = ctx.register(ctx.flateStream(bytesOfLatin(res.out)));
              page.node.set(N('Contents'), ref);
            }

            if (wantHl) {
              const rects = highlightRectsForPage(P, cal, pageReport.appliedScale, hl, anchor);
              if (rects.length) {
                paintHighlights(page, rects);
                pageReport.highlighted = rects.map(r => r.name);
              }
            }
          } else if (wantHl) {
            const rects = highlightRectsForPage(P, cal, 1, hl, 0);
            if (rects.length) {
              paintHighlights(page, rects);
              pageReport.highlighted = rects.map(r => r.name);
            }
          }
          if (wantHl && (P.dualNames || []).some(n => hl[n] != null)) {
            pageReport.warnings.push('a highlighted character appears in a dual-dialogue block on this page — dual dialogue is not highlighted');
          }
        }
        const outBytes = await pdfDoc.save({ useObjectStreams: false });
        return { bytes: outBytes, report };
      }

      for (let i = 0; i < pdfPages.length; i++) {
        const P = pages[i];
        const page = pdfPages[i];
        const pageReport = { page: i + 1, appliedScale: requested, dialogueLines: P.lines.filter(l => l.cls === 'dialogue').length, warnings: [] };
        report.pages.push(pageReport);
        if (P.hasDual) pageReport.warnings.push('dual-dialogue block detected — left at original size');
        pageReport.enlargedLines = P.lines.filter(l => l.cls === 'dialogue' && l.enlarge !== false).length;
        if (!pageReport.enlargedLines) pageReport.appliedScale = 1;

        if (pageReport.enlargedLines) {
          const s = pageScale(P, requested, colW, cal.dialX);
          pageReport.appliedScale = s;
          if (s < requested - 0.005) pageReport.warnings.push(`enlarged dialogue would not fit — backed off to ${s.toFixed(2)}x on this page`);
          if (s <= 1.001) {
            if (requested > 1.001) pageReport.warnings.push('no enlargement possible without overflowing the page');
            pageReport.appliedScale = 1;
          } else {
            // gather decoded page content (may be an array of streams)
            const resolved = ctx.lookup(page.node.get(N('Contents')));
            const streams = [];
            if (resolved instanceof PDFLib.PDFArray) {
              for (let k = 0; k < resolved.size(); k++) streams.push(ctx.lookup(resolved.get(k)));
            } else if (resolved) streams.push(resolved);
            let latin = '';
            for (const st of streams) latin += latinOf(decodeStream(st)) + '\n';

            const pageRes = page.node.Resources ? page.node.Resources() : ctx.lookup(page.node.get(N('Resources')));
            const dialogLines = P.lines.filter(l => l.cls === 'dialogue' || l.cls === 'cue' || l.cls === 'more' || l.cls === 'dual');
            const stats = { scaledOps: 0, warnings: [] };
            const res = rewriteLevel(latin, [1, 0, 0, 1, 0, 0], pageRes, dialogLines, s, anchorC, stats, visitedForms);
            for (const w of stats.warnings) if (pageReport.warnings.indexOf(w) === -1) pageReport.warnings.push(w);

            if (!stats.scaledOps) {
              pageReport.warnings.push('classifier found dialogue but rewriter matched none — page left unchanged');
              pageReport.appliedScale = 1;
            } else if (res.changed && !res.bail && res.out != null) {
              // Text may have lived inside form XObjects (mutated in place
              // already); only replace the page content stream if the page
              // level itself changed.
              const newStream = ctx.flateStream(bytesOfLatin(res.out));
              const ref = ctx.register(newStream);
              page.node.set(N('Contents'), ref);
            }
          }
        }

        // Highlights compose with enlargement but don't depend on it — they
        // paint at whatever scale this page actually got (including 1.0).
        if (wantHl) {
          const rects = highlightRectsForPage(P, cal, pageReport.appliedScale, hl);
          if (rects.length) {
            paintHighlights(page, rects);
            pageReport.highlighted = rects.map(r => r.name);
          }
          if ((P.dualNames || []).some(n => hl[n] != null)) {
            pageReport.warnings.push('a highlighted character appears in a dual-dialogue block on this page — dual dialogue is not highlighted');
          }
        }
      }

      const outBytes = await pdfDoc.save({ useObjectStreams: false });
      return { bytes: outBytes, report };
    }

    return { process, extract, analyze, PALETTE };
  };
});
