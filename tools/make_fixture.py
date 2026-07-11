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
    # page 5 — character-extraction traps: MERC #1, ELEANOR FROM HR,
    # (CONT'D)/(V.O.) folding, an all-caps action trap at cue indent with no
    # dialogue under it, a word-by-word drawn line (multi-run kerning), and a
    # revision star in the margin of a dialogue line
    [
        ("head", "EPISODE 407 - \"NIGHT WORK\""),
        ("blank",), ("blank",),
        ("slug", "INT. HR OFFICE - DAY"),
        ("blank",),
        ("action", "Sam knocks. ELEANOR FROM HR looks up, gestures at"),
        ("action", "the chair without smiling."),
        ("blank",),
        ("cue", "ELEANOR FROM HR"),
        ("dial", "Close the door, please. Sit."),
        ("blank",),
        ("cue", "SAM"),
        ("dial", "Is this about the parking thing?"),
        ("blank",),
        ("trapcue", "TWO SHOTS RING OUT"),
        ("blank",),
        ("action", "Sam hits the floor. The door SLAMS open: a MERC in"),
        ("action", "tactical gear, weapon up."),
        ("blank",),
        ("cue", "MERC #1"),
        ("dial", "Everybody stay where you are!"),
        ("stardial", "Hands where I can see them, all of you, now!"),
        ("blank",),
        ("cue", "SAM (CONT'D)"),
        ("paren", "(under the desk)"),
        ("worddial", "It was not me on the loading dock."),
        ("blank",),
        ("cue", "SAM (V.O.)"),
        ("dial", "That was the day I quit HR."),
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
            if kind == "worddial":
                # each word its own text-show op at an absolute x (the layout
                # real production PDFs use); exercises multi-run kerning
                x = X_DIAL + drift
                for word in tok[1].split(" "):
                    c.drawString(x, y, word)
                    x += (len(word) + 1) * 7.2  # Courier 12: 7.2pt/char
                y -= LEAD
                continue
            if kind == "stardial":
                # dialogue line with a revision star out in the right margin
                c.drawString(X_DIAL + drift, y, tok[1])
                c.drawString(W - 40 + drift, y, "*")
                y -= LEAD
                continue
            x = {"slug": X_ACTION, "action": X_ACTION, "cue": X_CUE,
                 "dial": X_DIAL, "paren": X_PAREN, "more": X_DIAL,
                 "trans": X_TRANS, "trapcue": X_CUE}[kind]
            c.drawString(x + drift, y, tok[1])
            y -= LEAD
        c.showPage()
    c.save()
    print("wrote", os.path.abspath(OUT), "pages:", len(PAGES))

if __name__ == "__main__":
    main()
