# AI Startup Town — deployment setup

Content-only town, deploys via `town deploy` like the others. The working
artifact is a **living Google Doc — the visitor's startup deck.** Sam creates
it; each advisor writes one section into it.

**Town owner:** `core-support`. The CORE **Google Docs integration** must be
connected on that account (OAuth — Docs + Drive scopes). Because every NPC tool
call runs under the town owner, **the deck flow works for guests too** — the
visitor's own Google account is never touched.

## The roster

| Building | NPC | Deck section |
|---|---|---|
| The Welcome Room | **Sam** | *(onboards, creates & shares deck, routes)* |
| The Founder's Loft | **Paul Graham** | Founder Story & Insight |
| The Case Study Room | **Ali Rowghani** | The Problem & Why Now |
| The Marketing Studio | **Garry Tan** | Positioning & Marketing |
| The Engineering Bay | **Diana Hu** | Technical Architecture & Scale Plan |
| The War Room | **Michael Seibel** | Traction & North-Star Metric |
| The GTM Booth | **Dalton Caldwell** | Distribution & First 100 Users |
| The Proving Ground | **Brian Chesky** | Founder Grit & Why We Won't Quit |
| — | *(founder writes it)* | The Ask |

Sam explains the town, sets up the deck, and routes the visitor to the best-fit
advisor. The seven advisors each own one section and run an office-hours
conversation before writing it.

## Roles are separate

- **Sam** owns the deck lifecycle (create it once per visitor). He is the only
  NPC with `clone_document`, and he never has `replace_text` — so a hallucinated
  call can't corrupt a section.
- **The seven advisors** each edit one section. They have `list_documents` +
  `replace_text` — no clone permission, so a bug can't spawn duplicate decks.

## The deck

- **Title (deterministic):** `My Startup Deck — <Session key>`. Every NPC
  computes the same title from the opaque per-visitor Session key in its prompt,
  so they all find the same doc. Never verbalized.
- **Template:** hardcoded in Sam's `clone_document` call:
  `https://docs.google.com/document/d/1PoJx2e0o1l2UPQHvjG7-Cx0mL_G2ga_RQd3qWqtSTNo/edit`.
  It must be readable by the town owner (they own it, it's shared with them, or
  it's public "anyone with the link can view").
- **Clones** land in a `startups/` folder at the root of the owner's Drive
  (created lazily on first clone), `makePublic: true`, so the founder's URL just
  works.

## ⚠️ Keep the template in sync with the sections

Each advisor replaces an exact placeholder string via `replace_text`. **The
template body must contain those exact placeholders** or the replacement fails
and the advisor sends the founder back to Sam. If you change an advisor's name,
building, or section, update the template to match. The current placeholders:

- `[[to be filled by Paul Graham at the Founder's Loft]]`
- `[[to be filled by Ali Rowghani at the Case Study Room]]`
- `[[to be filled by Garry Tan at the Marketing Studio]]`
- `[[to be filled by Diana Hu at the Engineering Bay]]`
- `[[to be filled by Michael Seibel at the War Room]]`
- `[[to be filled by Dalton Caldwell at the GTM Booth]]`
- `[[to be filled by Brian Chesky at the Proving Ground]]`

## One-time setup for the town owner

1. **Connect Google Docs to CORE** for the `core-support` account (OAuth; click
   past the "Google hasn't verified this app" warning → Advanced → Go to app).
2. **Verify template access.** Open the template URL above while signed in as
   the owner; make sure the owner can read it, and that its body matches the
   skeleton below (placeholders included).
3. **Deploy:** `cd towns/ai-startup-town && town deploy`.

## How doc state flows

**Sam (once per visitor):**
1. `list_documents` — look for `My Startup Deck — <Session key>`. If it exists,
   reuse its URL.
2. If not found: `clone_document` with the hardcoded template URL, `title: "My
   Startup Deck — <Session key>"`, `folderName: "startups"`, `makePublic: true`.
3. Share the URL and route the founder to an advisor.

**Each advisor (per section):**
1. `list_documents` for `My Startup Deck — <Session key>`.
2. If not found: redirect the founder to Sam. Advisors cannot clone and must not
   workshop the substance until the founder returns with a URL.
3. If found: work the four beats (strict completion gate), then `replace_text`
   on their placeholder with a beat-labeled paragraph. If `replace_text` errors,
   the deck is gone — send the founder back to Sam.

The **Session key** is the opaque per-visitor id every NPC receives in its
system prompt (`visitorSubjectKey` in `/api/npc-chat`, matching the endUserId
that stamps memory episodes). Deterministic naming means every NPC computes the
same doc name.

## Template doc skeleton

Create/maintain the template at the hardcoded URL with this body. Each advisor
replaces exactly one placeholder with their signed, beat-structured paragraph.

```
[Banner image at top]

[[Founder's one-liner]]

A startup deck workshopped with seven advisors you'll never get in one room.
Each section is signed by the advisor who wrote it.

———

Founder Story & Insight — Paul Graham
The moment you realized this was the problem worth your life. One scene, one
insight, no jargon.
Beats: Scene · Insight · Founder-market fit · Early users
[[to be filled by Paul Graham at the Founder's Loft]]

———

The Problem & Why Now — Ali Rowghani
What breaks in the world today, and what changed in the last 18 months that
makes this finally possible.
Beats: Status quo · Friction · Why now · Strategic reframe
[[to be filled by Ali Rowghani at the Case Study Room]]

———

Positioning & Marketing — Garry Tan
What it is, who it's for, and the message that makes people care.
Beats: Positioning · The hook · The one word · Launch move
[[to be filled by Garry Tan at the Marketing Studio]]

———

Technical Architecture & Scale Plan — Diana Hu
The model stack, the moat in the pipeline, and how this survives at 100x load.
Beats: Stack · Pipeline moat · Failure mode · The interesting bet
[[to be filled by Diana Hu at the Engineering Bay]]

———

Traction & North-Star Metric — Michael Seibel
Receipts. The one number you'd bet the company on, and what it's doing week
over week.
Beats: The one number · Weekly delta · Receipts · What 10x would take
[[to be filled by Michael Seibel at the War Room]]

———

Distribution & First 100 Users — Dalton Caldwell
How the first hundred showed up, and the repeatable channel behind the next
ten thousand.
Beats: First 100 · Repeatable channel · What we tried and killed · Unfair asset
[[to be filled by Dalton Caldwell at the GTM Booth]]

———

Founder Grit & Why We Won't Quit — Brian Chesky
The reason you'll still be standing in ten years, and the moment that proves it.
Beats: Why you · Founder mode · The crucible · Staying power
[[to be filled by Brian Chesky at the Proving Ground]]

———

The Ask
The round, the use of funds, the next milestone, and what you need from the
reader specifically.
Beats: Round · Use of funds · Next milestone · Specific ask of the reader
[[you fill this yourself — round, use of funds, next milestone]]

———

Workshopped in AI Startup Town.
```

## Section attribution format

Each advisor replaces their placeholder with:

```
_<Advisor Name>, YYYY-MM-DD_

**<Beat 1>.** <one to two sentences in their voice>
**<Beat 2>.** <one to two sentences>
**<Beat 3>.** <one to two sentences>
**<Beat 4>.** <one to two sentences>
```

Beat labels match the section's declared beats verbatim, in order. Never
overwrites the heading, italic prompt, or Beats line. Never edits another
advisor's section. Never re-edits their own on a revisit (the placeholder is
gone; nothing to replace).
