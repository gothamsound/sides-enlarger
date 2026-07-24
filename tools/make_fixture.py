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
        # text inside a narrow clip rect (like a call-sheet table cell):
        # whole-page mode must not let it grow out of its clip
        ("clipcell", "EVIDENCE LOG 9-A"),
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
        ("starcue", "MERC #1"),
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
    # page 6 — title/coverage page: no dialogue anywhere; must never be
    # enlarged in ANY mode (Everything mode included)
    [
        ("blank",), ("blank",), ("blank",), ("blank",),
        ("head", "\"NIGHT WORK\""),
        ("blank",),
        ("head", "EPISODE 407"),
        ("blank",), ("blank",),
        ("action", "WRITTEN BY"),
        ("action", "DANA KOVACS"),
        ("blank",), ("blank",),
        ("action", "PRODUCTION DRAFT - 06/12/22"),
        ("action", "SIDES FOR 07/13 - SCENES 12, 14, 18A"),
        ("blank",), ("blank",),
        ("action", "COVERAGE: D. KOVACS / EP. 407 / NIGHT WORK"),
    ],
    # pages 7-8 — the SAME form XObject (shared stationery with text) drawn
    # on both pages: a multi-use form can only be mutated once, so the engine
    # must refuse to scale these pages and say so
    [
        ("head", "EPISODE 407 - \"NIGHT WORK\""),
        ("blank",), ("blank",),
        ("slug", "INT. EVIDENCE ROOM - NIGHT"),
        ("blank",),
        ("cue", "LAURA"),
        ("dial", "Log it. All of it."),
        ("blank",),
        ("sharedform",),
    ],
    [
        ("head", "EPISODE 407 - \"NIGHT WORK\""),
        ("blank",), ("blank",),
        ("slug", "INT. EVIDENCE ROOM - LATER"),
        ("blank",),
        ("cue", "LAURA"),
        ("dial", "And the ninth bag goes with me."),
        ("blank",),
        ("sharedform",),
    ],
    # page 9 — CALL SHEET. No dialogue anywhere, but a two-column grid of
    # all-caps labels that reads as a stack of dual-dialogue cue rows. Dual
    # names bypass the dialogue-follow noise filter, so without the
    # no-dialogue page guard every one of these column headings lands in the
    # character list as a zero-line "character".
    [
        ("head", "CALL SHEET - DAY 6 OF 8"),
        ("blank",),
        ("dual_cues", "SCENE", "SET/ DESCRIPTION"),
        ("dual_cues", "CAST", "D/N"),
        ("dual_cues", "PAGES LOCATION", "ELEMENTS"),
        ("dual_cues", "CAMERA", "SOUND"),
        ("dual_cues", "HMU/ WARDROBE", "SPFX MAKEUP"),
        ("dual_cues", "RPT RPT TO", "# STAND INS"),
        ("blank",),
        ("action", "NO CREW PARKING ON SET--"),
    ],
]

# ---------------------------------------------------------------- fixture 2
# A multi-episode "day" side. Real day-sides stitch scenes from several
# episodes, so the running header's episode number, title, draft color and
# page number all change page to page and ONLY the leading show name is
# constant -- identical-text furniture matching cannot see it, and the engine
# must fall back to the show-name anchor. The show name is drawn glyph-per-op
# from x=40 so it straddles the body's x=70 boundary, exactly like real
# distributed sides (a left-clipping bug eats "PROC" and leaves "EDURAL").
OUT_MULTI = os.path.join(os.path.dirname(__file__), "..", "out", "fixture_multi.pdf")
MULTI_SHOW = "PROCEDURAL"
# (episode, title, draft, date, printed page number)
MULTI_HEAD = [
    ("209", "'Cold Open'",       "Blue Draft",     "4/28/26", 50),
    ("202", "'Fallen'",          "Goldenrod Rev.", "5/15/26", 45),
    ("202", "'Fallen'",          "Pink Draft",     "3/27/26", 46),
    ("205", "'Out Of The Past'", "Goldenrod Rev.", "6/8/26",  52),
    ("209", "'Cold Open'",       "Blue Draft",     "4/28/26", 33),
    ("204", "'Young Blood'",     "Blue Draft",     "4/14/26", 47),
]
MULTI_BODY = [
    [("slug", "INT. SQUAD ROOM - DAY"), ("blank",),
     ("cue", "HALSTEAD"), ("dial", "Run the plate one more time."), ("blank",),
     ("cue", "VOIGHT"), ("dial", "Already did. Comes back stolen.")],
    [("slug", "EXT. RIVER WALK - NIGHT"), ("blank",),
     ("cue", "VOIGHT"), ("dial", "He dumped it here. Has to be."), ("blank",),
     ("cue", "HALSTEAD"), ("dial", "Divers are twenty minutes out.")],
    [("slug", "INT. INTERVIEW ROOM - CONTINUOUS"), ("blank",),
     ("cue", "BURGESS"), ("paren", "(sliding the file over)"),
     ("dial", "Read it before you say another word.")],
    # page 4 carries the mid-scene continuation number in the left margin
    [("slug", "INT. MORGUE - DAY"), ("blank",),
     ("cue", "BURGESS"), ("dial", "Tell me that is not our guy."), ("blank",),
     ("cue", "HALSTEAD"), ("dial", "It is our guy.")],
    [("slug", "INT. SQUAD ROOM - LATER"), ("blank",),
     ("cue", "ATWATER"), ("dial", "Warrant came through."), ("blank",),
     ("cue", "VOIGHT"), ("dial", "Then we move now.")],
    [("slug", "EXT. LOADING DOCK - DAWN"), ("blank",),
     ("cue", "ATWATER"), ("dial", "Nobody goes in without a vest."), ("blank",),
     ("cue", "BURGESS"), ("dial", "Copy that.")],
]


def make_multi(path):
    c = canvas.Canvas(path, pagesize=letter)
    for pi, (ep, title, draft, date, pnum) in enumerate(MULTI_HEAD):
        c.setFont(FONT, SIZE)
        y = H - 54
        x = 40
        for ch in MULTI_SHOW:  # glyph-per-op, straddling the x=70 body edge
            c.drawString(x, y, ch)
            x += 7.2
        c.drawString(150, y, "%s  %s   %s  %s" % (ep, title, draft, date))
        c.drawString(500, y, "%d." % pnum)
        y -= LEAD * 3
        if pi == 3:
            # a mid-scene scene-number continuation mark in the LEFT margin.
            # It has no 3+-letter word (so it keys empty, like a page number)
            # but it sits BELOW the header edge band, so it is body text and
            # must survive reader mode instead of being eaten as furniture.
            c.drawString(53, H - 102, "5.46pt1")
        for tok in MULTI_BODY[pi]:
            if tok[0] == "blank":
                y -= LEAD
                continue
            xx = {"slug": X_ACTION, "action": X_ACTION, "cue": X_CUE,
                  "dial": X_DIAL, "paren": X_PAREN}[tok[0]]
            c.drawString(xx, y, tok[1])
            y -= LEAD
        c.showPage()
    c.save()
    print("wrote", os.path.abspath(path), "pages:", len(MULTI_HEAD))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    c = canvas.Canvas(OUT, pagesize=letter)
    # a form XObject shared by pages 7-8 (multi-use container with text)
    c.beginForm("SharedNote")
    c.setFont(FONT, SIZE)
    c.drawString(X_ACTION, 320, "PROPERTY OF PRODUCTION - DO NOT DUPLICATE")
    c.endForm()
    for pi, page in enumerate(PAGES):
        drift = (pi * 3) - 4 if pi < 6 else 2  # photocopy drift, mild on 7-8
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
            if kind == "sharedform":
                c.doForm("SharedNote")
                continue
            if kind == "clipcell":
                c.saveState()
                p = c.beginPath()
                p.rect(X_ACTION + drift - 2, y - 3, 132, 15)
                c.clipPath(p, stroke=0, fill=0)
                c.drawString(X_ACTION + drift, y, tok[1])
                c.restoreState()
                y -= LEAD
                continue
            if kind == "stardial":
                # dialogue line with a revision star out in the right margin
                c.drawString(X_DIAL + drift, y, tok[1])
                c.drawString(W - 40 + drift, y, "*")
                y -= LEAD
                continue
            if kind == "starcue":
                # character cue with a revision star ("TRACY  *"): must still
                # read as a cue, and the star must never scale
                c.drawString(X_CUE + drift, y, tok[1])
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
    make_multi(OUT_MULTI)

if __name__ == "__main__":
    main()
