# Sides Enlarger

Makes the **dialogue** in a day's shooting sides bigger (default 1.25×) so it's
readable on set — while keeping the page **exactly** as it was. Same page count,
same page breaks, same scene numbers, same everything-else. When someone says
"page 34," it's still page 34.

The whole thing is **one HTML file**. The PDF is processed **inside the browser**
— nothing is ever uploaded, no server, no accounts, no tracking. That's the point:
production scripts never leave the device.

---

## For the actor — how to use it

1. Open `index.html` (double-click it, or open it in Safari/Chrome on a
   phone, tablet, or computer).
2. Drag your sides PDF onto the page (or tap to choose the file).
3. It shows the original and the enlarged version side by side. Flip through the
   pages to check.
4. Tap **Download enlarged PDF**. Print it or read it on your device.

There's a **size slider** (1.0× – 1.5×) if you want it bigger or smaller. It
remembers your setting on that device. You don't have to touch anything else.

If a warning appears under a page, it's just letting you know that page was left
alone (see "What it leaves alone" below) — the page is still correct.

### Works on a phone?
Yes — iOS (Safari) and Android (Chrome) both work. It renders the preview as
images rather than relying on the phone's built-in PDF viewer, so the before/after
comparison shows up the same everywhere. To save the file on iPhone, tap Download
and choose "Save to Files"; on Android it goes to Downloads.

---

## Giving it to other people

Because it's a single self-contained file, you can share it three ways:

- **Send the file.** Email/AirDrop `index.html`. They open it. Done.
- **Host it free on GitHub Pages.** Put `index.html` in a repo (rename it
  `index.html` if you want a clean URL), enable Pages, and share the link. GitHub
  only ever serves the static file — since the PDF is processed in the visitor's
  browser, **no script ever touches GitHub's servers.**
- **Custom domain later.** Point `scriptenlarger.com` at the same GitHub Pages
  file with a CNAME. No code changes.

### "Security by obscurity" — per-person links
The tool identifies a person by the part of the URL after `#`:

```
scriptenlarger.com/#laura          → remembers Laura's size setting
scriptenlarger.com/#laura-x7k2q9   → same, but an unguessable link
```

The name after `#` is *only* a key for saved preferences (it never stores any
script). Because unguessable names cost nothing, use one if you want the link to
be hard to find. The page also sends `noindex` so search engines skip it. This
isn't real authentication — it's deliberate light-touch obscurity, which is all
that's needed for now. If it gets popular we can add real access control later.

---

## What it changes vs. leaves alone

**Enlarges:** spoken dialogue, and the parentheticals inside a dialogue block.

**Leaves exactly in place:** scene headings (sluglines), action, character cue
names, page headers, page numbers, scene numbers, revision stars (the `*` marks in
the margin), watermarks, and anything else.

It figures out what's dialogue **by where it sits on the page** (the indented
dialogue column, directly under a character cue), calibrated per document — not by
reading the words. That's what keeps it safe on photocopied sides where the margins
drift.

**Per-page back-off.** If enlarging a page's dialogue would push text off the page,
it automatically uses a smaller size *for that page only* (never reflowing text onto
another page) and tells you. Pages with no dialogue (title pages, revision tables,
pure action) are passed through untouched.

**Dual dialogue** (two side-by-side speakers) is left at original size with a
per-page note, rather than risk mangling it.

**Encrypted / permission-locked sides** (very common from productions) are handled
automatically — the output is a normal, unlocked, printable PDF. Treat it with the
same care as the original.

**Scanned sides** (an image with no real text) can't be enlarged this way; v1 shows
a clear "this looks like a scan" message instead of producing garbage.

---

## For a developer

### Files
```
index.html             ← the deliverable: build output, fully self-contained (also what Pages serves)
ui_template.html       ← the page + app glue (before bundling)
engine.js              ← core logic (runs identically in browser and Node)
build.mjs              ← inlines pdf.js, pdf.js worker (base64), pdf-lib, engine -> index.html
tools/make_fixture.py  ← generates a synthetic screenplay PDF for testing
tools/run_engine_node.mjs ← run the engine headless on a PDF
tools/check.py         ← independent verifier + before/after page renders
tools/test.sh          ← one-shot: fixture (and optional real PDFs) at 1.0/1.25/1.5
CLAUDE.md              ← notes for a Claude Code CLI session on this repo
```

### Build
```bash
npm install                 # pdf-lib, pdfjs-dist (build-time only; both get inlined)
npm run build               # writes index.html
```
The output HTML has **no external dependencies** and makes **no network requests**.

### How the engine works
1. **Extract & calibrate** (pdf.js): read every text run's position; find the
   character-cue column as the median cue x; derive the dialogue and parenthetical
   x-bands from the page geometry itself.
2. **Classify** each visual line geometrically: cue / dialogue / parenthetical /
   dual / other — dialogue must sit in the dialogue band *and* follow a cue.
3. **Rewrite the PDF content streams** (pdf-lib): for dialogue text-show operators
   only, inject a scaled text matrix anchored on that line's own baseline, shifted
   left by half the growth so the column stays put. Text lives inside **form
   XObjects** in real production PDFs, so the rewriter recurses through `Do`.
   Nothing moves vertically, so nothing can reflow — page parity is structural.
4. **Per-page fit / back-off** and **scan / dual-dialogue / encryption** handling as
   described above. Permission-locked PDFs are decrypted in-engine (RC4 & AES-128,
   empty user password — the standard "you can read but not edit" lock).

### Verify (do this, don't hope)
```bash
npm test                              # fixture at 1.0 / 1.25 / 1.5, all checks
bash tools/test.sh /path/to/real.pdf  # also run against your real sides locally
```
The checker asserts: equal page counts; every non-dialogue span unchanged in
position and size (0.7pt tolerance); dialogue enlarged to the applied scale with
unmoved baselines; nothing pushed off the page. It also writes `compare_pNN.png`
side-by-side page images for eyeball review. Point it at your real sides locally —
the synthetic fixture means the test suite never needs a confidential script.

Verified against a synthetic fixture **and** four real production sides
(text-based, incl. permission-locked and form-XObject layouts): full 1.25×
enlargement with page-for-page parity on every dialogue page.
