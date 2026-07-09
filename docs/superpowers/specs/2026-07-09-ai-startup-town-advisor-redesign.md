# AI Startup Town — Advisor + Living Deck Redesign

**Date:** 2026-07-09
**Status:** Approved, implementing (v2 — deck restored)
**Town:** `towns/ai-startup-town/`
**Town owner:** `core-support` (has the CORE Google Docs integration
connected). All deck tool calls run under the owner account, so the flow works
for guests too — the visitor's own account is never used.

## Goal

Keep the town's **living Google-Doc pitch deck** as the payoff, but upgrade
everything around it. A concierge (**Sam**) onboards the visitor, explains the
town in plain language, creates and shares their deck, and routes them to the
best-fit **advisor**. Each advisor runs a real **office-hours** conversation on
one section and writes that section into the shared doc. By the end the visitor
has one comprehensive document covering every aspect of their startup.

This restores the original Google-Doc mechanic (v1 of this spec removed it);
this version brings it back with the naming, persona, routing, and office-hours
improvements layered on.

## Roster — 8 NPCs, 8 buildings, one shared deck

| Building | NPC (advisor) | Deck section |
|---|---|---|
| The Welcome Room | **Sam** | *(onboards, creates & shares deck, routes)* |
| The Founder's Loft | **Paul Graham** | Founder Story & Insight |
| The Case Study Room | **Ali Rowghani** | The Problem & Why Now |
| The Marketing Studio | **Garry Tan** | Positioning & Marketing |
| The Engineering Bay | **Diana Hu** | Technical Architecture & Scale |
| The War Room | **Michael Seibel** | Traction & North-Star Metric |
| The GTM Booth | **Dalton Caldwell** | Distribution & First 100 Users |
| The Proving Ground | **Brian Chesky** | Founder Grit & Why We Won't Quit |
| — | *(founder writes it)* | The Ask |

Changes vs. the original town: "cofounder" → **advisor**; Garry moves from
product/brand design to **positioning & marketing** (Brand Studio → **Marketing
Studio**); Bryan Johnson (wellness) → **Brian Chesky** (credible founder-grit /
"founder mode"); building relabelled Cold-Plunge → **The Proving Ground**.

## The living deck

- **Title (deterministic):** `My Startup Deck — <Session key>`. Every NPC
  computes the same title from the opaque per-visitor Session key in its prompt,
  so they all find the same doc. Never verbalized.
- **Template:** the existing hardcoded core-support template URL
  `https://docs.google.com/document/d/1PoJx2e0o1l2UPQHvjG7-Cx0mL_G2ga_RQd3qWqtSTNo/edit`.
  Sam clones it. **The template body must be updated by the town owner
  (core-support) to the new skeleton** (new section titles + placeholders for
  Garry/Marketing, Chesky/Proving Ground) — otherwise advisors' `replace_text`
  targets won't resolve. Full skeleton lives in `SETUP.md`.
- **Storage:** clones land in a `startups/` folder in the owner's Drive,
  `makePublic: true`, exactly as before.

## Sam — onboard → create deck → route

Sam keeps the name **Sam** and owns no section. Behavior:

1. **Explain the town in plain terms** (the visitor won't know how it works):
   *"You're here to build your startup deck. I'll set you up a living Google Doc;
   as you talk to each advisor around town they'll sharpen your thinking and
   write their part into it. By the end you'll have one comprehensive doc on
   every angle of your idea."*
2. **Deck waterfall:** `list_documents` for `My Startup Deck — <key>`; if found,
   reuse its URL; else `clone_document` (hardcoded template URL, that title,
   `folderName: "startups"`, `makePublic: true`).
3. **Share the URL** on its own line and set expectations (it fills in as they
   go). Sam has `list_documents` + `clone_document` only — never `replace_text`.
4. **Route:** ask what they're building and what they're stuck on (one question
   at a time), then name the single best-fit advisor + building + one-line why.
   Routing map (objective → advisor): story/insight → Paul Graham (Loft);
   problem/why-now/strategy → Ali (Case Study Room); positioning/marketing →
   Garry (Marketing Studio); tech/architecture/scaling → Diana (Engineering
   Bay); metrics/traction → Michael (War Room); distribution/first users →
   Dalton (GTM Booth); grit/resilience/staying power → Brian Chesky (Proving
   Ground).

## Every advisor

Each advisor MDX carries, in order:

1. **Persona** — authentic real-world bio/voice (from research).
2. **Goal stated up front** — *"I'm here to help you nail your <section> — the
   <X> part of your deck."* Clearly communicates what they refine.
3. **Deck gate** — `list_documents` for the deck. If **not found**: *"Head to
   Sam in the Welcome Room first; he sets up the deck we all write into. Come
   back with the link and we'll do your <section>."* Advisors cannot clone (no
   permission) and must not workshop the substance until the founder returns
   with a URL.
4. **Four beats** — the section's sub-questions (unchanged per advisor except
   Garry/Chesky, below).
5. **Office-hours method** — one question at a time; specificity is currency;
   push twice; take a position; name the failure pattern; escape hatch for
   impatience (give a verbal read, let them go — but only *write* to the doc
   when all four beats are genuinely answered); close with an assignment.
6. **Strict write gate + `replace_text`** — do not write until all four beats
   land concretely in the conversation; then `replace_text` on their exact
   placeholder. On a not-found/permission error, the deck is gone → send them
   back to Sam. One replacement per conversation; placeholder gone on revisit →
   done.
7. **Hand-off after the section is written** ("done" = the doc was updated). The
   post-write close names the **next advisor + building + section** in a fixed
   tour order and tells the founder they can **teleport there with ⌘K (Cmd+K)**
   — a real feature (`CommandBar.tsx` / `teleport.ts`). Tour order: Paul Graham
   → Ali Rowghani → Garry Tan → Diana Hu → Michael Seibel → Dalton Caldwell →
   Brian Chesky → (The Ask, self-written). Chesky closes by pointing at the Ask
   and noting ⌘K can jump back to any advisor to sharpen a thin section. Sam also
   mentions ⌘K when onboarding. Roaming stays free — the hand-off is a suggested
   next step, not a gate.

### Garry Tan — new section: Positioning & Marketing
Beats: **Positioning** (what it is / who it's for / what it replaces, one line)
· **The hook** (the one sentence that makes the right person lean in) · **The
one word** (what users call it back) · **Launch move** (the marketing set-piece
you lead with).

### Brian Chesky — new advisor: Founder Grit & Why We Won't Quit
Airbnb cofounder/CEO; "founder mode"; survived 2008 (Obama O's / ramen-profitable)
and the COVID collapse then IPO'd; "do things that don't scale" origin. Beats:
**Why you** (the load-bearing reason you'll still be at this in 10 years) ·
**Founder mode** (where you stay in the details instead of delegating the core)
· **The crucible** (the worst moment you've survived or expect, and why it won't
break you) · **Staying power** (what keeps you going when hype fades and
competitors burn out). As the last advisor, Chesky closes by pointing the
founder at **The Ask**, which they write themselves.

### `replaceText` format (unchanged mechanic)
Block content only, no code fences; blank line after the date; underscores
around the date (italic), double-asterisks around each beat label (bold):

```
_<Advisor Name>, YYYY-MM-DD_

**<Beat 1>.** <one to two sentences>
**<Beat 2>.** <one to two sentences>
**<Beat 3>.** <one to two sentences>
**<Beat 4>.** <one to two sentences>
```

## Permissions

- **Sam:** `core.memory_search` + google-docs `list_documents`,
  `clone_document`.
- **Seven advisors:** `core.memory_search` + google-docs `list_documents`,
  `replace_text` (no clone — a bug can't spawn duplicate decks).

## Town description (first-load welcome pitch)

`town.json` `description`:

> Welcome to AI Startup Town — build a real startup deck with seven advisors
> modeled on the people who've coached thousands of founders. Start at the
> Welcome Room: Sam sets up your living deck and points you to the right
> advisor. Every conversation writes another section.

## File changes

- Rewrite 8 × `towns/ai-startup-town/npcs/*.mdx` — re-add google-docs perms and
  deck mechanics; `welcome.mdx` = Sam (onboard/create/route); `brand.mdx` =
  Garry/Marketing; **add** `grit.mdx` = Brian Chesky.
- `town.json`: re-add the Proving Ground building (`id: "grit"`, `plotKey:
  "gym"`, `variantId: "gym.the-iron-room"`, label "The Proving Ground"); keep
  "The Marketing Studio"; update `description`.
- Rewrite `SETUP.md`: living-deck model, new doc title, new skeleton +
  placeholders, note that core-support must update the template body and that
  the flow needs no visitor-side integration.

## Deploy & test

1. Redeploy to local `:3003`: `town deploy --dir towns/ai-startup-town --slug
   ai-startup-town`.
2. Confirm 8 NPCs / 8 buildings; Chesky/Proving Ground present; Marketing Studio
   label.
3. Prompt-behavior smoke test via `town test npc`: Sam explains + (attempts)
   clone + routes; an advisor states its goal, gates on the deck when absent,
   and runs office hours.
4. **Runtime caveat:** the actual doc create/write executes under core-support's
   integration on the deployed town (prod). Locally the town owner differs, so
   the real `clone_document`/`replace_text` calls may not resolve — local tests
   cover prompt behavior; the live deck-write is validated on the core-support
   deployment once the template body is updated.
