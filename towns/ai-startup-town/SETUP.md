# AI Startup Town — deployment setup

Content-only town, deploys via `town-cli` like the others. Depends on the
CORE Google Docs integration in **service-account mode** so all created
docs are public-by-link and owned by the town, not the operator's
personal Drive.

## The roster

| Building | NPC | Role | Section they own | Beats |
|---|---|---|---|---|
| Welcome Room | **Sam** | Registrar — clones the deck | *(no section)* | — |
| Loft | Paul Graham (PG) | Cofounder | Founder Story & Insight | Scene · Insight · Founder-market fit · Early users |
| Case Study Room | Ali Rowghani | Cofounder | The Problem & Why Now | Status quo · Friction · Why now · Strategic reframe |
| Brand Studio | Garry Tan | Cofounder | Product & Brand Feel | What it does · First 30 seconds · The one word · What we left out |
| Engineering Bay | Diana Hu | Cofounder | Technical Architecture & Scale Plan | Stack · Pipeline moat · Failure mode · The interesting bet |
| War Room | Michael Seibel | Cofounder | Traction & North Star Metric | The one number · Weekly delta · Receipts · What 10x would take |
| GTM Booth | Dalton Caldwell | Cofounder | Distribution & First 100 Users | First 100 · Repeatable channel · What we tried and killed · Unfair asset |
| Cold-Plunge | Bryan Johnson | Cofounder | Founder Mindset & Why We Won't Quit | Cadence · Optimization · Why competitors burn out · 10-year commitment |

Section order in the deck matches the cofounder table — a real pitch
flow (founder story → problem/why now → product → tech → traction →
distribution → mindset → ask). The **beats** are the sub-questions each
cofounder walks the founder through; they scaffold the conversation and
the finished section. Bryan closes the tour by pointing the founder at
the **Ask** section, which the founder writes themselves.

## Roles are separate

- **Sam** owns the deck lifecycle (create it once per visitor). Sam is
  the only NPC with `clone_document`. He never calls `replace_text`
  and doesn't have the permission for it, so a hallucinated tool call
  would fail rather than corrupt someone else's section.
- **The seven cofounders** edit their assigned section. They have
  `list_documents` + `replace_text` on Google Docs — no clone
  permission, so a bug or hallucination cannot spawn duplicate decks.

## Guardrails baked into every cofounder prompt

Every cofounder MDX carries the same guarded pattern before its
`replace_text` step. These are the rules the model must follow:

1. **Beat completion is strict.** If any of the four beats is missing
   or thin, the cofounder does not call `replace_text`. They ask a
   targeted follow-up for the missing beat.
2. **No fabrication or cross-building filling.** The cofounder never
   invents answers, thickens a thin answer, or pulls content from a
   sibling cofounder's section.
3. **Wandering is parked, not covered for.** If the founder trails off
   after two or three beats, the cofounder says *"Come back when
   you've got the last one — I'll be here."*
4. **The "just put it in the deck" ask is refused.** If the founder
   asks the cofounder to write it for them, guess, or fill something
   in — the cofounder refuses warmly: *"The deck is only useful if
   it's yours. Give me the real answer and I'll get it down."*
5. **Stale doc handling.** If `replace_text` returns a not-found or
   permission error on a URL from memory, the cofounder retries via
   `list_documents` for the deterministic name. If that also misses,
   the deck is gone — the cofounder sends the founder back to Sam.
6. **One replacement per conversation.** The cofounder replaces exactly
   once and does not re-touch a section whose placeholder is already
   gone.
7. **`replaceText` construction is exact.** Block content only, no code
   fences; blank line after the date; underscores around the date
   (italic) and double-asterisks around each beat label (bold),
   preserved verbatim.

## One-time setup for the town owner

1. **Create a Google Cloud service account.**
   - GCP console → IAM & Admin → Service Accounts → Create.
   - Download the JSON key. Don't check it into git.

2. **Enable APIs** on the service account's project:
   - Google Docs API
   - Google Drive API

3. **Create the template doc** (owned by the service account).
   - Either: log in as the service account and create the doc directly.
   - Or: create it under any Google account, then share it with the
     service account's email as **Editor**.
   - Title the doc **exactly** `AI STARTUP TOWN TEMPLATE`. Sam finds
     it by name at clone time.
   - Paste the [template skeleton](#template-doc-skeleton) below.

4. **Connect to CORE.** From `app.getcore.me`, connect the Google Docs
   integration for this town owner's account. Choose the **service
   account** auth path. Paste the JSON key. This gives Sam a
   service-account-backed Docs client that auto-shares every cloned
   doc as anyone-with-link viewer.

5. **Deploy the town.** `cd towns/ai-startup-town && town deploy`.

## How doc state flows

**Sam's job (once per visitor):**

1. `memory_search(query="pitch deck google doc URL for this visitor")` —
   check `<visitor_memory>` for an existing URL (returning visitor).
2. `list_documents` — look for a doc named exactly `AI STARTUP TOWN
   DECK — <Session key>`. Cross-check the memory result against this
   list; if memory returned a URL but Drive doesn't have it, treat the
   deck as gone.
3. If both misses (or memory is stale): find `AI STARTUP TOWN TEMPLATE`,
   call `clone_document(source, title: "AI STARTUP TOWN DECK — <Session
   key>", makePublic: true)`. Take the returned URL.
4. Return the URL in chat and point the founder at the cofounders.

**Each cofounder's job (per section):**

1. `memory_search` for the deck URL in `<visitor_memory>`.
2. If missed: `list_documents` for `AI STARTUP TOWN DECK — <Session key>`.
3. If neither found: warmly redirect the founder to Sam at the Welcome
   Room. They cannot clone (no permission) — chat instead.
4. If found: work the four beats (strict completion gate above), then
   `replace_text` on their placeholder with a beat-labeled paragraph.
   If `replace_text` errors on a stale URL, retry via `list_documents`;
   if that also misses, send the founder back to Sam.
5. Mention the URL naturally in the reply so memory catches it for the
   next cofounder.

The **Session key** is the opaque per-visitor id every NPC receives in
their system prompt (surfaced from `visitorSubjectKey` in
`/api/npc-chat`, matches the endUserId used to stamp memory episodes).
Deterministic naming means every NPC computes the same doc name.

## Template doc skeleton

Paste this into `AI STARTUP TOWN TEMPLATE`. Each cofounder replaces
exactly one placeholder with their signed, beat-structured paragraph.

```
[Banner image at top]

[[Founder's one-liner]]

A pitch deck workshopped with seven cofounders you'll never get in one room.
Each section is signed by the cofounder who wrote it.

———

Founder Story & Insight — Paul Graham
The moment you realized this was the problem worth your life. One scene,
one insight, no jargon.
Beats: Scene · Insight · Founder-market fit · Early users
[[to be filled by PG at the Loft]]

———

The Problem & Why Now — Ali Rowghani
What breaks in the world today, and what changed in the last 18 months
that makes this finally possible.
Beats: Status quo · Friction · Why now · Strategic reframe
[[to be filled by Ali Rowghani at the Case Study Room]]

———

Product & Brand Feel — Garry Tan
What it looks like, how it feels the first 30 seconds, why users
describe it in one word.
Beats: What it does · First 30 seconds · The one word · What we left out
[[to be filled by Garry Tan at the Brand Studio]]

———

Technical Architecture & Scale Plan — Diana Hu
The model stack, the moat in the pipeline, and how this survives at
100x load.
Beats: Stack · Pipeline moat · Failure mode · The interesting bet
[[to be filled by Diana Hu at the Engineering Bay]]

———

Traction & North Star Metric — Michael Seibel
Receipts. The one number you'd bet the company on, and what it's doing
week over week.
Beats: The one number · Weekly delta · Receipts · What 10x would take
[[to be filled by Michael Seibel at the War Room]]

———

Distribution & First 100 Users — Dalton Caldwell
How the first hundred showed up, and the repeatable channel behind the
next ten thousand.
Beats: First 100 · Repeatable channel · What we tried and killed · Unfair asset
[[to be filled by Dalton Caldwell at the GTM Booth]]

———

Founder Mindset & Why We Won't Quit — Bryan Johnson
The operating system of the founder. Sleep, focus, cadence, and the
reason competitors will burn out first.
Beats: Cadence · Optimization · Why competitors burn out · 10-year commitment
[[to be filled by Bryan Johnson at the Cold-Plunge]]

———

The Ask
The round, the use of funds, the next milestone, and what you need from
the reader specifically.
Beats: Round · Use of funds · Next milestone · Specific ask of the reader
[[you fill this yourself — round, use of funds, next milestone]]

———

Workshopped in AI Startup Town.
```

## Section attribution format

Each cofounder replaces their placeholder with:

```
_<Cofounder Name>, YYYY-MM-DD_

**<Beat 1>.** <one to two sentences answering that beat, in their voice>
**<Beat 2>.** <one to two sentences>
**<Beat 3>.** <one to two sentences>
**<Beat 4>.** <one to two sentences>
```

Beat labels match the section's declared beats verbatim, in order.
Never overwrites the section heading, italic prompt, or Beats line.
Never edits another cofounder's section. Never re-edits their own
section on a revisit (the placeholder is gone; nothing to replace).
