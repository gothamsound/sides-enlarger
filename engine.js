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
  const mode2pt = a => { // most common value, 2pt buckets
    if (!a.length) return NaN;
    const c = new Map();
    for (const v of a) { const k = Math.round(v / 2) * 2; c.set(k, (c.get(k) || 0) + 1); }
    let best = null, n = -1;
    for (const [k, v] of c) if (v > n) { n = v; best = k; }
    // refine: median of members of winning bucket
    return median(a.filter(v => Math.abs(v - best) <= 2));
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
      // segments: item clusters split at horizontal gaps > 40pt (dual dialogue)
      L.segments = [];
      for (const it of L.items) {
        const S = L.segments[L.segments.length - 1];
        if (S && it.x - S.x1 <= 40) { S.items.push(it); S.x1 = Math.max(S.x1, it.x + it.w); S.text += ' ' + it.str; }
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
  const isCueLine = (L, band) =>
    L.segments.length === 1 &&
    capsy(L.text) && L.text.trim().length <= 42 &&
    L.x0 >= band[0] && L.x0 <= band[1] &&
    !/\b(INT|EXT)\s*[.\/]/.test(L.text) &&
    !/(CUT TO|FADE (IN|OUT)|DISSOLVE)/.test(L.text);

  function calibrate(pages) {
    const CUE_BAND = [200, 340]; // 2.8"–4.7" initial guess, then refined
    const cueXs = [];
    for (const P of pages) for (const L of P.lines) if (isCueLine(L, CUE_BAND)) cueXs.push(L.x0);
    if (cueXs.length < 2) return null;
    const cueX = median(cueXs);
    // dialogue x0: lines directly below a cue, indented left of it
    const dialXs = [];
    for (const P of pages) {
      for (let i = 0; i < P.lines.length; i++) {
        if (!isCueLine(P.lines[i], [cueX - 12, cueX + 12])) continue;
        const nxt = P.lines[i + 1];
        if (nxt && P.lines[i].y - nxt.y < 3 * LEAD &&
            nxt.x0 > cueX - 130 && nxt.x0 < cueX - 30) dialXs.push(nxt.x0);
      }
    }
    const dialX = dialXs.length ? mode2pt(dialXs) : cueX - 86;
    const parenXs = [];
    for (const P of pages) for (const L of P.lines)
      if (/^\(/.test(L.text.trim()) && L.x0 > dialX + 6 && L.x0 < dialX + 70) parenXs.push(L.x0);
    const parenX = parenXs.length ? mode2pt(parenXs) : dialX + 43;
    return { cueX, dialX, parenX };
  }

  function classifyPage(P, cal) {
    // walk top -> bottom; dialogue = in a block opened by a character cue
    let inBlock = false, dualMode = false, prevY = null;
    for (const L of P.lines) {
      if (prevY !== null && prevY - L.y > 28) inBlock = false; // big vertical gap
      prevY = L.y;
      const dualCueRow = L.segments.length >= 2 &&
        L.segments.every(s => capsy(s.text) && s.text.trim().length <= 30);
      if (dualCueRow) { L.cls = 'dual'; dualMode = true; inBlock = false; P.hasDual = true; continue; }
      if (dualMode) {
        if (L.segments.length >= 2) { L.cls = 'dual'; P.hasDual = true; continue; }
        dualMode = false;
      }
      if (isCueLine(L, [cal.cueX - 12, cal.cueX + 12])) { L.cls = 'cue'; inBlock = true; continue; }
      if (inBlock && (near(L.x0, cal.dialX, 9) || near(L.x0, cal.parenX, 9))) {
        L.cls = /^\(\s*MORE\s*\)\s*$/i.test(L.text.trim()) ? 'more' : 'dialogue';
        setDialExtent(L, P.width);
        continue;
      }
      L.cls = 'other'; inBlock = false;
    }
  }

  // Dialogue extent excludes right-margin marks (revision asterisks, scene
  // continuation *, etc.) which sit far right and must never be scaled or
  // counted toward the fit calculation.
  function setDialExtent(L, pageW) {
    const marginStart = pageW - 80; // ~1.1" from right edge
    const segs = L.segments.filter(s => s.x0 < marginStart);
    if (segs.length) {
      L.dx0 = Math.min(...segs.map(s => s.x0));
      L.dx1 = Math.max(...segs.map(s => s.x1));
    } else { L.dx0 = L.x0; L.dx1 = L.x1; }
  }

  function pageScale(P, requested, colW) {
    // max uniform scale so every dialogue line stays on the page after the
    // half-width left shift; back off (never reflow) when it doesn't fit
    let s = requested;
    for (const L of P.lines) {
      if (L.cls !== 'dialogue') continue;
      const x0 = L.dx0 != null ? L.dx0 : L.x0;
      const x1 = L.dx1 != null ? L.dx1 : L.x1;
      const w = x1 - x0;
      // left edge: x0 - (s-1)*colW/2 >= EDGE
      const sLeft = 1 + 2 * (x0 - EDGE) / colW;
      // right edge: x0 - (s-1)*colW/2 + s*w <= pageW - EDGE
      const denom = w - colW / 2;
      const sRight = denom > 0 ? (P.width - EDGE - x0 - colW / 2) / denom : Infinity;
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
  function rewriteStream(src, ctm0, dialogLines, sPage, shift, stats, onDo) {
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
    const ctmStack = [];
    let tm = null, tlm = null, tl = 0;
    let scaledRun = false; // currently inside an injected-scale run
    let changedHere = false;

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
        if (Math.abs(dev[1] - L.y) <= 2.5 && dev[0] >= lo && dev[0] <= hi) return L;
      }
      return null;
    };
    const beginScaledIfDialogue = () => {
      if (scaledRun) return; // continuing same run: advances already scaled
      const L = classifyShow();
      if (!L || L.cls !== 'dialogue' || sPage <= 1.001) return;
      // scale glyphs around this line's own baseline; shift left by half the
      // growth (in text-space x, ctm assumed ~unscaled) so the enlarged column
      // stays horizontally put and the baseline never moves.
      const m = [tlm[0] * sPage, tlm[1] * sPage, tlm[2] * sPage, tlm[3] * sPage,
                 tlm[4] - shift, tlm[5]];
      emit(m.map(fmt).join(' ') + ' Tm');
      scaledRun = true;
      changedHere = true;
      stats.scaledOps++;
    };

    for (const ins of instrs) {
      switch (ins.op) {
        case 'q': ctmStack.push(ctm); emitRaw(ins); break;
        case 'Q': ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0]; restoreIfScaled(); emitRaw(ins); break;
        case 'cm': {
          const m = [0, 1, 2, 3, 4, 5].map(i => num(ins, i));
          ctm = mul(m, ctm); emitRaw(ins); break;
        }
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

    async function process(bytes, opts = {}) {
      const requested = Math.min(1.5, Math.max(1.0, opts.scale || 1.25));
      const { pages, totalChars } = await extract(bytes);

      if (totalChars < 40) {
        const err = new Error('No extractable text found — this looks like a scanned PDF. Sides Enlarger v1 needs a text-based PDF (ask production for the original export).');
        err.code = 'SCANNED';
        throw err;
      }

      const cal = calibrate(pages);
      const report = { requestedScale: requested, calibration: cal, pages: [], warnings: [] };
      if (!cal) {
        report.warnings.push('Could not locate character cues geometrically — layout too unusual. PDF returned unchanged.');
        return { bytes, report };
      }

      // classify + per-page scale
      const widths = [];
      for (const P of pages) {
        classifyPage(P, cal);
        for (const L of P.lines) if (L.cls === 'dialogue') widths.push((L.dx1 != null ? L.dx1 : L.x1) - (L.dx0 != null ? L.dx0 : L.x0));
      }
      const colW = Math.min(300, Math.max(200, quantile(widths, 0.9) || 252));
      cal.colW = colW;

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
      const rewriteLevel = (src, ctm0, resources, dialogLines, sPage, shift, stats) => {
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
          if (visitedForms.has(key)) return false; // already handled (shared form)
          visitedForms.add(key);
          const innerCtm = mul(matrixOf(form.dict), ctmAtDo);
          const fResRef = form.dict.get(N('Resources'));
          const fRes = fResRef ? ctx.lookup(fResRef) : resources;
          const innerSrc = latinOf(decodeStream(form));
          const res = rewriteLevel(innerSrc, innerCtm, fRes, dialogLines, sPage, shift, stats);
          if (res.changed && !res.bail && res.out != null) { putStreamPlain(form, res.out); return true; }
          return false;
        };
        return rewriteStream(src, ctm0, dialogLines, sPage, shift, stats, onDo);
      };

      for (let i = 0; i < pdfPages.length; i++) {
        const P = pages[i];
        const pageReport = { page: i + 1, appliedScale: requested, dialogueLines: P.lines.filter(l => l.cls === 'dialogue').length, warnings: [] };
        report.pages.push(pageReport);
        if (P.hasDual) pageReport.warnings.push('dual-dialogue block detected — left at original size');
        if (!pageReport.dialogueLines) { pageReport.appliedScale = 1; continue; }

        const s = pageScale(P, requested, colW);
        pageReport.appliedScale = s;
        if (s < requested - 0.005) pageReport.warnings.push(`enlarged dialogue would not fit — backed off to ${s.toFixed(2)}x on this page`);
        if (s <= 1.001) { pageReport.warnings.push('no enlargement possible without overflowing the page'); continue; }
        const shift = (s - 1) * colW / 2;

        // gather decoded page content (may be an array of streams)
        const page = pdfPages[i];
        const resolved = ctx.lookup(page.node.get(N('Contents')));
        const streams = [];
        if (resolved instanceof PDFLib.PDFArray) {
          for (let k = 0; k < resolved.size(); k++) streams.push(ctx.lookup(resolved.get(k)));
        } else if (resolved) streams.push(resolved);
        let latin = '';
        for (const st of streams) latin += latinOf(decodeStream(st)) + '\n';

        const pageRes = page.node.Resources ? page.node.Resources() : ctx.lookup(page.node.get(N('Resources')));
        const dialogLines = P.lines.filter(l => l.cls === 'dialogue' || l.cls === 'more' || l.cls === 'dual');
        const stats = { scaledOps: 0, warnings: [] };
        const res = rewriteLevel(latin, [1, 0, 0, 1, 0, 0], pageRes, dialogLines, s, shift, stats);
        for (const w of stats.warnings) if (pageReport.warnings.indexOf(w) === -1) pageReport.warnings.push(w);

        if (!stats.scaledOps) {
          pageReport.warnings.push('classifier found dialogue but rewriter matched none — page left unchanged');
          pageReport.appliedScale = 1;
          continue;
        }
        // Text may have lived inside form XObjects (mutated in place already);
        // only rewrite the page content stream if the page level itself changed.
        if (res.changed && !res.bail && res.out != null) {
          const newStream = ctx.flateStream(bytesOfLatin(res.out));
          const ref = ctx.register(newStream);
          page.node.set(N('Contents'), ref);
        }
      }

      const outBytes = await pdfDoc.save({ useObjectStreams: false });
      return { bytes: outBytes, report };
    }

    return { process, extract };
  };
});
