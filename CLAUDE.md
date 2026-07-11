# CLAUDE.md — Sides Enlarger

Guidance for Claude Code working in this repo. Read this before changing anything.

## What this is
A single-file web tool that ingests a screenplay "sides" PDF and outputs a
**page-for-page identical** PDF with only the **dialogue** enlarged (~25%). It's
for a TV actor reading sides on set. It also extracts the character names
geometrically and lets the user assign each a translucent highlight color that
is painted behind that character's blocks (composing with the enlargement).
Enlargement has three modes: all dialogue (default), only selected characters'
dialogue (`opts.enlargeOnly`), or the whole page zoomed uniformly toward the
margins (`opts.mode: 'page'`). All PDF processing happens **in the browser**;
there is no backend.

## Non-negotiable constraints (do not regress these)
1. **Page-for-page parity.** Content must never reflow across pages. On set,
   "page 34" must stay page 34. In dialogue mode, enlargement rescales dialogue
   text runs in place around each line's own baseline — nothing moves
   vertically. In whole-page mode the ENTIRE page content is wrapped in one
   uniform scale-and-recenter transform (nothing inside is rewritten), so
   parity is structural there too. If enlargement wouldn't fit a page, **back
   off the scale for that page and report it**; never push content onto
   another page.
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

**Loop-test rule:** on the dev box, real production sides live in `samplesides/`
(gitignored, CONFIDENTIAL). After any change to `engine.js`, `check.py` or the
fixture, run `bash tools/test.sh samplesides/*.pdf`, not just the fixture, and
eyeball the renders. The fixture cannot reproduce every real layout (form
XObjects, permission locks, glyph-per-op text, drift).
Requires: Node 18+, Python 3 with `reportlab` and `pymupdf`
(`pip install reportlab pymupdf --break-system-packages`).

**After ANY change to `engine.js` or `ui_template.html`, run `npm run build`** or
`index.html` will be stale. Then run `npm test`.

## The verifier is the source of truth
`tools/check.py` re-implements the geometric classifier independently and asserts:
equal page counts; every non-dialogue span unchanged in position (≤0.7pt) and size;
dialogue baselines unmoved and enlarged to the page's applied scale; word gaps
inside dialogue scaled uniformly (the kerning regression lock); when highlights
were requested, each assigned character's blocks covered by exactly one rect of
their color with every word inside it and no foreign text under any rect; no text
off the page; and no text lost (page-level word-multiset preserved, robust to the
renderer re-segmenting enlarged lines). It also writes
`out/renders/**/compare_pNN.png` — **look at these**, don't just trust the PASS.

## How the engine works (engine.js)
- **Extract + calibrate** (pdf.js): per-document x-bands for cue / dialogue /
  parenthetical, from the page geometry (median cue x, etc.). Sides are
  photocopies — margins drift, so never hardcode absolute x positions. Use
  **medians**, never modes: per-page drift clusters samples per page, and a mode
  locks onto one page's drift instead of the document center.
- **Classify** each visual line: cue / dialogue / parenthetical / dual / other.
  Classification also collects cue-led **blocks** (cue + parentheticals +
  dialogue) used for character extraction and highlighting.
- **Rewrite content streams** (pdf-lib): for dialogue text-show ops only, inject
  a scaled text matrix anchored on the line's own baseline, with every run on a
  page mapped by the SAME horizontal affine: `x' = C + s*(x - C)` where
  `C = dialX + colW/2`. This uniform anchor is what keeps kerning correct:
  real sides are often drawn word-per-op or **glyph-per-op**, and scaling each
  op around its own origin grows glyphs while leaving their origins on the old
  pitch (letters crowd, word gaps shrink). Emits everything else byte-identical.
- **Character extraction**: a cue is a geometric fact (all-caps, in the cue
  band, dialogue-band text under it). Names are normalized ((CONT'D)/(V.O.)
  stripped, revision `*` stripped, `#`/`/`/function words kept) and aggregated
  with dialogue-line counts. The dialogue-follow test is the noise filter; do
  not weaken it to catch more names.
- **Modes**: `opts.enlargeOnly` (array of names) gates the in-place scaling per
  cue-led block: unselected characters' dialogue must stay byte-identical, and
  the verifier checks it like non-dialogue. `opts.mode: 'page'` skips the
  rewriter entirely and wraps the page content streams in `q s 0 0 s tx ty cm
  ... Q` (fit from the text bounding box, horizontally centered, top-anchored,
  10pt safety edge; watermark extents measured conservatively so nothing ever
  leaves the sheet). Whole-page zoom is honest but modest on real sides: the
  vertical box (headers to CONTINUED) is the binding constraint.
- **Highlighting**: one rounded rect per block of an assigned character,
  painted as a Multiply-blend fill in a content stream APPENDED after the page
  content (so white background fills inside forms can't hide it; glyphs stay
  crisp/selectable). Rect geometry uses the same uniform-anchor map at the
  page's applied scale. Palette is 8 fixed pastels (luminance >= ~0.87 so
  grayscale printing keeps contrast); no free color picker. Dual-dialogue
  blocks are never painted.
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
  If a line has such marks, enlargement is additionally capped so the grown text
  stays 4pt clear of them (`L.starX0`).
- **Glyph-per-op PDFs**: pdf.js returns one item per glyph; when joining item
  text, insert a space only across a real word-sized gap or cue names read as
  "R U M A" and every text heuristic breaks.
- **Scene numbers print in BOTH margins** of a slugline and look like a dual-cue
  row; spaceless letter+digit runs are filtered from dual-name candidates only
  (never from real cue-derived names).
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
