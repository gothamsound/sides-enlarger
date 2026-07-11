# CLAUDE.md — Sides Enlarger

Guidance for Claude Code working in this repo. Read this before changing anything.

## What this is
A single-file web tool that ingests a screenplay "sides" PDF and outputs a
**page-for-page identical** PDF with only the **dialogue** enlarged (~25%). It's
for a TV actor reading sides on set. All PDF processing happens **in the browser**;
there is no backend.

## Non-negotiable constraints (do not regress these)
1. **Page-for-page parity.** Content must never reflow across pages. On set,
   "page 34" must stay page 34. Enlargement is done by rescaling dialogue text
   runs in place around each line's own baseline — nothing moves vertically. If a
   page's enlarged dialogue wouldn't fit, **back off the scale for that page and
   report it**; never push content onto another page.
2. **Confidentiality / offline.** Scripts must never leave the device. No network
   calls, no CDNs, no telemetry, no cloud. Everything (pdf.js, its worker, pdf-lib,
   the engine) is inlined into `index.html`. Keep it that way.
3. **Only dialogue changes.** Sluglines, action, character cues, page headers,
   page/scene numbers, revision `*` marks, watermarks — all stay byte-for-byte in
   place. Dialogue is detected **geometrically** (indented column + follows a
   character cue, calibrated per document), never by reading the words.
4. **Output is a normal printable PDF** at the original page size.

## Repo layout
```
index.html              BUILD OUTPUT — do not hand-edit. Regenerate with `npm run build`.
ui_template.html        The page markup + app glue (edit this, then rebuild).
engine.js               Core logic. Runs UNCHANGED in both browser and Node.
build.mjs               Inlines pdf.js + worker (base64) + pdf-lib + engine.js -> index.html
tools/make_fixture.py   Generates a synthetic screenplay PDF (reportlab) for tests.
tools/run_engine_node.mjs  Runs engine.js headless on a PDF (uses node_modules build).
tools/check.py          Independent verifier (pymupdf) + side-by-side page renders.
tools/test.sh           One-shot: fixture (and optional real PDFs) at 1.0/1.25/1.5.
.nojekyll               So GitHub Pages serves index.html as-is.
```

## Build & test
```bash
npm install            # dev-only deps (pdf-lib, pdfjs-dist); both get inlined
npm run build          # ui_template.html + engine.js + libs -> index.html
npm test               # bash tools/test.sh  (fixture only; always safe to commit)

# test against REAL sides you have locally (never commit them):
bash tools/test.sh /path/to/real_sides.pdf
```
Requires: Node 18+, Python 3 with `reportlab` and `pymupdf`
(`pip install reportlab pymupdf --break-system-packages`).

**After ANY change to `engine.js` or `ui_template.html`, run `npm run build`** or
`index.html` will be stale. Then run `npm test`.

## The verifier is the source of truth
`tools/check.py` re-implements the geometric classifier independently and asserts:
equal page counts; every non-dialogue span unchanged in position (≤0.7pt) and size;
dialogue baselines unmoved and enlarged to the page's applied scale; no text off the
page; and no text lost (page-level word-multiset preserved, robust to the renderer
re-segmenting enlarged lines). It also writes `out/renders/**/compare_pNN.png` —
**look at these**, don't just trust the PASS.

## How the engine works (engine.js)
- **Extract + calibrate** (pdf.js): per-document x-bands for cue / dialogue /
  parenthetical, from the page geometry (median cue x, etc.). Sides are
  photocopies — margins drift, so never hardcode absolute x positions.
- **Classify** each visual line: cue / dialogue / parenthetical / dual / other.
- **Rewrite content streams** (pdf-lib): for dialogue text-show ops only, inject a
  scaled text matrix (`sPage * tlm`) anchored on the baseline, shifted left by half
  the growth so the column stays put. Emits everything else byte-identical.
- **Recurses through form XObjects.** Real production sides put the page text inside
  `/Form` XObjects invoked via `Do`; the rewriter descends into them (accumulating
  CTM) and mutates the form stream. Shared forms are guarded by a visited-set.
- **Decrypts in-engine.** Production PDFs are usually permission-locked (RC4-128 or
  AES-128, empty user password). `decryptInPlace` handles Standard security handler
  R2–R4 and drops `/Encrypt`; output is unlocked. AES needs `crypto.subtle` (https
  or file://), RC4 is pure JS. R5+/AES-256 is refused with a clear message.

## Known gotchas (already handled — don't reintroduce)
- **Revision `*` marks** sit in the far-right margin. A line's fit-width and
  scale-match band use the **dialogue segment only** (spans left of `pageW-80`), or
  they'd wrongly force back-off and could scale the `*`. Mirror this in check.py.
- **Text inside forms**: page content stream often has zero `Tj` — don't conclude
  "no dialogue," descend into `Do`.
- **`'` and `"` show-operators** are decomposed so a scaled `Tm` can be injected.
- **Inline images (`BI`)**: a stream containing them is left unscaled (guarded).
- **Dual dialogue** and **revision-history / call-sheet tables** are left untouched
  (may trip the dual-dialogue heuristic; that's fine — the page must stay identical).

## Rules for changes
- Never commit real scripts or their renders. `.gitignore` blocks `sides/`,
  `out/`, `*.real.pdf`, `samples-private/`. The only test fixture in-repo is the
  synthetic one from `make_fixture.py`.
- `engine.js` must stay dependency-injected (`{ pdfjsLib, PDFLib }`) and free of
  Node-only or browser-only globals except where feature-detected (e.g.
  `crypto.subtle`). It ships to the browser verbatim.
- Don't add runtime network access or external assets.
- If you touch classification or scaling, add/extend a case in `make_fixture.py`
  and confirm `npm test` stays green **and** eyeball the renders.

## Deploy (GitHub Pages)
Commit everything, push. In repo Settings → Pages, serve from the default branch
root. `index.html` + `.nojekyll` are all Pages needs. Per-user prefs key off the
URL hash (`/#laura`); nothing but a preferences label is stored, and only in the
visitor's localStorage.
