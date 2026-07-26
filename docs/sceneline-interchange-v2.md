# The `.sceneline` interchange format — v2

One show, many benches. This spec lets every Gotham scene-breakdown tool —
**Sceneline** (runs the read), **Tablecut** (will shoot it), **Techspotter** (preps
it), **sides-enlarger** (prints it for actors) — read and write one file, so work
done in any tool flows to the others. File extension stays **`.sceneline`**; the
payload is a single UTF-8 JSON object.

## 1. Envelope

```json
{
  "format": "sceneline",
  "interchange": 2,
  "source": {
    "title": "MB 102",
    "file": "CombinedPrintable-102.pdf",
    "generator": "tablework/1.0",
    "created": "2026-07-26T14:00:00Z"
  },
  "show": {
    "characters": ["MYRON", "WIN", "..."],
    "cast_list": [],
    "cast_nonspeaking": [],
    "scenes": [
      {
        "scene": "14",
        "scene_heading": "INT. LAB - NIGHT",
        "page_start": 12,
        "speakers": ["MYRON", "WIN"],
        "present_suggest": [],
        "dialogue_text": "…optional…",
        "action_text": "…optional…"
      }
    ],
    "review_dismissed": []
  },
  "extensions": { }
}
```

- **`interchange: 2`** identifies this spec. A file *without* the field (or
  without `extensions`) is **v1** — Sceneline's existing bundles — and every v2
  reader MUST accept it (v1 is exactly the envelope above minus the two new
  top-level fields).
- **`show` is the core.** Every tool MUST read it; a tool that edits the matrix
  MUST write it back complete.

## 2. Core rules (violating these breaks real scripts)

1. **`scene` ids are strings** — real drafts have `"22A"`. Never parse to int;
   order is the array order, not numeric sort.
2. **Character names are uppercase, trimmed**, and variant names are distinct
   entries (`YOUNG VALERIE` ≠ `VALERIE`, `MYRON'S TEXT` ≠ `MYRON`) — merging is a
   human decision made in some tool's UI, never implied by the format.
3. `speakers` = who has dialogue; `present_suggest` = suggested non-speaking
   presence. Operator-confirmed presence lives in `speakers` (a confirmed cell is
   a fact, not a suggestion).
4. **`dialogue_text` / `action_text` are OPTIONAL** — see profiles (§4).

## 3. Extensions — the interoperability keystone

`extensions` is a map of **namespaced blocks**, one per concern. Registered now:

| Key | Owner (writer) | Contents |
|---|---|---|
| `sound` | Techspotter | department moments: `{"moments":[{"scene":"14","category":"playback"\|"phone"\|"sfx-reaction","snippet":"…","page":12,"characters":["MYRON"],"dismissed":false}]}` |
| `video` | Techspotter | same shape; categories `phone-screen` \| `tv-screen` \| `video-playback` |
| `treatments` | Tablecut (candidates writable by any tool) | per-scene handling: `{"14":{"mode":"composite","why":"rapid-fire","source":"tablework"}}` |
| `seats` | Tablecut | seat/mic/camera mapping (rig-specific; lean files usually omit) |
| `sides` | sides-enlarger | `{"settings":{"scale":…,"mode":…},"characters":{"NAME":{"pages":[…],"highlight":{"key":"…","rgb":"#…"},"enlarge":true,"added":true?}}}` — `highlight` carries both the tool's palette key and a plain rgb so others can render it; `added:true` marks operator name-adds made at the sides bench = **promotion candidates** the matrix tools may offer to lift into `show.characters` (sides-enlarger itself never edits `show` in v1) |

**The rule that makes this work: a tool MUST preserve every extension block
(and any unknown top-level field) it does not understand, VALUE-IDENTICALLY,
on every import→edit→export round-trip** — keep the parsed object untouched and
re-emit it; rewrite only the blocks you own. Byte-identity is explicitly NOT
required (serializers differ in key order/whitespace/number formatting);
round-trip tests assert **deep equality** of foreign blocks, not literal bytes.
Strip nothing. (Without this, one pass through any tool silently destroys
another department's work.)

Unregistered experiments use an `x-` prefix (`x-myidea`); promotion to a bare
key happens by updating this spec.

## 4. Profiles: lean vs. full

- **`full`** — includes `dialogue_text`/`action_text`. **As sensitive as the
  screenplay itself: local-only, never committed to a repo, never uploaded.**
  Required by tools that index text (Sceneline's tracker; Techspotter's
  department scan runs from text but may emit lean output).
- **`lean`** — the same file with all `dialogue_text`/`action_text` omitted and
  extension `snippet` fields truncated to ≤ 120 chars. Shareable with cast/crew.
  Every exporter MUST offer "export lean"; every importer MUST accept both.
  `source.profile: "lean" | "full"` declares which.

## 5. Adoption status / required changes per tool

| Tool | Reads | Writes | Change needed |
|---|---|---|---|
| Sceneline | v1 today | v1 today | accept `interchange:2`; **preserve `extensions` on round-trip** (small backlog item) |
| Techspotter | — (new build) | — | build to v2 natively; CSV/XLSX remain as secondary exports |
| sides-enlarger | own parsing today | — | add import (skip re-extraction when a `.sceneline` is provided) + export (see its brief) |
| Tablecut | FSD §5.4 commits to `.sceneline` | planned | adopt v2 by name in the FSD; own `treatments`/`seats`; read `sound`/`video` as treatment candidates (see its brief) |

## 6. Versioning policy

Additive changes (new extension keys, new optional fields) do not bump
`interchange`. Breaking changes to `show` bump it; readers refuse versions above
what they know **loudly** ("this file is from a newer tool"), never by guessing.
This spec doc is canonical; it lives in whichever repo hosts it and is copied
verbatim into each adopting repo's `docs/` (drift is prevented by keeping §1–§4
short enough to diff by eye).

## 7. Repo hygiene (every adopting repo)

- **Commit this spec at `docs/`** — it contains no script text and must be
  visible, never parked in a gitignored samples directory.
- **Gitignore `*.sceneline`** — a full-profile file carries the screenplay's
  text and must never enter git history. Committed test fixtures are therefore
  **generated** (synthetic, lean or full) at test time, never stored.

---
*Rev 2026-07-26b — preservation law clarified to deep-equal (byte-identity
unachievable through serializers); `sides` block shape registered incl.
`added:true` promotion candidates; §7 repo hygiene added. (Credit: the
sides-enlarger session's adoption review.)*

> **Local note (sides-enlarger copy):** the tool formerly called **Tablework**
> is now **Techspotter**; this copy uses the new name throughout. Fold the rename
> into the canonical spec when convenient so the copies stop diverging.
