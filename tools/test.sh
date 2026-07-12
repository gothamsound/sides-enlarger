#!/usr/bin/env bash
# One-shot verification: synthesize a fixture, run the engine at several scales,
# and assert page parity + non-dialogue-unchanged + dialogue-enlarged via the
# independent checker. Optionally also runs against real PDFs you pass as args.
#
#   bash tools/test.sh                 # fixture only (safe, in-repo)
#   bash tools/test.sh path/to/real.pdf [more.pdf ...]   # + your local sides
set -euo pipefail
cd "$(dirname "$0")/.."

RENDER_DIR="${RENDER_DIR:-out/renders}"
mkdir -p out "$RENDER_DIR"

echo "==> generating synthetic fixture"
python3 tools/make_fixture.py

fail=0
run_one () {
  local src="$1" tag="$2"
  for scale in 1.0 1.25 1.5; do
    local outpdf="out/${tag}.${scale}.pdf"
    node tools/run_engine_node.mjs "$src" "$outpdf" "$scale" >/dev/null 2>"out/${tag}.err" || {
      if grep -q '^SCANNED' "out/${tag}.err"; then
        echo "    [$tag @ $scale] correctly rejected as scan"; continue
      fi
      echo "    [$tag @ $scale] ENGINE ERROR:"; cat "out/${tag}.err"; fail=1; continue
    }
    if CHECK_RENDER_DIR="$RENDER_DIR/${tag}_${scale}" \
         python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" \
         | grep -q '^PASS'; then
      echo "    [$tag @ $scale] PASS"
    else
      echo "    [$tag @ $scale] FAIL"
      CHECK_RENDER_DIR="$RENDER_DIR/${tag}_${scale}" \
        python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" | grep '  - ' || true
      fail=1
    fi
  done
}

check_one () {  # src outpdf label renderdir
  local src="$1" outpdf="$2" label="$3" rdir="$4"
  if CHECK_RENDER_DIR="$rdir" python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" \
       | grep -q '^PASS'; then
    echo "    [$label] PASS"
  else
    echo "    [$label] FAIL"
    CHECK_RENDER_DIR="$rdir" python3 tools/check.py "$src" "$outpdf" "${outpdf}.report.json" | grep '  - ' || true
    fail=1
  fi
}

echo "==> testing fixture"
run_one out/fixture.pdf fixture

echo "==> fixture: character extraction"
python3 - <<'PY' && echo "    [extraction] PASS" || { echo "    [extraction] FAIL"; fail=1; }
import json, sys
rep = json.load(open("out/fixture.1.25.pdf.report.json"))
names = sorted(c["name"] for c in rep.get("characters", []))
expected = sorted(["LAURA", "MORROW", "WITNESS", "DIAZ",
                   "ELEANOR FROM HR", "SAM", "MERC #1"])
if names != expected:
    print("      extracted:", names)
    print("      expected :", expected)
    sys.exit(1)
PY

echo "==> fixture: highlights (LAURA=yellow, MERC #1=sky)"
for scale in 1.0 1.25; do
  outpdf="out/fixture.hl.${scale}.pdf"
  node tools/run_engine_node.mjs out/fixture.pdf "$outpdf" "$scale" 'LAURA=0;MERC #1=2' \
    >/dev/null 2>out/fixture.hl.err || { echo "    [highlights @ $scale] ENGINE ERROR:"; cat out/fixture.hl.err; fail=1; continue; }
  if CHECK_RENDER_DIR="$RENDER_DIR/fixture_hl_${scale}" \
       python3 tools/check.py out/fixture.pdf "$outpdf" "${outpdf}.report.json" \
       | grep -q '^PASS'; then
    echo "    [highlights @ $scale] PASS"
  else
    echo "    [highlights @ $scale] FAIL"
    CHECK_RENDER_DIR="$RENDER_DIR/fixture_hl_${scale}" \
      python3 tools/check.py out/fixture.pdf "$outpdf" "${outpdf}.report.json" | grep '  - ' || true
    fail=1
  fi
done

echo "==> fixture: selective enlargement (only LAURA; highlight on unenlarged MERC #1)"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.sel.pdf 1.25 'MERC #1=2' --enlarge-only='LAURA' \
  >/dev/null 2>out/fixture.sel.err || { echo "    [selective] ENGINE ERROR:"; cat out/fixture.sel.err; fail=1; }
check_one out/fixture.pdf out/fixture.sel.pdf "selective @ 1.25" "$RENDER_DIR/fixture_sel"

echo "==> fixture: whole-page mode"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.page.pdf 1.5 'LAURA=0' --mode=page \
  >/dev/null 2>out/fixture.page.err || { echo "    [page mode] ENGINE ERROR:"; cat out/fixture.page.err; fail=1; }
check_one out/fixture.pdf out/fixture.page.pdf "page mode @ 1.5" "$RENDER_DIR/fixture_page"

echo "==> fixture: reader mode"
node tools/run_engine_node.mjs out/fixture.pdf out/fixture.reader.pdf 1.25 'LAURA=0' --mode=reader \
  >/dev/null 2>out/fixture.reader.err || { echo "    [reader mode] ENGINE ERROR:"; cat out/fixture.reader.err; fail=1; }
check_one out/fixture.pdf out/fixture.reader.pdf "reader mode @ 1.25" "$RENDER_DIR/fixture_reader"

# real sides: whole-page mode + selective enlargement of the top character
run_modes () {
  local src="$1" tag="$2"
  node tools/run_engine_node.mjs "$src" "out/${tag}.page.pdf" 1.25 "" --mode=page \
    >/dev/null 2>"out/${tag}.page.err" || { echo "    [$tag page mode] ENGINE ERROR:"; cat "out/${tag}.page.err"; fail=1; return; }
  check_one "$src" "out/${tag}.page.pdf" "$tag page mode" "$RENDER_DIR/${tag}_page"
  local top
  top=$(python3 -c "import json;r=json.load(open('out/${tag}.1.25.pdf.report.json'));cs=[c for c in r.get('characters',[]) if c.get('lines')];print(cs[0]['name'] if cs else '')" 2>/dev/null || true)
  [ -z "$top" ] && return
  node tools/run_engine_node.mjs "$src" "out/${tag}.sel.pdf" 1.25 "${top}=0" --enlarge-only="$top" \
    >/dev/null 2>"out/${tag}.sel.err" || { echo "    [$tag selective] ENGINE ERROR:"; cat "out/${tag}.sel.err"; fail=1; return; }
  check_one "$src" "out/${tag}.sel.pdf" "$tag selective '$top'" "$RENDER_DIR/${tag}_sel"
  node tools/run_engine_node.mjs "$src" "out/${tag}.reader.pdf" 1.25 "${top}=0" --mode=reader \
    >/dev/null 2>"out/${tag}.reader.err" || { echo "    [$tag reader] ENGINE ERROR:"; cat "out/${tag}.reader.err"; fail=1; return; }
  check_one "$src" "out/${tag}.reader.pdf" "$tag reader" "$RENDER_DIR/${tag}_reader"
}

# real sides: also verify highlighting the most-talkative extracted character
run_hl () {
  local src="$1" tag="$2"
  local top
  top=$(python3 -c "import json;r=json.load(open('out/${tag}.1.25.pdf.report.json'));cs=[c for c in r.get('characters',[]) if c.get('lines')];print(cs[0]['name'] if cs else '')" 2>/dev/null || true)
  if [ -z "$top" ]; then echo "    [$tag highlight] no characters extracted — skipped"; return; fi
  node tools/run_engine_node.mjs "$src" "out/${tag}.hl.pdf" 1.25 "${top}=0" \
    >/dev/null 2>"out/${tag}.hl.err" || { echo "    [$tag highlight] ENGINE ERROR:"; cat "out/${tag}.hl.err"; fail=1; return; }
  if CHECK_RENDER_DIR="$RENDER_DIR/${tag}_hl" \
       python3 tools/check.py "$src" "out/${tag}.hl.pdf" "out/${tag}.hl.pdf.report.json" \
       | grep -q '^PASS'; then
    echo "    [$tag highlight '$top'] PASS"
  else
    echo "    [$tag highlight '$top'] FAIL"
    CHECK_RENDER_DIR="$RENDER_DIR/${tag}_hl" \
      python3 tools/check.py "$src" "out/${tag}.hl.pdf" "out/${tag}.hl.pdf.report.json" | grep '  - ' || true
    fail=1
  fi
}

for real in "$@"; do
  name="$(basename "$real" .pdf)"
  echo "==> testing real: $name"
  run_one "$real" "real_${name}"
  run_hl "$real" "real_${name}"
  run_modes "$real" "real_${name}"
done

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN. Side-by-side renders in $RENDER_DIR/"
else
  echo "SOME CHECKS FAILED (see above)."; exit 1
fi
