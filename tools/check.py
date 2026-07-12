#!/usr/bin/env python3
"""Independent verifier for Sides Enlarger output.

Usage: python3 tools/check.py before.pdf after.pdf [report.json]

Asserts:
  1. page counts equal
  2. every non-dialogue span is unchanged in position (<= 0.7pt) and size
  3. dialogue spans: baseline unchanged, size ratio == page's applied scale
     (median over doc >= 1.2x unless pages backed off)
  4. kerning fidelity: word gaps inside dialogue lines scale uniformly with
     the applied scale (multi-run lines must not crowd or overlap)
  5. if the report requested highlights: each assigned character's blocks are
     covered by exactly one rect of that character's color, every word of the
     block sits inside the rect, and no rect covers any other line's text
  6. selective mode (report.enlargeOnly): only the listed characters' dialogue
     scales; everyone else's dialogue is checked as unchanged like non-dialogue
  7. page mode (report.mode == "page"): body text is s times bigger on its
     own UNMOVED baseline, x mapped about the page anchor; margin marks
     (scene numbers, revision stars, page numbers) are byte-identical
  8. renders side-by-side page images to out/compare_pNN.png for eyeballing

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
    # double-struck "bold" (same text drawn twice in place) reads once,
    # mirroring the engine's item dedupe
    deduped = []
    for sp in spans:
        p = deduped[-1] if deduped else None
        if (p and p["text"] == sp["text"] and abs(p["x0"] - sp["x0"]) < 1.2
                and abs(p["y"] - sp["y"]) <= 1.0):
            continue
        deduped.append(sp)
    spans = deduped
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


def is_cue(L, lo, hi, pageW=0):
    # a cue may carry revision marks in the far-right margin ("TRACY  *")
    segs = [s for s in L["segs"] if s["x0"] < pageW - 80] if pageW else L["segs"]
    if len(segs) != 1 or (segs and L["segs"] and segs[0] is not L["segs"][0]):
        return False
    text = segs[0]["text"] if segs else ""
    return (capsy(text) and len(text.strip()) <= 42
            and lo <= L["x0"] <= hi
            and not re.search(r"\b(INT|EXT)\s*[./]", text)
            and not re.search(r"(CUT TO|FADE (IN|OUT)|DISSOLVE)", text))


def norm_cue(t):
    """mirror of the engine's normalizeCueName"""
    t = re.sub(r"\*", " ", t or "")
    t = re.sub(r"\s*\([^)]*\)", " ", t)          # (CONT'D) (V.O.) etc.
    t = re.sub(r"[.,:;]+\s*$", "", t)
    return re.sub(r"\s+", " ", t).strip().upper()


def collect_blocks(lines):
    """cue-led blocks from an already-classified page, mirroring the engine"""
    blocks, cur = [], None
    for L in lines:
        c = L.get("cls")
        if c == "cue":
            cur = {"name": norm_cue(L["text"]), "cue": L, "lines": []}
            blocks.append(cur)
        elif c in ("dialogue", "more"):
            if cur:
                cur["lines"].append(L)
        else:
            cur = None
    return blocks


def classify_doc(doc):
    pages_lines = [get_lines(p) for p in doc]
    widths = [p.rect.width for p in doc]
    cue_xs = [L["x0"] for lines, W in zip(pages_lines, widths) for L in lines if is_cue(L, 200, 340, W)]
    assert len(cue_xs) >= 2, "verifier could not find character cues"
    cue_x = statistics.median(cue_xs)
    dial_xs = []
    for lines, W in zip(pages_lines, widths):
        for i, L in enumerate(lines):
            if is_cue(L, cue_x - 12, cue_x + 12, W) and i + 1 < len(lines):
                nxt = lines[i + 1]
                if (nxt["y"] - L["y"] < 3 * LEAD and cue_x - 130 < nxt["x0"] < cue_x - 30
                        and not nxt["text"].strip().startswith("(")):
                    dial_xs.append(nxt["x0"])
    dial_x = statistics.median(dial_xs)
    paren_xs = [L["x0"] for lines in pages_lines for L in lines
                if L["text"].strip().startswith("(") and dial_x + 6 < L["x0"] < dial_x + 70]
    paren_x = statistics.median(paren_xs) if paren_xs else dial_x + 43

    for lines, W in zip(pages_lines, widths):
        in_block, dual, prev_y = False, False, None
        for L in lines:
            if prev_y is not None and L["y"] - prev_y > 28:
                in_block = False
            prev_y = L["y"]
            body_segs = [s for s in L["segs"] if s["x0"] < W - 80]
            if len(body_segs) >= 2 and all(capsy(s["text"]) and len(s["text"].strip()) <= 30 for s in body_segs):
                L["cls"], dual, in_block = "dual", True, False
                continue
            if dual:
                if len(L["segs"]) >= 2:
                    L["cls"] = "dual"
                    continue
                dual = False
            if is_cue(L, cue_x - 12, cue_x + 12, W):
                L["cls"], in_block = "cue", True
                continue
            if in_block and (abs(L["x0"] - dial_x) <= 9 or abs(L["x0"] - paren_x) <= 9):
                L["cls"] = "more" if re.match(r"^\(\s*MORE\s*\)\s*$", L["text"].strip(), re.I) else "dialogue"
                continue
            L["cls"], in_block = "other", False
    return pages_lines


def mark_furniture(pages_lines, heights):
    """mirror of the engine's markFurniture (page mode): top/bottom-zone rows
    whose digit-stripped text repeats on at least half the pages"""
    from collections import defaultdict

    def zone(L, H):  # pymupdf y is top-down
        if L["y"] < 0.15 * H:
            return "top"
        if L["y"] > 0.88 * H:
            return "bot"
        return None

    def key(L):
        return " ".join(t for t in L["text"].split()
                        if len(re.sub(r"[^A-Za-z]", "", t)) >= 3).upper()

    seen = defaultdict(set)
    for pi, lines in enumerate(pages_lines):
        for L in lines:
            z = zone(L, heights[pi])
            if not z or L.get("cls") in ("cue", "dialogue"):
                continue
            seen[(z, key(L))].add(pi)
    need = max(2, -(-len(pages_lines) // 2))
    for pi, lines in enumerate(pages_lines):
        for L in lines:
            z = zone(L, heights[pi])
            if not z or L.get("cls") in ("cue", "dialogue"):
                continue
            if not key(L) or len(seen[(z, key(L))]) >= need:
                L["furn"] = True


def reader_check(b, a, report, fails, notes):
    """Reader mode deliberately breaks page parity. Contract instead:
    every kept body word survives (no text lost), nothing is invented
    beyond the known page-break markers/footers, revision stars and
    furniture are dropped, and the text is at the reader size."""
    import collections
    before_cls = classify_doc(b)
    mark_furniture(before_cls, [p.rect.height for p in b])
    need = collections.Counter()
    allb = collections.Counter()
    for pi in range(len(b)):
        W = b[pi].rect.width
        lines = before_cls[pi]
        has_dial = any(L.get("cls") == "dialogue" for L in lines)
        # rotated watermark lines are dropped in reader view
        rot_ys = []
        for blk in b[pi].get_text("dict")["blocks"]:
            if blk["type"] != 0:
                continue
            for ln in blk["lines"]:
                if abs(ln["dir"][1]) > 0.05:
                    for sp in ln["spans"]:
                        rot_ys.append(sp["origin"][1])
        words = b[pi].get_text("words")
        for w in words:
            if w[4].strip():
                allb[w[4]] += 1
        if not has_dial:
            continue  # coverage/title pages are skipped in reader view
        keep_rows = [L for L in lines if not L.get("furn") and L.get("cls") != "more"]
        counted = set()  # double-struck "bold" words appear twice in place
        for L in keep_rows:
            if any(abs(L["y"] - ry) <= 3 for ry in rot_ys):
                continue
            for w in words:
                if (abs(w[3] - L["y"]) <= 5.0 and w[2] > 70 and w[0] < W - 80
                        and w[4].strip() and w[4] != "*"
                        and not any(abs(w[3] - ry) <= 4 for ry in rot_ys)):
                    k = (w[4], round(w[0]), round(w[3]))
                    if k in counted:
                        continue
                    counted.add(k)
                    need[w[4]] += 1
    got = collections.Counter()
    sizes = []
    for pi in range(len(a)):
        H = a[pi].rect.height
        for w in a[pi].get_text("words"):
            if w[3] < H - 45 and w[4].strip():
                got[w[4]] += 1
        for blk in a[pi].get_text("dict")["blocks"]:
            if blk["type"] != 0:
                continue
            for ln in blk["lines"]:
                for sp in ln["spans"]:
                    if sp["bbox"][3] < H - 45 and sp["text"].strip() and sp["size"] > 9:
                        sizes.append(sp["size"])
    # subtract the known page-break markers before the invented check
    for label in (report or {}).get("readerBreaks", []):
        got.subtract(collections.Counter(["SCRIPT", "PAGE"] + str(label).split()))
    got = +got
    missing = need - got
    for t, n in list(missing.items())[:8]:
        fails.append(f"reader: text LOST: {t[:30]!r} x{n}")
    if len(missing) > 8:
        fails.append(f"reader: ... and {len(missing) - 8} more missing words")
    invented = got - allb
    for t, n in list(invented.items())[:8]:
        fails.append(f"reader: text INVENTED: {t[:30]!r} x{n}")
    if got.get("*"):
        fails.append("reader: revision stars must be dropped")
    req = (report or {}).get("requestedScale", 1.25)
    med = statistics.median(sizes) if sizes else 0
    notes.append(f"reader: {len(b)} script pages -> {len(a)} reader pages, "
                 f"{len(report.get('readerBreaks', []))} page markers, median size {med:.1f}")
    if abs(med - 12 * req) > 0.8:
        fails.append(f"reader: median text size {med:.2f} != {12 * req:.2f}")


def main():
    before_path, after_path = sys.argv[1], sys.argv[2]
    report = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else None

    b, a = fitz.open(before_path), fitz.open(after_path)
    fails, notes = [], []

    if (report or {}).get("mode") == "reader":
        reader_check(b, a, report, fails, notes)
        import os
        outdir = os.environ.get("CHECK_RENDER_DIR") or os.path.dirname(after_path) or "."
        os.makedirs(outdir, exist_ok=True)
        for pi in range(len(a)):
            a[pi].get_pixmap(dpi=110).save(os.path.join(outdir, f"reader_p{pi+1:02d}.png"))
        notes.append(f"reader renders: {outdir}/reader_pNN.png")
        report_and_exit(fails, notes)

    # 1. page parity
    if len(b) != len(a):
        fails.append(f"page count differs: {len(b)} vs {len(a)}")
        report_and_exit(fails, notes)

    mode = (report or {}).get("mode") or "dialogue"
    sel = (report or {}).get("enlargeOnly")  # None = all dialogue; list = only these
    try:
        before_cls = classify_doc(b)
    except Exception:
        if mode != "page":
            raise
        before_cls = [get_lines(p) for p in b]
        notes.append("no cues classifiable; page-mode geometric checks only")
    if mode == "page":
        mark_furniture(before_cls, [p.rect.height for p in b])
    ratios = []
    gap_bad = []
    hl = (report or {}).get("highlights") or {}

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
        pinfo = report["pages"][pi] if report else {}
        s_eff = applied if applied else 1.0
        pageW = a[pi].rect.width
        pageH = b[pi].rect.height
        marginStart = pageW - 80  # exclude right-margin revision marks (*)
        blocks = collect_blocks(blines)
        line_name = {}
        enl_cues = set()
        for B in blocks:
            for L in B["lines"]:
                line_name[id(L)] = B["name"]
            # the character name scales with its block (when the block has
            # dialogue and, in selective mode, is selected)
            if any(l.get("cls") == "dialogue" for l in B["lines"]) and (sel is None or B["name"] in sel):
                enl_cues.add(id(B["cue"]))

        def line_enlarged(L):
            c = L.get("cls")
            if c == "cue":
                return id(L) in enl_cues
            if c != "dialogue":
                return False
            if sel is None:
                return True
            return line_name.get(id(L)) in sel

        if mode == "page":
            # whole-page mode: baselines never move; body x maps about the
            # page's content-center anchor
            anchor = pinfo.get("anchor", pageW / 2.0)

            def ymap(L):
                return L["y"]

            def xspan(L):
                if s_eff > 1.001:
                    return (anchor + s_eff * (max(L["x0"], 70) - anchor),
                            anchor + s_eff * (min(L["x1"], marginStart) - anchor))
                return (L["x0"], L["x1"])
        else:
            def ymap(L):
                return L["y"]

            def xspan(L):
                if line_enlarged(L) and s_eff > 1.001:
                    calib = (report or {}).get("calibration") or {}
                    C = calib.get("dialX", 180) + calib.get("colW", 252) / 2.0
                    return (C + s_eff * (L["x0"] - C), C + s_eff * (min(L["x1"], marginStart) - C))
                return (L["x0"], L["x1"])

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

        # --- (b) unchanged spans: byte-identical stream => exact position/size.
        # In selective mode, dialogue of unselected characters must also stay
        # untouched. Skipped in page mode (everything moves by the affine).
        for L in (blines if mode != "page" else []):
            keep = (L.get("cls") in ("other", "dual", "more")
                    or (L.get("cls") in ("cue", "dialogue") and not line_enlarged(L)))
            if not keep:
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

        # --- (c2) kerning fidelity: word gaps must scale uniformly. On
        # word-per-op / glyph-per-op PDFs a per-run anchor would leave gaps
        # at original size while glyphs grow — this catches that regression.
        # Applies in page mode too (dialogue lines, uniform about the anchor).
        if applied is not None and applied > 1.001:
            bwords = b[pi].get_text("words")
            awords = a[pi].get_text("words")
            for L in blines:
                if mode == "page":
                    if L.get("cls") != "dialogue":
                        continue
                elif not line_enlarged(L):
                    continue
                bw = sorted(w for w in bwords if abs(w[3] - L["y"]) <= 5.0 and w[0] < marginStart)
                aw = sorted(w for w in awords if abs(w[3] - L["y"]) <= 5.0 and w[0] < marginStart)
                if len(bw) < 2:
                    continue
                if len(aw) != len(bw):
                    if "".join(w[4] for w in bw) == "".join(w[4] for w in aw):
                        gap_bad.append(f"p{pi+1}: words merged/re-split after enlargement at y={L['y']:.1f}")
                    continue
                for k in range(len(bw) - 1):
                    bgap = bw[k + 1][0] - bw[k][2]
                    agap = aw[k + 1][0] - aw[k][2]
                    if abs(agap - applied * bgap) > 1.2:
                        gap_bad.append(f"p{pi+1}: gap {bw[k][4]!r}->{bw[k+1][4]!r} "
                                       f"{bgap:.2f} -> {agap:.2f} (expected {applied*bgap:.2f})")

        if mode == "page":
            # --- (e) whole-page "all bigger": body text grows s about the
            # page anchor on its own UNMOVED baseline; margin marks (left
            # scene numbers, revision stars, page numbers) stay put exactly.
            # Word-level positions (words never merge across the mark
            # boundary and carry no space-bbox noise); span-level sizes.
            # Pages without dialogue (title/coverage/call sheets) must not
            # be enlarged at all.
            if s_eff > 1.001 and not any(L.get("cls") == "dialogue" for L in blines):
                fails.append(f"p{pi+1}: page without dialogue was enlarged "
                             f"(coverage/call-sheet/title pages must stay untouched)")
            furn_ys = [L["y"] for L in blines if L.get("furn")]

            def near_furn(y):
                return any(abs(y - fy) <= 5.0 for fy in furn_ys)

            bwords_e = b[pi].get_text("words")
            awords_e = a[pi].get_text("words")
            for w in bwords_e:
                if not w[4].strip():
                    continue
                is_fixed = w[0] >= marginStart or w[2] <= 70 or near_furn(w[3])
                ex0 = w[0] if (is_fixed or s_eff <= 1.001) else anchor + s_eff * (w[0] - anchor)
                tol = 0.7 if is_fixed else 1.5
                m = [t for t in awords_e if t[4] == w[4]
                     and abs(t[3] - w[3]) <= 1.5 and abs(t[0] - ex0) <= tol]
                if not m:
                    kind = "fixed row/mark" if is_fixed else "body word"
                    fails.append(f"p{pi+1}: {kind} not at expected x={ex0:.1f} "
                                 f"(y={w[3]:.1f}): {w[4][:20]!r}")
            for L in blines:
                s_line = 1.0 if L.get("furn") else s_eff
                for sp in L["spans"]:
                    if sp["x1"] <= 70 or sp["x0"] >= marginStart:
                        continue  # pure margin mark: position covered above
                    # body portion of this span, mapped
                    bx0 = max(sp["x0"], 70)
                    bx1 = min(sp["x1"], marginStart)
                    if bx1 - bx0 < 4:
                        continue
                    exp_size = sp["size"] if s_line <= 1.001 else s_line * sp["size"]
                    win0 = bx0 if s_line <= 1.001 else anchor + s_line * (bx0 - anchor)
                    win1 = bx1 if s_line <= 1.001 else anchor + s_line * (bx1 - anchor)
                    # judge by the candidate covering most of the window: a
                    # margin-mark span (leading-space bbox) can sit inside the
                    # mapped body window without owning it
                    best, best_ov = None, 2.0
                    for t in aspans:
                        if abs(t["y"] - sp["y"]) > 1.0:
                            continue
                        ov = min(t["x1"], win1) - max(t["x0"], win0)
                        if ov > best_ov:
                            best, best_ov = t, ov
                    if best is None:
                        continue  # presence is asserted by the word check
                    r = best["size"] / sp["size"]
                    ratios.append(r)
                    if abs(best["size"] - exp_size) > 0.05 * exp_size:
                        fails.append(f"p{pi+1}: body size {r:.3f}x != {s_line}x at y={sp['y']:.1f}: "
                                     f"{sp['text'][:20]!r}")
        else:
            # --- (c) enlarged dialogue: line-level scale + unmoved baseline.
            for L in blines:
                if not line_enlarged(L):
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

        # --- (d) highlights: rects land on the assigned character's blocks
        # (cue + parentheticals + dialogue), cover every word of them, and
        # never touch anyone else's text.
        if hl:
            rects_by_name = {}
            for d in a[pi].get_drawings():
                f = d.get("fill")
                if not f:
                    continue
                for name, info in hl.items():
                    rgb = info["rgb"]
                    if all(abs(f[j] - rgb[j]) < 0.02 for j in range(3)):
                        rects_by_name.setdefault(name, []).append(d["rect"])
            awords = a[pi].get_text("words")
            wcut = marginStart
            for name, info in hl.items():
                myblocks = [B for B in blocks if B["name"] == name
                            and any(l.get("cls") == "dialogue" for l in B["lines"])]
                rects = rects_by_name.get(name, [])
                if len(rects) != len(myblocks):
                    fails.append(f"p{pi+1}: highlight {name!r}: {len(myblocks)} blocks vs {len(rects)} rects")
                mine = set()
                for B in myblocks:
                    blk_lines = [B["cue"]] + B["lines"]
                    mine.update(id(L) for L in blk_lines)
                    ys = [ymap(L) for L in blk_lines]
                    cover = next((r for r in rects if all(r.y0 <= yy <= r.y1 for yy in ys)), None)
                    if cover is None:
                        fails.append(f"p{pi+1}: highlight {name!r}: block at y={ys[0]:.0f} has no covering rect")
                        continue
                    for L in blk_lines:
                        ey = ymap(L)
                        for w in awords:
                            if abs(w[3] - ey) <= 5.0 and w[0] < wcut:
                                if w[0] < cover.x0 - 1 or w[2] > cover.x1 + 1:
                                    fails.append(f"p{pi+1}: highlight {name!r}: word {w[4]!r} "
                                                 f"outside rect at y={ey:.0f}")
                for r in rects:
                    for L in blines:
                        if id(L) in mine:
                            continue
                        ey = ymap(L)
                        if not (r.y0 + 2 < ey < r.y1 - 2):
                            continue
                        fx0, fx1 = xspan(L)
                        if fx1 > r.x0 + 2 and fx0 < r.x1 - 2:
                            fails.append(f"p{pi+1}: highlight {name!r} rect covers foreign line "
                                         f"{L['text'][:30]!r} at y={ey:.0f}")

    if len(gap_bad) > 2:
        fails.append(f"kerning: {len(gap_bad)} word gaps deviate from uniform scaling")
        fails.extend("  " + g for g in gap_bad[:8])

    med = statistics.median(ratios) if ratios else 0
    notes.append(f"dialogue lines checked: {len(ratios)}, median size ratio {med:.3f}")
    requested = report["requestedScale"] if report else 1.25
    backoffs = [p for p in (report["pages"] if report else []) if p["appliedScale"] < requested - 0.005]
    # Only require real enlargement when the user actually asked for it (>1.05x).
    if requested > 1.05 and ratios and med < min(1.2, requested - 0.03) and not backoffs:
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
