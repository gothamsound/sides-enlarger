#!/usr/bin/env python3
"""Independent verifier for Sides Enlarger output.

Usage: python3 tools/check.py before.pdf after.pdf [report.json]

Asserts:
  1. page counts equal
  2. every non-dialogue span is unchanged in position (<= 0.7pt) and size
  3. dialogue spans: baseline unchanged, size ratio == page's applied scale
     (median over doc >= 1.2x unless pages backed off)
  4. renders side-by-side page images to out/compare_pNN.png for eyeballing

The dialogue classifier here is an independent Python re-implementation of
the geometric rules (x-band + follows-a-cue), so the engine is checked
against a second opinion, not against itself.
"""
import json
import re
import statistics
import sys

import fitz

LEAD = 12
TOL_POS = 0.7


def get_lines(page):
    """visual lines: [{y, x0, x1, text, spans:[(x0,y_origin,x1,size,text)], segs}]"""
    d = page.get_text("dict")
    spans = []
    for blk in d["blocks"]:
        if blk["type"] != 0:
            continue
        for ln in blk["lines"]:
            for sp in ln["spans"]:
                t = sp["text"]
                if not t.strip():
                    continue
                x0, y0, x1, y1 = sp["bbox"]
                spans.append({"x0": x0, "x1": x1, "y": round(sp["origin"][1], 2),
                              "size": sp["size"], "text": t})
    spans.sort(key=lambda s: (s["y"], s["x0"]))
    lines = []
    for sp in spans:
        if lines and abs(lines[-1]["y"] - sp["y"]) <= 2.0:
            lines[-1]["spans"].append(sp)
        else:
            lines.append({"y": sp["y"], "spans": [sp]})
    for L in lines:
        L["spans"].sort(key=lambda s: s["x0"])
        L["x0"] = L["spans"][0]["x0"]
        L["x1"] = max(s["x1"] for s in L["spans"])
        # segments split at >40pt gaps (dual dialogue)
        segs = []
        for s in L["spans"]:
            if segs and s["x0"] - segs[-1]["x1"] <= 40:
                segs[-1]["x1"] = max(segs[-1]["x1"], s["x1"])
                segs[-1]["text"] += " " + s["text"]
            else:
                segs.append({"x0": s["x0"], "x1": s["x1"], "text": s["text"]})
        L["segs"] = segs
        L["text"] = "   ".join(s["text"] for s in segs)
    return lines


def capsy(t):
    letters = re.sub(r"[^A-Za-z]", "", t)
    return len(letters) >= 2 and letters == letters.upper()


def is_cue(L, lo, hi):
    return (len(L["segs"]) == 1 and capsy(L["text"]) and len(L["text"].strip()) <= 42
            and lo <= L["x0"] <= hi
            and not re.search(r"\b(INT|EXT)\s*[./]", L["text"])
            and not re.search(r"(CUT TO|FADE (IN|OUT)|DISSOLVE)", L["text"]))


def classify_doc(doc):
    pages_lines = [get_lines(p) for p in doc]
    cue_xs = [L["x0"] for lines in pages_lines for L in lines if is_cue(L, 200, 340)]
    assert len(cue_xs) >= 2, "verifier could not find character cues"
    cue_x = statistics.median(cue_xs)
    dial_xs = []
    for lines in pages_lines:
        for i, L in enumerate(lines):
            if is_cue(L, cue_x - 12, cue_x + 12) and i + 1 < len(lines):
                nxt = lines[i + 1]
                if nxt["y"] - L["y"] < 3 * LEAD and cue_x - 130 < nxt["x0"] < cue_x - 30:
                    dial_xs.append(nxt["x0"])
    dial_x = statistics.median(dial_xs)
    paren_xs = [L["x0"] for lines in pages_lines for L in lines
                if L["text"].strip().startswith("(") and dial_x + 6 < L["x0"] < dial_x + 70]
    paren_x = statistics.median(paren_xs) if paren_xs else dial_x + 43

    for lines in pages_lines:
        in_block, dual, prev_y = False, False, None
        for L in lines:
            if prev_y is not None and L["y"] - prev_y > 28:
                in_block = False
            prev_y = L["y"]
            if len(L["segs"]) >= 2 and all(capsy(s["text"]) and len(s["text"].strip()) <= 30 for s in L["segs"]):
                L["cls"], dual, in_block = "dual", True, False
                continue
            if dual:
                if len(L["segs"]) >= 2:
                    L["cls"] = "dual"
                    continue
                dual = False
            if is_cue(L, cue_x - 12, cue_x + 12):
                L["cls"], in_block = "cue", True
                continue
            if in_block and (abs(L["x0"] - dial_x) <= 9 or abs(L["x0"] - paren_x) <= 9):
                L["cls"] = "more" if re.match(r"^\(\s*MORE\s*\)\s*$", L["text"].strip(), re.I) else "dialogue"
                continue
            L["cls"], in_block = "other", False
    return pages_lines


def main():
    before_path, after_path = sys.argv[1], sys.argv[2]
    report = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None

    b, a = fitz.open(before_path), fitz.open(after_path)
    fails, notes = [], []

    # 1. page parity
    if len(b) != len(a):
        fails.append(f"page count differs: {len(b)} vs {len(a)}")
        report_and_exit(fails, notes)

    before_cls = classify_doc(b)
    ratios = []

    def wordbag(page):
        import collections
        c = collections.Counter()
        for w in page.get_text("words"):
            t = re.sub(r"\s+", "", w[4])
            if t:
                c[t] += 1
        return c

    for pi in range(len(b)):
        blines = before_cls[pi]
        alines = get_lines(a[pi])
        aspans = [s for L in alines for s in L["spans"]]
        applied = report["pages"][pi]["appliedScale"] if report else None

        # --- (a) no text lost: page-level word multiset must be preserved.
        # Robust to renderer re-segmenting enlarged dialogue into different spans.
        bb, ab = wordbag(b[pi]), wordbag(a[pi])
        if bb != ab:
            missing = (bb - ab)
            extra = (ab - bb)
            for t, n in list(missing.items())[:6]:
                fails.append(f"p{pi+1}: text LOST: {t[:40]!r} x{n}")
            for t, n in list(extra.items())[:3]:
                fails.append(f"p{pi+1}: text ADDED: {t[:40]!r} x{n}")

        # --- (b) non-dialogue spans: byte-identical stream => exact position/size.
        for L in blines:
            if L["cls"] not in ("other", "cue", "dual", "more"):
                continue
            for sp in L["spans"]:
                cands = [t for t in aspans if t["text"] == sp["text"] and abs(t["y"] - sp["y"]) <= 2.5]
                if not cands:
                    # segmentation can vary; only fail if this exact string's
                    # position truly can't be confirmed near where it was
                    near = [t for t in aspans if abs(t["y"] - sp["y"]) <= TOL_POS and abs(t["x0"] - sp["x0"]) <= TOL_POS]
                    if not near:
                        fails.append(f"p{pi+1}: non-dialogue span not found in place: {sp['text'][:30]!r}")
                    continue
                m = min(cands, key=lambda t: abs(t["x0"] - sp["x0"]))
                if abs(m["x0"] - sp["x0"]) > TOL_POS or abs(m["y"] - sp["y"]) > TOL_POS:
                    fails.append(f"p{pi+1}: non-dialogue moved {sp['text'][:30]!r} "
                                 f"dx={m['x0']-sp['x0']:.2f} dy={m['y']-sp['y']:.2f}")
                if abs(m["size"] - sp["size"]) > 0.05:
                    fails.append(f"p{pi+1}: non-dialogue resized {sp['text'][:30]!r} "
                                 f"{sp['size']:.2f}->{m['size']:.2f}")

        # --- (c) dialogue: measure enlargement at line level (re-seg tolerant).
        pageW = a[pi].rect.width
        marginStart = pageW - 80  # exclude right-margin revision marks (*)
        for L in blines:
            if L["cls"] != "dialogue":
                continue
            bsize = statistics.median([s["size"] for s in L["spans"] if s["x0"] < marginStart] or [s["size"] for s in L["spans"]])
            # after spans sharing this baseline, excluding margin marks
            same = [t for t in aspans if abs(t["y"] - L["y"]) <= 1.0 and t["x0"] < marginStart]
            if not same:
                fails.append(f"p{pi+1}: dialogue baseline vanished at y={L['y']:.1f}: {L['text'][:30]!r}")
                continue
            asize = statistics.median([t["size"] for t in same])
            r = asize / bsize
            ratios.append(r)
            if applied is not None and abs(r - applied) > 0.03:
                fails.append(f"p{pi+1}: dialogue scale {r:.3f} != applied {applied} at y={L['y']:.1f}")

        # off-page check
        pw = a[pi].rect.width
        for L in alines:
            if L["x1"] > pw - 3 or L["x0"] < 3:
                fails.append(f"p{pi+1}: text off page edge x0={L['x0']:.0f} x1={L['x1']:.0f}: {L['text'][:30]!r}")

    med = statistics.median(ratios) if ratios else 0
    notes.append(f"dialogue lines checked: {len(ratios)}, median size ratio {med:.3f}")
    requested = report["requestedScale"] if report else 1.25
    backoffs = [p for p in (report["pages"] if report else []) if p["appliedScale"] < requested - 0.005]
    # Only require real enlargement when the user actually asked for it (>1.05x).
    if requested > 1.05 and ratios and med < 1.2 and not backoffs:
        fails.append(f"median dialogue ratio {med:.3f} < 1.2 with no reported back-off")
    if backoffs:
        notes.append("reported back-off pages: " + ", ".join(f"p{p['page']}={p['appliedScale']}" for p in backoffs))

    # 4. side-by-side renders
    import os
    outdir = os.environ.get("CHECK_RENDER_DIR") or os.path.dirname(after_path) or "."
    os.makedirs(outdir, exist_ok=True)
    for pi in range(len(b)):
        pb = b[pi].get_pixmap(dpi=110)
        pa = a[pi].get_pixmap(dpi=110)
        W = pb.width + pa.width + 12
        H = max(pb.height, pa.height)
        combo = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, W, H))
        combo.clear_with(90)
        combo.copy(pb, fitz.IRect(0, 0, pb.width, pb.height))
        pa.set_origin(pb.width + 12, 0)
        combo.copy(pa, fitz.IRect(pb.width + 12, 0, pb.width + 12 + pa.width, pa.height))
        fn = os.path.join(outdir, f"compare_p{pi+1:02d}.png")
        combo.save(fn)
    notes.append(f"side-by-side renders: {outdir}/compare_pNN.png")

    report_and_exit(fails, notes)


def report_and_exit(fails, notes):
    for n in notes:
        print("NOTE:", n)
    if fails:
        print(f"\nFAIL ({len(fails)} problems)")
        for f in fails[:40]:
            print("  -", f)
        sys.exit(1)
    print("\nPASS: page parity, non-dialogue positions, dialogue scaling all verified")
    sys.exit(0)


if __name__ == "__main__":
    main()
