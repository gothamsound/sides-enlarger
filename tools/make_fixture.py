#!/usr/bin/env python3
"""Generate a synthetic screenplay "sides" PDF fixture (no real script needed).

Layout mimics Final Draft output: 12pt Courier, US Letter, meaning-by-indent.
Per-page horizontal drift simulates photocopied sides.
"""
import os
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

W, H = letter  # 612 x 792
FONT = "Courier"
SIZE = 12
LEAD = 12  # 6 lines per inch

# nominal columns (points)
X_ACTION = 108   # 1.5"
X_DIAL   = 180   # 2.5"
X_PAREN  = 223   # ~3.1"
X_CUE    = 266   # ~3.7"
X_TRANS  = 420

OUT = os.path.join(os.path.dirname(__file__), "..", "out", "fixture.pdf")

# token types: (kind, text) — kind decides indent
PAGES = [
    # page 1
    [
        ("head", "EPISODE 407 - \"NIGHT WORK\""),
        ("blank",), ("blank",),
        ("slug", "INT. PRECINCT BULLPEN - NIGHT"),
        ("blank",),
        ("action", "LAURA VANCE, 40s, sharp-eyed, drops a case file"),
        ("action", "on the desk. Across from her, DETECTIVE MORROW"),
        ("action", "doesn't look up from his coffee."),
        ("blank",),
        ("cue", "LAURA"),
        ("dial", "You want to tell me why the"),
        ("dial", "evidence log says nine bags and"),
        ("dial", "the locker says eight?"),
        ("blank",),
        ("cue", "MORROW"),
        ("paren", "(not looking up)"),
        ("dial", "Clerical error."),
        ("blank",),
        ("cue", "LAURA"),
        ("dial", "Eight years I've known you. You"),
        ("dial", "only say 'clerical' when you're"),
        ("dial", "lying."),
        ("blank",),
        ("action", "Morrow finally looks up. A long beat."),
        ("blank",),
        ("cue", "MORROW"),
        ("dial", "Close the door."),
        ("blank",),
        ("trans", "CUT TO:"),
    ],
    # page 2 — long block ending in (MORE)
    [
        ("head", "EPISODE 407 - \"NIGHT WORK\""),
        ("blank",), ("blank",),
        ("slug", "INT. INTERVIEW ROOM 2 - CONTINUOUS"),
        ("blank",),
        ("action", "Laura sits opposite a nervous WITNESS. A tape"),
        ("action", "recorder spins between them."),
        ("blank",),
        ("cue", "LAURA"),
        ("dial", "Start from the loading dock."),
        ("dial", "Every detail. What you saw, what"),
        ("dial", "you heard, what you smelled."),
        ("blank",),
        ("cue", "WITNESS"),
        ("dial", "It was raining. The truck came in"),
        ("dial", "around two, maybe two-fifteen."),
        ("dial", "Two guys got out. One of them I"),
        ("dial", "knew from the union hall, the"),
        ("dial", "other one I never seen before."),
        ("paren", "(beat)"),
        ("dial", "The new guy had a badge."),
        ("blank",),
        ("cue", "LAURA"),
        ("dial", "A police badge. You're certain."),
        ("dial", "Because that word means something"),
        ("dial", "in a courtroom, so I need you to"),
        ("more", "(MORE)"),
    ],
    # page 3 — (CONT'D) pickup + dual dialogue
    [
        ("head", "EPISODE 407 - \"NIGHT WORK\""),
        ("blank",), ("blank",),
        ("cue", "LAURA (CONT'D)"),
        ("dial", "be certain before you answer."),
        ("blank",),
        ("action", "The witness nods slowly. In the observation room,"),
        ("action", "Morrow and CAPTAIN DIAZ talk over each other:"),
        ("blank",),
        ("dual_cues", "MORROW", "DIAZ"),
        ("dual", "She's going to blow", "Let her run it down."),
        ("dual", "this wide open.", "That's the job."),
        ("blank",),
        ("action", "Diaz kills the intercom."),
        ("blank",),
        ("cue", "DIAZ"),
        ("dial", "How long has she been on this?"),
        ("blank",),
        ("cue", "MORROW"),
        ("dial", "Three weeks. Off book."),
    ],
    # page 4 — overlong dialogue line to force per-page back-off
    [
        ("head", "EPISODE 407 - \"NIGHT WORK\""),
        ("blank",), ("blank",),
        ("slug", "EXT. IMPOUND LOT - DAWN"),
        ("blank",),
        ("action", "Laura walks the rows of seized cars, checking VINs"),
        ("action", "against a printout."),
        ("blank",),
        ("cue", "LAURA"),
        ("paren", "(into phone)"),
        ("dial", "Run plate king-four-seven-adam-adam-nine, then pull"),
        ("dial", "the chain of custody on the ninth bag."),
        ("blank",),
        ("action", "She stops at a black sedan. The trunk is ajar."),
        ("blank",),
        ("cue", "LAURA (CONT'D)"),
        ("dial", "...I'll call you back."),
    ],
]

def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    c = canvas.Canvas(OUT, pagesize=letter)
    for pi, page in enumerate(PAGES):
        drift = (pi * 3) - 4  # photocopy drift: -4, -1, +2, +5 pt
        c.setFont(FONT, SIZE)
        y = H - 54  # ~0.75" top margin
        # page number top-right
        c.drawString(W - 90 + drift, y, "%d." % (pi + 34))
        for tok in page:
            kind = tok[0]
            if kind == "blank":
                y -= LEAD
                continue
            if kind == "head":
                c.drawString(X_ACTION + drift, y, tok[1])
                y -= LEAD
                continue
            if kind == "dual_cues":
                c.drawString(150 + drift, y, tok[1])
                c.drawString(330 + drift, y, tok[2])
                y -= LEAD
                continue
            if kind == "dual":
                c.drawString(115 + drift, y, tok[1])
                c.drawString(295 + drift, y, tok[2])
                y -= LEAD
                continue
            x = {"slug": X_ACTION, "action": X_ACTION, "cue": X_CUE,
                 "dial": X_DIAL, "paren": X_PAREN, "more": X_DIAL,
                 "trans": X_TRANS}[kind]
            c.drawString(x + drift, y, tok[1])
            y -= LEAD
        c.showPage()
    c.save()
    print("wrote", os.path.abspath(OUT), "pages:", len(PAGES))

if __name__ == "__main__":
    main()
