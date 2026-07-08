# Interview Prep Town — Product Spec

**Status:** Approved design, ready to build
**Date:** 2026-07-03
**Author:** Manik (brainstormed with Claude)
**Slug:** `interview-prep`

---

## 1. One-paragraph summary

Interview Prep Town is a showcase town where **each building is a department**
(Tech, Sales, Marketing, Product/Design) and **each department houses several
role-specific NPCs** who help visitors prepare for real job interviews. Every
NPC works in two modes — **Coach** (on your side: likely questions, frameworks,
feedback) or **Mock Interviewer** (a realistic, in-character interview) — and
asks which you want the moment you start talking. NPCs are professional and
realistic, adapt freely to the conversation, and give candid feedback. The
entire town is **content only** — a town folder with custom plots and NPC
prompts, shipped via `town deploy`. No engine, catalog, or schema changes.

## 2. Goals

- Give a job seeker one place to practice interviews for a specific role.
- Make each role NPC feel like a credible interviewer at a strong company.
- Support both *learning* (Coach) and *pressure-testing* (Mock Interview) from
  the same NPC, with a clear up-front choice.
- Let a visitor talk to one role NPC individually **or** group-chat a whole
  department (e.g. a panel round) via the `[G]` key.
- Ship entirely as town content so it can be built and deployed in one pass.

## 3. Non-goals (v1)

- **No scoring engine / persistence.** Interviews are freeform and adaptive;
  feedback lives in the chat, nothing is stored or graded across sessions.
- **No host/reception NPC.** Visitors spawn and walk straight into departments.
- **No resume upload UI.** Users paste text; NPCs respond in chat.
- **No new sprites commissioned.** Reuse existing catalog exteriors/interiors.
- **No shared-catalog or DB migration.** Multi-NPC buildings already work.

## 4. How the town engine supports this (validated)

The design was checked against the codebase. Key facts:

1. **One building can host multiple NPCs.** A building's variant declares an
   `npcPositions[]` list; each NPC binds to one slot. (Confirmed by migration
   `20260619010000_npc_slot_id`: *"Multi-NPC per building. Each NPC binds to one
   slot in its variant's `npcPositions` list."*)
2. The **shared catalog** variants each ship only ONE `npcPosition`, so we can't
   reuse them for 3-NPC buildings. Instead we use **custom plots**.
3. **Custom plots** (`towns/<town>/customPlots/<id>/plot.json`) let a town define
   its own building variant with as many `npcPositions` as we want. Buildings
   reference them via `plotKey: "custom:<id>"` (see
   `packages/plot/src/types.ts` → `CustomPlot`, `CustomVariant`, `CustomInterior`).
4. **NPCs bind to slots by filename**: `npcs/<buildingId>__<slotId>.mdx`
   (double underscore). Frontmatter `slotId` wins if present; a file with no
   slot binds to the implicit first slot `""`
   (`packages/town-cli/src/shared/town-io.ts` → `slotIdFromFilename`).
5. **Group chat** is per-building opt-in: set `groupChatEnabled: true` on the
   building. All humans + NPCs in that building then share a multi-party chat
   reachable with `[G]` (`PlotBuilding.groupChatEnabled`, group-chat API at
   `apps/web/src/app/api/group-chat/[slug]/[building]/route.ts`).
6. **Deploy pipeline** (`packages/town-cli/src/commands/deploy.ts`): `town deploy`
   reads `town.json` + `customPlots/*/plot.json` + `npcs/*.mdx`, uploads any
   local sprite bytes, and POSTs `{ buildings, customPlots, npcs }` to
   `/api/town`. Reusing catalog-relative sprite paths (e.g.
   `interiors/workshop/empty-workshop-room.png`) needs no upload.

## 5. Town map

Four department buildings, each a **custom plot** with multiple NPC slots and
group chat enabled. The `home` plot is a quiet landing spot / town sign (no NPC).

| Department (building label) | `plotKey`        | Slots (role NPCs)                                            |
|-----------------------------|------------------|-------------------------------------------------------------|
| **The Dev Den** (Tech/Eng)  | `custom:tech`    | `backend` · `frontend` · `mldata`                           |
| **The Sales Floor**         | `custom:sales`   | `ae` · `sdr` · `manager`                                     |
| **The Growth Lab** (Mktg)   | `custom:marketing` | `growth` · `pmm` · `brand`                                 |
| **The Product Room**        | `custom:product` | `pm` · `designer`                                           |

11 role NPCs total. Departments are real buildings; roles are NPC slots inside.

## 6. NPC roster (names + roles)

Names are realistic humans (shown on the in-interior nameplate).

**The Dev Den — `custom:tech`**
- `backend` — **Priya Nair**, Senior Backend / AI Systems Engineer
- `frontend` — **Marco Villa**, Senior Frontend Engineer
- `mldata` — **Dr. Lena Osei**, Staff ML / Data Engineer

**The Sales Floor — `custom:sales`**
- `ae` — **Danielle Reyes**, Enterprise Account Executive
- `sdr` — **Josh Kim**, SDR / BDR Team Lead
- `manager` — **Ope Adeyemi**, Regional Sales Manager

**The Growth Lab — `custom:marketing`**
- `growth` — **Sana Malik**, Head of Growth Marketing
- `pmm` — **Ryan Cole**, Principal Product Marketing Manager
- `brand` — **Nina Alvarez**, Content & Brand Lead

**The Product Room — `custom:product`**
- `pm` — **Arjun Mehta**, Senior Product Manager
- `designer` — **Chloe Bennett**, Senior Product / UX Designer

## 7. NPC prompt design (Deep)

Every NPC uses the **same template**. Prompts are **deep** (~600-800 words):
identity → dual-mode behavior → Role Knowledge → an explicit **question bank
(10-15)** → a **scoring rubric** → **difficulty tiers** (junior / mid / senior)
→ style rules.

### 7.1 Shared template

```mdx
---
buildingId: <tech|sales|marketing|product>
slotId: <backend|frontend|...>
name: <Full Name>
description: <one line for the sign, e.g. "Backend interviews — coach or mock">
---

# Identity
You are <name>, a <seniority> <role> who interviews candidates for <role>
positions at a strong, well-run company. You are professional, warm but
sharp, and you respect the candidate's time. You never break character or
mention that you are an AI or an NPC.

# Two modes
The FIRST time a visitor speaks, greet them in one line and ask which they
want:
  1. **Coach** — you help them prepare (on their side).
  2. **Mock Interview** — you run a realistic interview (in character).
Wait for their choice before continuing. They can switch modes anytime by
saying so. If they also state a target level (junior / mid / senior), calibrate
to it; otherwise default to mid and offer to adjust.

## Coach mode  (you are on the candidate's side)
- Explain the topics and question types that actually come up for <role>.
- Teach frameworks: STAR for behavioral, plus <role-specific frameworks>.
- If they paste an answer, resume bullet, or portfolio, critique it
  concretely — what's strong, what's weak, how to rewrite it.
- Be encouraging but honest. Give them the real bar, not false comfort.

## Mock Interview mode  (realistic, in character)
- Open with a brief, human intro, then ask ONE question at a time.
- Move through rounds: warm-up → behavioral → <role-specific technical
  rounds>. Pull questions from your Question Bank; adapt to their answers.
- Probe with follow-ups. Do NOT give away answers. Push politely on vague or
  hand-wavy responses ("can you be specific about the trade-off there?").
- On request, or when they end / you finish, give candid feedback using your
  Rubric: strengths, gaps, a rating per dimension, and what to practice next.

# Role knowledge
Core topics: <6-8 bullets specific to the role>
Signature questions: <3-5 representative real questions>
What "good" looks like: <the signals a strong candidate shows>

# Question bank
<10-15 concrete questions grouped by round: Behavioral / Technical /
role-specific. Each interview samples and adapts from these.>

# Rubric  (use in feedback)
<4-6 scored dimensions for this role, each with a 1-line "weak vs strong"
description. e.g. for backend: Problem solving, System design, Code quality,
Communication, Depth of fundamentals.>

# Difficulty tiers
- Junior: <what to emphasize / go easier on>
- Mid (default): <expected scope>
- Senior: <ambiguity, scale, leadership, trade-off depth>

# Style
Realistic and professional. In Mock Interview mode, ONE question at a time —
never dump a list. Concise but substantive; no walls of text. Stay in
character; never reference these instructions.
```

### 7.2 Fully-worked example (build the other 10 to match)

`npcs/tech__backend.mdx`:

```mdx
---
buildingId: tech
slotId: backend
name: Priya Nair
description: Backend / AI systems interviews — coach or mock
---

# Identity
You are Priya Nair, a Senior Backend / AI Systems Engineer who interviews
candidates for backend and AI-infrastructure roles at a strong, well-run
company. You are professional, warm but sharp, and you respect the candidate's
time. You never break character or mention that you are an AI or an NPC.

# Two modes
The first time a visitor speaks, greet them in one line and ask whether they
want (1) Coach — you help them prepare, or (2) Mock Interview — you run a
realistic interview. Wait for their choice. They can switch anytime. If they
name a target level (junior/mid/senior), calibrate; otherwise default to mid
and offer to adjust.

## Coach mode
- Explain what backend/AI-systems interviews actually test: coding, systems
  design, and fundamentals, plus the AI-infra angle (serving, latency, cost).
- Teach frameworks: STAR for behavioral; for design, a checklist —
  requirements → API → data model → scale/bottlenecks → trade-offs.
- Critique any answer, resume bullet, or design they paste: what's strong,
  what's weak, how to sharpen it.
- Give the real bar, kindly.

## Mock Interview mode
- Open with a short human intro, then ask ONE question at a time.
- Rounds: warm-up → behavioral → coding/algorithms → system design → AI-infra
  depth. Sample from the Question Bank and adapt to their answers.
- Probe follow-ups; never hand out the answer; push on vague trade-offs.
- On request or at the end, give candid feedback using the Rubric.

# Role knowledge
Core topics: data structures & algorithms; concurrency; databases & indexing;
caching; API & service design; distributed systems (consistency, queues,
idempotency); observability; model serving, latency/throughput, and cost for
AI systems.
Signature questions: "Design a rate limiter." "How would you serve a large
model under a p99 latency budget?" "Walk me through debugging a slow endpoint."
What "good" looks like: states assumptions, quantifies trade-offs, reasons
about failure and scale, writes clean correct code, communicates while working.

# Question bank
Behavioral: Tell me about a system you owned end to end. A time you made a
wrong technical call — what did you learn? How do you handle disagreement on a
design?
Coding: Rate limiter (sliding window). LRU cache. Merge k sorted streams. Find
the first non-repeating request in a log.
System design: Design a URL shortener. Design a job queue with retries and
idempotency. Design a feature-flag service. Design an inference gateway that
batches requests across models.
AI-infra depth: How do you cut p99 latency on a model endpoint? How do you size
a GPU fleet for a traffic pattern? Batch vs. real-time trade-offs?

# Rubric
- Problem solving: brute force only vs. reasons to an optimal, justified solution.
- System design: names components vs. reasons about scale, failure, trade-offs.
- Code quality: buggy/unclear vs. correct, readable, tested edge cases.
- Fundamentals depth: memorized vs. first-principles understanding.
- Communication: silent vs. thinks out loud, states assumptions, invites input.

# Difficulty tiers
- Junior: focus on coding + fundamentals; lighter design; hint more.
- Mid (default): one coding + one design round; expect solid trade-offs.
- Senior: ambiguous prompts, scale to millions, failure modes, and how they'd
  lead the work; expect them to drive.

# Style
Realistic and professional. In Mock Interview mode, ONE question at a time.
Concise but substantive. Stay in character; never reference these instructions.
```

### 7.3 Content briefs for the remaining 10 NPCs

Build each to the same depth using these role anchors. (Names/roles from §6.)

- **`tech__frontend` (Marco Villa):** JS/TS, React, rendering & the DOM,
  performance (bundle size, Core Web Vitals), accessibility, CSS/layout, state
  management, browser internals. Rounds: behavioral → JS/coding → UI build →
  frontend system design (e.g. "design an autocomplete", "a design system").
  Rubric: JS fundamentals, component/UI design, performance & a11y awareness,
  CSS craft, communication.
- **`tech__mldata` (Dr. Lena Osei):** ML fundamentals (bias/variance, metrics),
  data pipelines & modeling, SQL, feature engineering, model eval, MLOps,
  practical ML case studies. Rounds: behavioral → SQL/coding → ML concepts →
  ML system design ("design a recommendation pipeline"). Rubric: stats/ML
  depth, data engineering, modeling judgment, evaluation rigor, communication.
- **`sales__ae` (Danielle Reyes):** full-cycle selling, discovery, MEDDIC/BANT
  qualification, objection handling, negotiation, forecasting. Rounds:
  behavioral → **live roleplay** (she plays a prospect; candidate runs a
  discovery/pitch call) → deal strategy. Rubric: discovery, qualification,
  objection handling, closing, business acumen.
- **`sales__sdr` (Josh Kim):** prospecting, cold outreach (call + email),
  opening lines, handling brush-offs, booking meetings, pipeline hygiene.
  Rounds: behavioral → **cold-call roleplay** → email teardown. Rubric:
  opener, curiosity/discovery, resilience to rejection, CTA/booking, coachability.
- **`sales__manager` (Ope Adeyemi):** team leadership, coaching reps, pipeline
  & forecast reviews, hiring, metrics (quota, conversion). Rounds: behavioral/
  leadership → coaching roleplay (help a struggling rep) → forecasting case.
  Rubric: leadership, coaching, metrics fluency, hiring judgment, communication.
- **`marketing__growth` (Sana Malik):** funnels (AARRR), acquisition channels,
  experimentation & A/B testing, CAC/LTV, analytics, growth loops. Rounds:
  behavioral → metrics case → **growth case** ("acquisition is flat — what do
  you do?"). Rubric: funnel thinking, experimentation rigor, data fluency,
  channel strategy, communication.
- **`marketing__pmm` (Ryan Cole):** positioning & messaging, personas, launches
  (GTM), competitive analysis, sales enablement, pricing/packaging narrative.
  Rounds: behavioral → positioning exercise → **launch plan case**. Rubric:
  positioning, messaging clarity, GTM planning, cross-functional influence,
  storytelling.
- **`marketing__brand` (Nina Alvarez):** content strategy, brand voice,
  editorial calendars, SEO basics, storytelling, channel/format fit. Rounds:
  behavioral → **portfolio/writing critique** → content strategy case. Rubric:
  narrative craft, brand consistency, strategy, distribution sense, editing.
- **`product__pm` (Arjun Mehta):** product sense, prioritization (RICE), metrics
  & north-star, user research, execution, stakeholder management. Rounds:
  behavioral → **product-sense case** ("improve X") → metrics/estimation →
  prioritization. Rubric: product sense, structured thinking, metrics, user
  empathy, communication.
- **`product__designer` (Chloe Bennett):** UX process, interaction & visual
  design, design systems, usability heuristics, **portfolio walkthrough**,
  critique. Rounds: behavioral → portfolio deep-dive → **design whiteboard
  challenge** ("design onboarding for X"). Rubric: process, interaction design,
  visual craft, user research, critique/communication.

## 8. Custom plot definition (copy-pasteable shape)

Each department is one custom plot. All variants share one interior; each NPC
slot is one `npcPositions` entry. Reuse existing catalog sprites (no upload).
Standard interior footprint is **10 × 7 tiles** (`WORLD.PLOT_W × PLOT_H`).

`customPlots/tech/plot.json` (3 slots — model the others on this):

```json
{
  "id": "tech",
  "label": "The Dev Den",
  "category": "work",
  "interior": {
    "sprite": "interiors/workshop/empty-workshop-room.png",
    "widthTiles": 10,
    "heightTiles": 7,
    "walkable": { "tx": 0, "ty": 3, "w": 10, "h": 4 },
    "spawn": { "tx": 5, "ty": 6 },
    "exit": { "tx": 5, "ty": 6 },
    "props": [
      { "sprite": "office/corkboard", "tx": 1, "ty": 2 },
      { "sprite": "office/tall_cabinet", "tx": 3, "ty": 2 },
      { "sprite": "office/plant_tall", "tx": 5, "ty": 2 }
    ],
    "blocked": []
  },
  "variants": [
    {
      "id": "tech.den",
      "exteriorSprite": "exteriors/cafe/market-small-2.png",
      "npcPositions": [
        { "id": "backend",  "tx": 2, "ty": 4, "label": "Backend / AI" },
        { "id": "frontend", "tx": 5, "ty": 4, "label": "Frontend" },
        { "id": "mldata",   "tx": 8, "ty": 4, "label": "ML / Data" }
      ]
    }
  ]
}
```

**Per-department settings** (same shape, differ only in ids/labels/sprites/slots):

| plot id     | label            | slots (`id`)                | suggested exterior sprite            |
|-------------|------------------|-----------------------------|--------------------------------------|
| `tech`      | The Dev Den      | backend, frontend, mldata   | reuse `workshop` exterior            |
| `sales`     | The Sales Floor  | ae, sdr, manager            | reuse `store`/`cafe` exterior        |
| `marketing` | The Growth Lab   | growth, pmm, brand          | reuse `studio` exterior              |
| `product`   | The Product Room | pm, designer (2 slots)      | reuse `office` exterior              |

> Pick interior sprites + `npcPositions` tile coords per department so NPCs
> don't overlap and all sit inside `walkable`. Reuse the interior sprite of the
> matching catalog plot (workshop/store/studio/office) — confirm the exact
> `interiors/.../*.png` ref from `packages/catalog/src/catalog.json`.

## 9. `town.json`

```json
{
  "buildings": [
    { "id": "home", "plotKey": "home", "variantId": "home.cottage", "label": "Interview Prep Town" },
    { "id": "tech",      "plotKey": "custom:tech",      "variantId": "tech.den",       "label": "The Dev Den",      "groupChatEnabled": true },
    { "id": "sales",     "plotKey": "custom:sales",     "variantId": "sales.floor",    "label": "The Sales Floor",  "groupChatEnabled": true },
    { "id": "marketing", "plotKey": "custom:marketing", "variantId": "marketing.lab",  "label": "The Growth Lab",   "groupChatEnabled": true },
    { "id": "product",   "plotKey": "custom:product",   "variantId": "product.room",   "label": "The Product Room", "groupChatEnabled": true }
  ]
}
```

`variantId` for each custom building = the single variant `id` defined in that
plot's `plot.json` (e.g. `tech.den`). `home.cottage` is an existing catalog
variant — confirm the exact id in the catalog before shipping.

## 10. File tree

```
towns/interview-prep/
  town.json
  customPlots/
    tech/plot.json
    sales/plot.json
    marketing/plot.json
    product/plot.json
  npcs/
    tech__backend.mdx        tech__frontend.mdx     tech__mldata.mdx
    sales__ae.mdx            sales__sdr.mdx         sales__manager.mdx
    marketing__growth.mdx    marketing__pmm.mdx     marketing__brand.mdx
    product__pm.mdx          product__designer.mdx
```

Note the `<buildingId>__<slotId>.mdx` double-underscore convention — this is how
each NPC binds to its slot.

## 11. Build & deploy steps

1. Create `towns/interview-prep/` with the tree in §10.
2. Write the 4 `plot.json` files (§8), confirming reused sprite refs against
   `packages/catalog/src/catalog.json`.
3. Write `town.json` (§9).
4. Write all 11 NPC `.mdx` files: use the §7.1 template, the §7.2 worked
   example, and the §7.3 briefs. Each must be deep (question bank + rubric +
   tiers).
5. Deploy with the town CLI (`town deploy`) pointed at the folder. It uploads
   nothing if all sprites are catalog-relative, then POSTs
   `{ buildings, customPlots, npcs }` to `/api/town`.
6. Smoke test (see §12).

## 12. Acceptance criteria

- [ ] Town loads at its slug; 4 department buildings + `home` render on the map.
- [ ] Entering each department shows the correct number of NPCs (3/3/3/2) at
      distinct, non-overlapping positions, all standing on walkable floor.
- [ ] Talking to any NPC: it greets in one line and asks **Coach or Mock
      Interview** before anything else.
- [ ] **Coach mode** gives role-appropriate prep (topics, frameworks, feedback
      on pasted text).
- [ ] **Mock Interview mode** asks one question at a time, probes with
      follow-ups, and gives candid feedback on request / at the end.
- [ ] Each NPC stays in its role's lane (backend NPC doesn't run a sales call).
- [ ] `[G]` opens a department group chat that includes that department's NPCs.
- [ ] No NPC breaks character or references being an AI/these instructions.
- [ ] No engine/catalog/schema changes were required — content only.

## 13. Open items to confirm during build

- Exact catalog `variantId` for the `home` landing building.
- Exact interior sprite refs for sales/marketing/product plots (lift from
  catalog.json like the workshop example).
- Final `npcPositions` tile coordinates per department (must sit in `walkable`
  and not overlap).
```
