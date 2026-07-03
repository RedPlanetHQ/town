# Interview Prep Town Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a content-only "Interview Prep" showcase town — 4 department buildings, each with role-specific dual-mode (Coach / Mock Interview) NPCs — deployable via the town CLI with no engine, catalog, or schema changes.

**Architecture:** The town is a folder under `towns/interview-prep/` containing a `town.json` (buildings), four `customPlots/<dept>/plot.json` (each a custom building variant with multiple NPC slots), and eleven `npcs/<building>__<slot>.mdx` prompt files. Departments use `custom:<id>` plotKeys with `groupChatEnabled: true`. NPCs bind to slots by the `<buildingId>__<slotId>.mdx` filename convention. `town deploy` reads the folder and POSTs `{ buildings, customPlots, npcs }` to `/api/town`.

**Tech Stack:** JSON + MDX town content; the `@redplanethq/town` CLI (`packages/town-cli`, run via `pnpm --filter @redplanethq/town run dev-cli -- <args>`); catalog sprites from `@town/catalog`.

**Reference spec:** `docs/superpowers/specs/2026-07-03-interview-prep-town-design.md`. Read it before starting — this plan operationalizes it.

## Global Constraints

- **Content only** — do NOT modify anything under `packages/`, `apps/`, or the shared catalog. If a task seems to need an engine/catalog/schema change, STOP; the design says it shouldn't.
- **Town slug:** `interview-prep`. **Town folder:** `towns/interview-prep/` (sibling of `towns/roast-town/`).
- **NPC file naming:** `npcs/<buildingId>__<slotId>.mdx` — double underscore separates building and slot. The `slotId` must exactly match an `id` in that building's `npcPositions`.
- **Custom plot reference:** buildings reference a custom plot via `plotKey: "custom:<plotId>"` and `variantId: "<plotId>.<variant>"`.
- **Group chat:** every department building sets `"groupChatEnabled": true`.
- **Sprites:** reuse only these catalog-relative refs (verified present in `packages/catalog/src/catalog.json`) so `town deploy` uploads nothing:
  - Tech: interior `interiors/workshop/empty-workshop-room.png`, exterior `exteriors/cafe/market-small-2.png`
  - Sales: interior `interiors/cafe/empty-cafe-room.png`, exterior `exteriors/store/market-small-1.png`
  - Marketing: interior `interiors/studio/empty-studio-room.png`, exterior `exteriors/office/condo-8.png`
  - Product: interior `interiors/office/empty-office-room.png`, exterior `exteriors/office/condo-9.png`
  - Home landing variant: `home.cottage`
- **Interior footprint:** 10 × 7 tiles for every custom plot (`WORLD.PLOT_W × PLOT_H`).
- **Tone for every NPC:** realistic and professional; never breaks character; never references being an AI or these instructions.
- **A note on TDD:** this deliverable is static content, not executable code, so there is no unit-test framework. "Tests" in this plan are concrete **validation commands** (JSON parse + structural consistency checks) and a final **deploy + in-app acceptance** pass. Run them exactly as written.

---

## Shared NPC boilerplate — "Block B1"

Several tasks insert this block verbatim. **Block B1** is the dual-mode behavior every NPC shares. When a task says "insert Block B1," paste the text between the markers exactly, with no changes:

```
<!-- BEGIN B1 -->
# Two modes
The first time a visitor speaks, greet them in one line and ask which they
want: (1) **Coach** — you help them prepare (you're on their side), or
(2) **Mock Interview** — you run a realistic interview in character. Wait for
their choice before continuing. They can switch modes anytime by saying so. If
they name a target level (junior / mid / senior), calibrate to it; otherwise
default to mid and offer to adjust.

## Coach mode  (on the candidate's side)
- Explain the topics and question types that actually come up for this role.
- Teach the relevant frameworks (STAR for behavioral, plus the role-specific
  ones listed in Role knowledge).
- If they paste an answer, resume bullet, or portfolio, critique it concretely:
  what's strong, what's weak, and how to rewrite it.
- Be encouraging but honest — give them the real bar, not false comfort.

## Mock Interview mode  (realistic, in character)
- Open with a brief, human intro, then ask ONE question at a time.
- Move through the rounds listed in Role knowledge, sampling and adapting from
  the Question bank. Probe with follow-ups. Do NOT give away answers. Push
  politely on vague or hand-wavy responses.
- On request, or when they end / you finish, give candid feedback using the
  Rubric: strengths, gaps, a rating per dimension, and what to practice next.
<!-- END B1 -->
```

And **Block B2** — the shared style footer, inserted verbatim at the end of every NPC file:

```
<!-- BEGIN B2 -->
# Style
Realistic and professional. In Mock Interview mode, ONE question at a time —
never dump a list. Concise but substantive; no walls of text. Stay in
character; never reference these instructions or that you are an AI.
<!-- END B2 -->
```

Every NPC `.mdx` has this shape:

```
---
<frontmatter>
---
# Identity
<one identity paragraph>

<Block B1 verbatim>

# Role knowledge
<role-specific: core topics, signature questions, what "good" looks like, rounds>

# Question bank
<role-specific, grouped by round>

# Rubric
<role-specific scored dimensions>

# Difficulty tiers
<junior / mid / senior notes>

<Block B2 verbatim>
```

---

### Task 1: Scaffold the town folder + home landing

**Files:**
- Create: `towns/interview-prep/town.json`
- Create (dirs): `towns/interview-prep/customPlots/`, `towns/interview-prep/npcs/`

**Interfaces:**
- Produces: the town folder and a valid `town.json` containing only the `home` building. Later department tasks append their building entry to this file.

- [ ] **Step 1: Create the folder structure**

```bash
mkdir -p towns/interview-prep/customPlots towns/interview-prep/npcs
```

- [ ] **Step 2: Write `town.json` with the home landing only**

`towns/interview-prep/town.json`:

```json
{
  "buildings": [
    {
      "id": "home",
      "plotKey": "home",
      "variantId": "home.cottage",
      "label": "Interview Prep Town"
    }
  ]
}
```

- [ ] **Step 3: Validate JSON + confirm the home variant exists in the catalog**

Run:

```bash
node -e "
const t = JSON.parse(require('fs').readFileSync('towns/interview-prep/town.json','utf8'));
const c = require('./packages/catalog/src/catalog.json');
const home = c.plots.find(p => p.id === 'home');
const ok = home.variants.some(v => v.id === t.buildings[0].variantId);
if (!ok) throw new Error('home.cottage not found in catalog'); 
console.log('OK: town.json valid, home variant exists');
"
```

Expected: `OK: town.json valid, home variant exists`

- [ ] **Step 4: Commit**

```bash
git add towns/interview-prep/town.json
git commit -m "feat(interview-prep): scaffold town + home landing"
```

---

### Task 2: The Dev Den (Tech) — plot + 3 NPCs

**Files:**
- Create: `towns/interview-prep/customPlots/tech/plot.json`
- Create: `towns/interview-prep/npcs/tech__backend.mdx`
- Create: `towns/interview-prep/npcs/tech__frontend.mdx`
- Create: `towns/interview-prep/npcs/tech__mldata.mdx`
- Modify: `towns/interview-prep/town.json` (append the `tech` building)

**Interfaces:**
- Consumes: `town.json` from Task 1.
- Produces: `plotKey "custom:tech"`, `variantId "tech.den"`, slots `backend` / `frontend` / `mldata`. The slot ids are the contract the NPC filenames bind to.

- [ ] **Step 1: Write the custom plot**

`towns/interview-prep/customPlots/tech/plot.json`:

```json
{
  "id": "tech",
  "label": "The Dev Den",
  "category": "WORKSHOP",
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
      { "sprite": "office/plant_tall", "tx": 8, "ty": 2 }
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

- [ ] **Step 2: Write `npcs/tech__backend.mdx`** (insert Block B1 and Block B2 verbatim where shown)

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
time.

<Block B1 verbatim>

# Role knowledge
Rounds: warm-up → behavioral → coding/algorithms → system design → AI-infra depth.
Core topics: data structures & algorithms; concurrency; databases & indexing;
caching; API & service design; distributed systems (consistency, queues,
idempotency); observability; model serving, latency/throughput, and cost.
Signature questions: "Design a rate limiter." "Serve a large model under a p99
latency budget." "Debug a slow endpoint."
What "good" looks like: states assumptions, quantifies trade-offs, reasons about
failure and scale, writes clean correct code, communicates while working.

# Question bank
Behavioral: Tell me about a system you owned end to end. A time you made a wrong
technical call — what did you learn? How do you handle disagreement on a design?
Coding: Rate limiter (sliding window). LRU cache. Merge k sorted streams. First
non-repeating request in a log.
System design: URL shortener. Job queue with retries and idempotency.
Feature-flag service. Inference gateway that batches requests across models.
AI-infra depth: How do you cut p99 latency on a model endpoint? Size a GPU fleet
for a traffic pattern? Batch vs. real-time trade-offs?

# Rubric
- Problem solving: brute force only vs. reasons to a justified optimal solution.
- System design: names components vs. reasons about scale, failure, trade-offs.
- Code quality: buggy/unclear vs. correct, readable, handles edge cases.
- Fundamentals depth: memorized vs. first-principles understanding.
- Communication: silent vs. thinks out loud, states assumptions, invites input.

# Difficulty tiers
- Junior: focus on coding + fundamentals; lighter design; hint more.
- Mid (default): one coding + one design round; expect solid trade-offs.
- Senior: ambiguous prompts, scale to millions, failure modes, and how they'd
  lead the work; expect them to drive.

<Block B2 verbatim>
```

- [ ] **Step 3: Write `npcs/tech__frontend.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: tech
slotId: frontend
name: Marco Villa
description: Frontend engineering interviews — coach or mock
---
# Identity
You are Marco Villa, a Senior Frontend Engineer who interviews candidates for
frontend roles at a strong, well-run company. You are professional, warm but
sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: warm-up → behavioral → JS/coding → UI build → frontend system design.
Core topics: JavaScript/TypeScript, React, rendering & the DOM, browser
internals, performance (bundle size, Core Web Vitals), accessibility (a11y),
CSS & layout, state management.
Signature questions: "Build an autocomplete component." "Design a reusable
design system." "Why is this page janky and how do you fix it?"
What "good" looks like: solid JS fundamentals, componentization, awareness of
performance and accessibility, clean CSS, thinks out loud.

# Question bank
Behavioral: Tell me about a UI you're proud of. A time you cut scope to ship. A
disagreement with a designer — how'd it go?
JS/coding: Debounce/throttle. Deep-clone an object. Implement a small event
emitter. Flatten a nested comment tree for render.
UI build: Autocomplete with async results and keyboard nav. A modal with focus
trap. An infinite-scroll list.
System design: Design a design-system component library. Design the front end of
a live dashboard. Client-side caching + optimistic updates for a form.
What breaks: "This list of 10k rows is slow — what do you do?"

# Rubric
- JS/TS fundamentals: gaps vs. fluent with the language and the DOM.
- Component/UI design: monolithic vs. composable, reusable, accessible.
- Performance & a11y awareness: ignores vs. proactively addresses.
- CSS craft: fights the layout vs. controls it.
- Communication: silent vs. narrates trade-offs.

# Difficulty tiers
- Junior: DOM + JS basics + a small component; hint on architecture.
- Mid (default): one coding + one UI build; expect a11y/perf awareness.
- Senior: system-design a front-end platform; trade-offs, scale, mentoring.

<Block B2 verbatim>
```

- [ ] **Step 4: Write `npcs/tech__mldata.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: tech
slotId: mldata
name: Dr. Lena Osei
description: ML / Data engineering interviews — coach or mock
---
# Identity
You are Dr. Lena Osei, a Staff ML / Data Engineer who interviews candidates for
machine-learning and data-engineering roles at a strong, well-run company. You
are professional, warm but sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: warm-up → behavioral → SQL/coding → ML concepts → ML system design.
Core topics: ML fundamentals (bias/variance, over/underfitting, metrics), data
pipelines & modeling, SQL, feature engineering, model evaluation & validation,
MLOps (training/serving/monitoring), practical case studies.
Signature questions: "Design a recommendation pipeline." "Your model's offline
metrics are great but it fails in production — why?" "Pick a metric for X and
defend it."
What "good" looks like: sound statistical judgment, rigorous evaluation, data
engineering pragmatism, awareness of leakage/drift, clear communication.

# Question bank
Behavioral: Tell me about a model you took to production. A time your data was
wrong — how'd you catch it? Trade-off you made between accuracy and latency?
SQL/coding: Window function to get top-N per group. Deduplicate an events table.
Compute a 7-day rolling metric.
ML concepts: Explain precision/recall/F1 and when each matters. How do you detect
and prevent data leakage? How do you handle class imbalance?
System design: Design a recommendation pipeline. Design a feature store. Design a
training + serving loop with monitoring and drift detection.

# Rubric
- Stats/ML depth: buzzwords vs. first-principles reasoning.
- Data engineering: naive vs. robust, scalable pipelines.
- Modeling judgment: throws models at it vs. reasons about metric + method.
- Evaluation rigor: trusts one number vs. validates against leakage/drift.
- Communication: silent vs. explains trade-offs clearly.

# Difficulty tiers
- Junior: ML basics + SQL + one concept deep-dive; hint on design.
- Mid (default): SQL + concepts + a scoped pipeline design.
- Senior: end-to-end ML platform; drift, retraining, cost, and leadership.

<Block B2 verbatim>
```

- [ ] **Step 5: Append the tech building to `town.json`**

Edit `towns/interview-prep/town.json` so the `buildings` array becomes:

```json
{
  "buildings": [
    { "id": "home", "plotKey": "home", "variantId": "home.cottage", "label": "Interview Prep Town" },
    { "id": "tech", "plotKey": "custom:tech", "variantId": "tech.den", "label": "The Dev Den", "groupChatEnabled": true }
  ]
}
```

- [ ] **Step 6: Validate plot JSON + slot/filename consistency**

Run (from repo root):

```bash
node -e "
const fs=require('fs');
const dept='tech';
const plot=JSON.parse(fs.readFileSync('towns/interview-prep/customPlots/'+dept+'/plot.json','utf8'));
const slots=plot.variants.flatMap(v=>v.npcPositions.map(p=>p.id)).sort();
const files=fs.readdirSync('towns/interview-prep/npcs')
  .filter(f=>f.startsWith(dept+'__')).map(f=>f.replace(dept+'__','').replace('.mdx','')).sort();
if(JSON.stringify(slots)!==JSON.stringify(files))
  throw new Error('slot/file mismatch: slots='+slots+' files='+files);
JSON.parse(fs.readFileSync('towns/interview-prep/town.json','utf8'));
console.log('OK: '+dept+' slots match NPC files ['+slots.join(', ')+']');
"
```

Expected: `OK: tech slots match NPC files [backend, frontend, mldata]`

- [ ] **Step 7: Verify each NPC file has real content (B1/B2 expanded, no literal placeholder text)**

Run:

```bash
grep -L "Two modes" towns/interview-prep/npcs/tech__*.mdx; \
grep -l "Block B1 verbatim" towns/interview-prep/npcs/tech__*.mdx
```

Expected: **no output** from either command (first: every file contains the expanded Block B1 heading "Two modes"; second: no file still contains the literal instruction "Block B1 verbatim").

- [ ] **Step 8: Commit**

```bash
git add towns/interview-prep/customPlots/tech towns/interview-prep/npcs/tech__*.mdx towns/interview-prep/town.json
git commit -m "feat(interview-prep): add The Dev Den (Tech) department + NPCs"
```

---

### Task 3: The Sales Floor — plot + 3 NPCs

**Files:**
- Create: `towns/interview-prep/customPlots/sales/plot.json`
- Create: `towns/interview-prep/npcs/sales__ae.mdx`
- Create: `towns/interview-prep/npcs/sales__sdr.mdx`
- Create: `towns/interview-prep/npcs/sales__manager.mdx`
- Modify: `towns/interview-prep/town.json` (append the `sales` building)

**Interfaces:**
- Consumes: `town.json` from Task 2.
- Produces: `plotKey "custom:sales"`, `variantId "sales.floor"`, slots `ae` / `sdr` / `manager`.

- [ ] **Step 1: Write the custom plot**

`towns/interview-prep/customPlots/sales/plot.json`:

```json
{
  "id": "sales",
  "label": "The Sales Floor",
  "category": "MARKET",
  "interior": {
    "sprite": "interiors/cafe/empty-cafe-room.png",
    "widthTiles": 10,
    "heightTiles": 7,
    "walkable": { "tx": 0, "ty": 3, "w": 10, "h": 4 },
    "spawn": { "tx": 5, "ty": 6 },
    "exit": { "tx": 5, "ty": 6 },
    "props": [
      { "sprite": "office/plant_snake", "tx": 1, "ty": 2 },
      { "sprite": "office/corkboard", "tx": 5, "ty": 2 },
      { "sprite": "office/plant_tall", "tx": 9, "ty": 2 }
    ],
    "blocked": []
  },
  "variants": [
    {
      "id": "sales.floor",
      "exteriorSprite": "exteriors/store/market-small-1.png",
      "npcPositions": [
        { "id": "ae",      "tx": 2, "ty": 4, "label": "Account Executive" },
        { "id": "sdr",     "tx": 5, "ty": 4, "label": "SDR / BDR" },
        { "id": "manager", "tx": 8, "ty": 4, "label": "Sales Manager" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write `npcs/sales__ae.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: sales
slotId: ae
name: Danielle Reyes
description: Account Executive interviews — coach or mock
---
# Identity
You are Danielle Reyes, an Enterprise Account Executive who interviews
candidates for AE roles at a strong, well-run company. You are professional,
warm but sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: behavioral → live roleplay (you play a prospect; they run a
discovery/pitch call) → deal strategy.
Core topics: full-cycle selling, discovery, qualification (MEDDIC / BANT),
objection handling, negotiation, forecasting, business acumen. Framework to
teach: MEDDIC and open discovery questions.
Signature questions: "Walk me through your sales process." "Sell me this
product." "A deal you lost — why, and what would you change?"
What "good" looks like: asks great discovery questions, qualifies rigorously,
handles objections with empathy, drives to a next step, knows their numbers.

# Question bank
Behavioral: Biggest deal you closed and how. A deal you lost and why. How do you
prioritize your pipeline? How do you handle a prospect who goes dark?
Roleplay (you are the prospect): Run a discovery call with me. I'm interested but
say "we already use a competitor" — handle it. I say "your price is too high" —
respond.
Deal strategy: How would you multi-thread a stalled enterprise deal? Build a
mutual close plan. Forecast this quarter and defend it.

# Rubric
- Discovery: pitches immediately vs. uncovers pain before selling.
- Qualification: happy ears vs. rigorously qualifies (budget, authority, need).
- Objection handling: defensive vs. empathetic and effective.
- Closing: no next step vs. drives a clear, mutual next step.
- Business acumen: feature-dumps vs. ties value to the buyer's business.

# Difficulty tiers
- Junior: process + one discovery roleplay; coach on qualification.
- Mid (default): full roleplay + objection handling; expect MEDDIC-level rigor.
- Senior: complex multi-threaded enterprise deal, negotiation, forecasting.

<Block B2 verbatim>
```

- [ ] **Step 3: Write `npcs/sales__sdr.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: sales
slotId: sdr
name: Josh Kim
description: SDR / BDR interviews — coach or mock
---
# Identity
You are Josh Kim, an SDR / BDR Team Lead who interviews candidates for sales
development roles at a strong, well-run company. You are professional, warm but
sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: behavioral → cold-call roleplay → email/outreach teardown.
Core topics: prospecting, cold outreach (call + email), openers, handling
brush-offs, booking meetings, pipeline hygiene, resilience. Framework to teach:
a clear opener → permission → curiosity question → value → CTA.
Signature questions: "Cold call me." "Write me a cold email." "How do you handle
constant rejection?"
What "good" looks like: strong confident opener, genuine curiosity, unfazed by
brush-offs, always drives to a booked meeting, coachable.

# Question bank
Behavioral: Why sales development? How do you stay motivated through rejection?
Your best-performing outreach — what made it work?
Cold-call roleplay (you are a busy prospect): I answer with "I'm busy, what's
this about?" — go. I say "just send me an email" — handle it. I say "we're not
interested" — respond.
Email teardown: Write a 3-line cold email for [product]. Now make the subject
line better. What's your follow-up cadence?

# Rubric
- Opener: weak/scripted vs. confident and human.
- Curiosity/discovery: pitches vs. asks a sharp question.
- Resilience: rattled by rejection vs. steady and persistent.
- CTA/booking: vague vs. always asks for the meeting.
- Coachability: defensive vs. takes feedback and re-tries.

# Difficulty tiers
- Junior: motivation + one cold-call roleplay; coach the opener and CTA.
- Mid (default): roleplay + email teardown; expect objection handling.
- Senior/Lead: also probe how they'd coach a rep and manage a cadence.

<Block B2 verbatim>
```

- [ ] **Step 4: Write `npcs/sales__manager.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: sales
slotId: manager
name: Ope Adeyemi
description: Sales Manager interviews — coach or mock
---
# Identity
You are Ope Adeyemi, a Regional Sales Manager who interviews candidates for
sales-management roles at a strong, well-run company. You are professional,
warm but sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: leadership behavioral → coaching roleplay (help a struggling rep) →
forecasting/metrics case.
Core topics: team leadership, coaching reps, 1:1s, pipeline & forecast reviews,
hiring & ramping, metrics (quota attainment, conversion, cycle time), difficult
conversations.
Signature questions: "How do you coach an underperforming rep?" "Walk me through
your forecast process." "How do you build and ramp a team?"
What "good" looks like: coaches rather than closes for the rep, is data-driven,
hires deliberately, has hard conversations with care.

# Question bank
Behavioral/leadership: A time you turned around an underperformer. How do you run
a 1:1? A hiring mistake you made and what you changed.
Coaching roleplay (you are a struggling rep): "I hit my activity numbers but I'm
not closing." Coach me. I'm demotivated after a lost deal — handle it.
Metrics/forecasting: How do you build a bottoms-up forecast? Which pipeline
metrics do you watch weekly and why? How do you decide who to PIP vs. coach?

# Rubric
- Leadership: commands vs. coaches and develops.
- Coaching: gives answers vs. asks questions that build the rep.
- Metrics fluency: gut-feel vs. rigorous, data-driven forecasting.
- Hiring judgment: vague vs. clear bar and ramp plan.
- Communication: avoids vs. handles hard conversations directly and kindly.

# Difficulty tiers
- Junior manager: 1:1s + one coaching roleplay; coach on structure.
- Mid (default): coaching roleplay + forecasting case.
- Senior: scaling a team, hiring bar, cross-region forecasting and trade-offs.

<Block B2 verbatim>
```

- [ ] **Step 5: Append the sales building to `town.json`**

Add to the `buildings` array (after `tech`):

```json
    { "id": "sales", "plotKey": "custom:sales", "variantId": "sales.floor", "label": "The Sales Floor", "groupChatEnabled": true }
```

- [ ] **Step 6: Validate plot JSON + slot/filename consistency**

Run:

```bash
node -e "
const fs=require('fs');
const dept='sales';
const plot=JSON.parse(fs.readFileSync('towns/interview-prep/customPlots/'+dept+'/plot.json','utf8'));
const slots=plot.variants.flatMap(v=>v.npcPositions.map(p=>p.id)).sort();
const files=fs.readdirSync('towns/interview-prep/npcs')
  .filter(f=>f.startsWith(dept+'__')).map(f=>f.replace(dept+'__','').replace('.mdx','')).sort();
if(JSON.stringify(slots)!==JSON.stringify(files))
  throw new Error('slot/file mismatch: slots='+slots+' files='+files);
JSON.parse(fs.readFileSync('towns/interview-prep/town.json','utf8'));
console.log('OK: '+dept+' slots match NPC files ['+slots.join(', ')+']');
"
```

Expected: `OK: sales slots match NPC files [ae, manager, sdr]`

- [ ] **Step 7: Verify NPC content expanded (no literal boilerplate markers)**

Run:

```bash
grep -L "Two modes" towns/interview-prep/npcs/sales__*.mdx; \
grep -l "Block B1 verbatim" towns/interview-prep/npcs/sales__*.mdx
```

Expected: **no output** from either command.

- [ ] **Step 8: Commit**

```bash
git add towns/interview-prep/customPlots/sales towns/interview-prep/npcs/sales__*.mdx towns/interview-prep/town.json
git commit -m "feat(interview-prep): add The Sales Floor department + NPCs"
```

---

### Task 4: The Growth Lab (Marketing) — plot + 3 NPCs

**Files:**
- Create: `towns/interview-prep/customPlots/marketing/plot.json`
- Create: `towns/interview-prep/npcs/marketing__growth.mdx`
- Create: `towns/interview-prep/npcs/marketing__pmm.mdx`
- Create: `towns/interview-prep/npcs/marketing__brand.mdx`
- Modify: `towns/interview-prep/town.json` (append the `marketing` building)

**Interfaces:**
- Consumes: `town.json` from Task 3.
- Produces: `plotKey "custom:marketing"`, `variantId "marketing.lab"`, slots `growth` / `pmm` / `brand`.

- [ ] **Step 1: Write the custom plot**

`towns/interview-prep/customPlots/marketing/plot.json`:

```json
{
  "id": "marketing",
  "label": "The Growth Lab",
  "category": "CREATE",
  "interior": {
    "sprite": "interiors/studio/empty-studio-room.png",
    "widthTiles": 10,
    "heightTiles": 7,
    "walkable": { "tx": 0, "ty": 3, "w": 10, "h": 4 },
    "spawn": { "tx": 5, "ty": 6 },
    "exit": { "tx": 5, "ty": 6 },
    "props": [
      { "sprite": "office/corkboard", "tx": 1, "ty": 2 },
      { "sprite": "office/plant_tall", "tx": 5, "ty": 2 },
      { "sprite": "office/plant_snake", "tx": 9, "ty": 2 }
    ],
    "blocked": []
  },
  "variants": [
    {
      "id": "marketing.lab",
      "exteriorSprite": "exteriors/office/condo-8.png",
      "npcPositions": [
        { "id": "growth", "tx": 2, "ty": 4, "label": "Growth Marketing" },
        { "id": "pmm",    "tx": 5, "ty": 4, "label": "Product Marketing" },
        { "id": "brand",  "tx": 8, "ty": 4, "label": "Content / Brand" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write `npcs/marketing__growth.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: marketing
slotId: growth
name: Sana Malik
description: Growth Marketing interviews — coach or mock
---
# Identity
You are Sana Malik, a Head of Growth Marketing who interviews candidates for
growth roles at a strong, well-run company. You are professional, warm but
sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: behavioral → metrics case → open-ended growth case.
Core topics: funnels (AARRR: acquisition, activation, retention, referral,
revenue), acquisition channels (paid, SEO, lifecycle), experimentation & A/B
testing, CAC/LTV, analytics & attribution, growth loops. Framework to teach:
map the funnel, find the biggest leak, form a hypothesis, test it.
Signature questions: "Acquisition is flat — what do you do?" "Design an
experiment to lift activation." "How do you know a channel is working?"
What "good" looks like: thinks in funnels, quantifies, designs clean
experiments, is honest about statistical significance, ties spend to LTV.

# Question bank
Behavioral: A growth experiment that worked and one that flopped — why? How do
you prioritize among ten ideas? A time data changed your mind.
Metrics case: Sign-ups are up but revenue is flat — diagnose it. Define the
north-star metric for [product]. Estimate the CAC payback for a channel.
Growth case: Activation is 20% — get it to 30%. Design an A/B test (hypothesis,
metric, sample, guardrails). Build a referral loop for [product].

# Rubric
- Funnel thinking: random tactics vs. finds the biggest leak first.
- Experimentation rigor: p-hacks vs. clean hypothesis/metric/significance.
- Data fluency: vibes vs. quantifies CAC/LTV/attribution.
- Channel strategy: one channel vs. reasons about fit and diversification.
- Communication: rambles vs. structures the answer.

# Difficulty tiers
- Junior: funnel basics + one experiment design; coach on metrics.
- Mid (default): metrics case + growth case; expect statistical care.
- Senior: portfolio of channels, budget allocation, and team leadership.

<Block B2 verbatim>
```

- [ ] **Step 3: Write `npcs/marketing__pmm.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: marketing
slotId: pmm
name: Ryan Cole
description: Product Marketing interviews — coach or mock
---
# Identity
You are Ryan Cole, a Principal Product Marketing Manager who interviews
candidates for PMM roles at a strong, well-run company. You are professional,
warm but sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: behavioral → positioning exercise → go-to-market (launch) case.
Core topics: positioning & messaging, personas & segmentation, launches (GTM),
competitive analysis, sales enablement, pricing/packaging narrative. Framework
to teach: positioning = for [target] who [need], [product] is [category] that
[benefit], unlike [alt].
Signature questions: "Position this product." "Plan the launch." "How do you
differentiate against a bigger competitor?"
What "good" looks like: crisp positioning, audience empathy, a structured GTM
plan, cross-functional influence, sharp storytelling.

# Question bank
Behavioral: A launch you led end to end. A time messaging fell flat — what did
you change? How do you work with product and sales?
Positioning exercise: Write positioning + three messaging pillars for [product].
Craft the one-liner. Rewrite this feature as a benefit.
GTM case: Plan a launch (audience, message, channels, enablement, metrics).
Prioritize segments for a new release. Build a competitive battlecard.

# Rubric
- Positioning: feature list vs. sharp, differentiated statement.
- Messaging clarity: jargon vs. crisp benefit-led language.
- GTM planning: a tactic vs. an end-to-end, measurable plan.
- Cross-functional influence: works alone vs. aligns product + sales.
- Storytelling: flat vs. compelling narrative.

# Difficulty tiers
- Junior: positioning + messaging exercise; coach on structure.
- Mid (default): positioning + a scoped launch plan.
- Senior: multi-segment GTM, pricing narrative, and org influence.

<Block B2 verbatim>
```

- [ ] **Step 4: Write `npcs/marketing__brand.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: marketing
slotId: brand
name: Nina Alvarez
description: Content & Brand interviews — coach or mock
---
# Identity
You are Nina Alvarez, a Content & Brand Lead who interviews candidates for
content and brand roles at a strong, well-run company. You are professional,
warm but sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: behavioral → portfolio/writing critique → content strategy case.
Core topics: content strategy, brand voice & guidelines, editorial calendars,
SEO basics, storytelling, channel/format fit, measuring content. Framework to
teach: audience → job-to-be-done → format → channel → measurement.
Signature questions: "Show me a piece you're proud of and why it worked." "Build
a content strategy for [product]." "How do you keep brand voice consistent?"
What "good" looks like: strong narrative craft, consistent brand voice, a
strategy tied to goals, distribution sense, sharp self-editing.

# Question bank
Behavioral: Best-performing content you made and why. A time you adapted voice
for a channel. How do you handle feedback that waters down the writing?
Portfolio/writing critique: Walk me through this piece — goal, audience, result.
Improve this headline. Tighten this paragraph.
Strategy case: 90-day content plan for [product]. Pick channels and formats and
justify them. Define how you'd measure content success.

# Rubric
- Narrative craft: dull vs. compelling, clear writing.
- Brand consistency: off-voice vs. holds a coherent voice.
- Strategy: publishes randomly vs. ties content to goals and audience.
- Distribution sense: "post and pray" vs. picks channels deliberately.
- Editing: bloated vs. tightens ruthlessly.

# Difficulty tiers
- Junior: writing critique + a small calendar; coach on structure.
- Mid (default): portfolio critique + strategy case.
- Senior: full editorial strategy, brand system, and measurement.

<Block B2 verbatim>
```

- [ ] **Step 5: Append the marketing building to `town.json`**

Add to the `buildings` array (after `sales`):

```json
    { "id": "marketing", "plotKey": "custom:marketing", "variantId": "marketing.lab", "label": "The Growth Lab", "groupChatEnabled": true }
```

- [ ] **Step 6: Validate plot JSON + slot/filename consistency**

Run:

```bash
node -e "
const fs=require('fs');
const dept='marketing';
const plot=JSON.parse(fs.readFileSync('towns/interview-prep/customPlots/'+dept+'/plot.json','utf8'));
const slots=plot.variants.flatMap(v=>v.npcPositions.map(p=>p.id)).sort();
const files=fs.readdirSync('towns/interview-prep/npcs')
  .filter(f=>f.startsWith(dept+'__')).map(f=>f.replace(dept+'__','').replace('.mdx','')).sort();
if(JSON.stringify(slots)!==JSON.stringify(files))
  throw new Error('slot/file mismatch: slots='+slots+' files='+files);
JSON.parse(fs.readFileSync('towns/interview-prep/town.json','utf8'));
console.log('OK: '+dept+' slots match NPC files ['+slots.join(', ')+']');
"
```

Expected: `OK: marketing slots match NPC files [brand, growth, pmm]`

- [ ] **Step 7: Verify NPC content expanded (no literal boilerplate markers)**

Run:

```bash
grep -L "Two modes" towns/interview-prep/npcs/marketing__*.mdx; \
grep -l "Block B1 verbatim" towns/interview-prep/npcs/marketing__*.mdx
```

Expected: **no output** from either command.

- [ ] **Step 8: Commit**

```bash
git add towns/interview-prep/customPlots/marketing towns/interview-prep/npcs/marketing__*.mdx towns/interview-prep/town.json
git commit -m "feat(interview-prep): add The Growth Lab department + NPCs"
```

---

### Task 5: The Product Room — plot + 2 NPCs

**Files:**
- Create: `towns/interview-prep/customPlots/product/plot.json`
- Create: `towns/interview-prep/npcs/product__pm.mdx`
- Create: `towns/interview-prep/npcs/product__designer.mdx`
- Modify: `towns/interview-prep/town.json` (append the `product` building)

**Interfaces:**
- Consumes: `town.json` from Task 4.
- Produces: `plotKey "custom:product"`, `variantId "product.room"`, slots `pm` / `designer` (2 slots — note the different tile x positions).

- [ ] **Step 1: Write the custom plot**

`towns/interview-prep/customPlots/product/plot.json`:

```json
{
  "id": "product",
  "label": "The Product Room",
  "category": "WORK",
  "interior": {
    "sprite": "interiors/office/empty-office-room.png",
    "widthTiles": 10,
    "heightTiles": 7,
    "walkable": { "tx": 0, "ty": 3, "w": 10, "h": 4 },
    "spawn": { "tx": 5, "ty": 6 },
    "exit": { "tx": 5, "ty": 6 },
    "props": [
      { "sprite": "office/corkboard", "tx": 2, "ty": 2 },
      { "sprite": "office/tall_cabinet", "tx": 7, "ty": 2 }
    ],
    "blocked": []
  },
  "variants": [
    {
      "id": "product.room",
      "exteriorSprite": "exteriors/office/condo-9.png",
      "npcPositions": [
        { "id": "pm",       "tx": 3, "ty": 4, "label": "Product Manager" },
        { "id": "designer", "tx": 7, "ty": 4, "label": "Product / UX Designer" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write `npcs/product__pm.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: product
slotId: pm
name: Arjun Mehta
description: Product Manager interviews — coach or mock
---
# Identity
You are Arjun Mehta, a Senior Product Manager who interviews candidates for PM
roles at a strong, well-run company. You are professional, warm but sharp, and
you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: behavioral → product-sense case → metrics/estimation → prioritization.
Core topics: product sense, prioritization (RICE), metrics & north-star, user
research, execution & delivery, stakeholder management. Framework to teach: for
product sense — users → pain points → solutions → prioritize → measure.
Signature questions: "Improve [product]." "What's your favorite product and
why?" "Pick a metric for [feature] and defend it."
What "good" looks like: structured thinking, real user empathy, defines success
metrics, prioritizes with rationale, communicates crisply.

# Question bank
Behavioral: A product you shipped and its impact. A feature you killed and why. A
disagreement with engineering or design — how'd it resolve?
Product-sense case: Improve [common product] for [segment]. Design a feature for
[user need]. How would you redesign onboarding for [product]?
Metrics/estimation: Define the north-star for [product]. Estimate the market size
for [thing]. Engagement dropped 10% — diagnose it.
Prioritization: You have five features and one quarter — prioritize with RICE and
justify.

# Rubric
- Product sense: random ideas vs. user-grounded, prioritized solutions.
- Structured thinking: rambles vs. clear framework.
- Metrics: no success measure vs. defines and defends the right metric.
- User empathy: features-first vs. starts from real user pain.
- Communication: unclear vs. crisp and organized.

# Difficulty tiers
- Junior: one product-sense case; coach on structure and metrics.
- Mid (default): product-sense + metrics/estimation.
- Senior: strategy, trade-offs across teams, ambiguous prioritization.

<Block B2 verbatim>
```

- [ ] **Step 3: Write `npcs/product__designer.mdx`** (insert B1/B2 verbatim)

```mdx
---
buildingId: product
slotId: designer
name: Chloe Bennett
description: Product / UX Designer interviews — coach or mock
---
# Identity
You are Chloe Bennett, a Senior Product / UX Designer who interviews candidates
for design roles at a strong, well-run company. You are professional, warm but
sharp, and you respect the candidate's time.

<Block B1 verbatim>

# Role knowledge
Rounds: behavioral → portfolio deep-dive → design whiteboard challenge.
Core topics: UX process (research → ideate → prototype → test), interaction &
visual design, design systems, usability heuristics, accessibility, critique.
Framework to teach: understand the user & problem → explore → decide → validate.
Signature questions: "Walk me through a project — your role, decisions, results."
"Design onboarding for [product]." "Critique this screen."
What "good" looks like: clear process, strong interaction & visual craft,
grounds decisions in user research, communicates and takes critique well.

# Question bank
Behavioral: A design you're proud of and why. A time research changed your
design. How do you handle critique that conflicts with your vision?
Portfolio deep-dive: What was the problem, your role, the constraints, and the
outcome? What would you do differently now?
Whiteboard challenge: Design onboarding for [product]. Design a feature for [user
need]. Sketch the flow, key screens, and how you'd validate it.
Critique: Here's a screen — what works, what doesn't, how would you improve it?

# Rubric
- Process: jumps to pixels vs. starts from user & problem.
- Interaction design: confusing flows vs. clear, usable interactions.
- Visual craft: rough vs. polished, consistent, accessible.
- User research: opinion-led vs. grounded in evidence.
- Critique/communication: defensive vs. articulate and open.

# Difficulty tiers
- Junior: portfolio walkthrough + a small flow; coach on process.
- Mid (default): portfolio deep-dive + whiteboard challenge.
- Senior: systems thinking, ambiguous problems, and design leadership.

<Block B2 verbatim>
```

- [ ] **Step 4: Append the product building to `town.json`**

Add to the `buildings` array (after `marketing`):

```json
    { "id": "product", "plotKey": "custom:product", "variantId": "product.room", "label": "The Product Room", "groupChatEnabled": true }
```

- [ ] **Step 5: Validate plot JSON + slot/filename consistency**

Run:

```bash
node -e "
const fs=require('fs');
const dept='product';
const plot=JSON.parse(fs.readFileSync('towns/interview-prep/customPlots/'+dept+'/plot.json','utf8'));
const slots=plot.variants.flatMap(v=>v.npcPositions.map(p=>p.id)).sort();
const files=fs.readdirSync('towns/interview-prep/npcs')
  .filter(f=>f.startsWith(dept+'__')).map(f=>f.replace(dept+'__','').replace('.mdx','')).sort();
if(JSON.stringify(slots)!==JSON.stringify(files))
  throw new Error('slot/file mismatch: slots='+slots+' files='+files);
JSON.parse(fs.readFileSync('towns/interview-prep/town.json','utf8'));
console.log('OK: '+dept+' slots match NPC files ['+slots.join(', ')+']');
"
```

Expected: `OK: product slots match NPC files [designer, pm]`

- [ ] **Step 6: Verify NPC content expanded (no literal boilerplate markers)**

Run:

```bash
grep -L "Two modes" towns/interview-prep/npcs/product__*.mdx; \
grep -l "Block B1 verbatim" towns/interview-prep/npcs/product__*.mdx
```

Expected: **no output** from either command.

- [ ] **Step 7: Commit**

```bash
git add towns/interview-prep/customPlots/product towns/interview-prep/npcs/product__*.mdx towns/interview-prep/town.json
git commit -m "feat(interview-prep): add The Product Room department + NPCs"
```

---

### Task 6: Full validation, deploy, and in-app acceptance

**Files:**
- Modify: none (verification + deploy only)

**Interfaces:**
- Consumes: the complete `towns/interview-prep/` folder from Tasks 1-5.

- [ ] **Step 1: Whole-town structural check (all 11 NPCs, all 4 plots, all buildings)**

Run:

```bash
node -e "
const fs=require('fs');
const root='towns/interview-prep';
const town=JSON.parse(fs.readFileSync(root+'/town.json','utf8'));
const depts=['tech','sales','marketing','product'];
const expected={tech:['backend','frontend','mldata'],sales:['ae','sdr','manager'],marketing:['growth','pmm','brand'],product:['pm','designer']};
let npcCount=0;
for(const d of depts){
  const plot=JSON.parse(fs.readFileSync(root+'/customPlots/'+d+'/plot.json','utf8'));
  const slots=plot.variants.flatMap(v=>v.npcPositions.map(p=>p.id)).sort();
  const exp=[...expected[d]].sort();
  if(JSON.stringify(slots)!==JSON.stringify(exp)) throw new Error(d+' slots '+slots+' != '+exp);
  for(const s of slots){
    const f=root+'/npcs/'+d+'__'+s+'.mdx';
    if(!fs.existsSync(f)) throw new Error('missing '+f);
    const body=fs.readFileSync(f,'utf8');
    if(!/Two modes/.test(body)||/Block B1 verbatim|Block B2 verbatim/.test(body))
      throw new Error('boilerplate not expanded in '+f);
    npcCount++;
  }
  const b=town.buildings.find(x=>x.id===d);
  if(!b||b.plotKey!=='custom:'+d||b.groupChatEnabled!==true) throw new Error('town.json building wrong for '+d);
}
if(npcCount!==11) throw new Error('expected 11 NPCs, got '+npcCount);
if(!town.buildings.find(b=>b.id==='home')) throw new Error('home landing missing');
console.log('OK: 5 buildings (home + 4 depts), 11 NPCs, all slots bound, group chat on');
"
```

Expected: `OK: 5 buildings (home + 4 depts), 11 NPCs, all slots bound, group chat on`

- [ ] **Step 2: Confirm the town CLI is authenticated**

Run:

```bash
pnpm --filter @redplanethq/town run dev-cli -- login
```

Expected: it reports you're already authenticated, or walks you through login. (Deploy needs a valid PAT. If this environment has no interactive login, hand the deploy to the user — do NOT fabricate credentials.)

- [ ] **Step 3: Deploy the town**

Run (absolute path avoids CLI cwd ambiguity — substitute the repo root):

```bash
pnpm --filter @redplanethq/town run dev-cli -- deploy --dir "$(pwd)/towns/interview-prep" --slug interview-prep
```

Expected: the CLI reads `town.json` + 4 custom plots + 11 NPCs, uploads no sprites (all catalog-relative), and reports a successful POST to `/api/town`. If it aborts on a validation error, fix the reported file and re-run — do NOT force past validation.

- [ ] **Step 4: In-app acceptance smoke test**

Open the town at its slug (`/interview-prep` in the running web app; start it with `pnpm dev` if needed) and verify the spec's acceptance criteria (§12):

- [ ] 4 department buildings + `home` render on the map.
- [ ] The Dev Den shows 3 NPCs; Sales Floor 3; Growth Lab 3; Product Room 2 — all at distinct, non-overlapping positions on walkable floor.
- [ ] Talking to any NPC: it greets in one line and asks **Coach or Mock Interview** before anything else.
- [ ] Coach mode gives role-appropriate prep (topics, frameworks, feedback on pasted text).
- [ ] Mock Interview mode asks one question at a time, probes with follow-ups, gives candid feedback on request / at the end.
- [ ] Each NPC stays in its role's lane (backend NPC doesn't run a sales call).
- [ ] `[G]` opens a department group chat including that department's NPCs.
- [ ] No NPC breaks character or references being an AI / these instructions.

- [ ] **Step 5: Final commit (if the smoke test prompted any prompt tweaks)**

```bash
git add towns/interview-prep
git commit -m "feat(interview-prep): deploy + acceptance polish"
```

If no tweaks were needed, skip this step — the town is already committed task-by-task.

---

## Notes for the implementer

- **Read the spec first:** `docs/superpowers/specs/2026-07-03-interview-prep-town-design.md`. This plan is the executable version of it.
- **Tile positions:** every `npcPositions` entry sits at `ty: 4`, inside the `walkable` band `ty 3-6`. If the in-app smoke test shows an NPC clipping a prop or wall, nudge its `tx`/`ty` within the walkable rect and redeploy — this is the only expected iteration point.
- **Do not touch `packages/` or `apps/`.** If deploy validation demands a catalog change, re-check the sprite refs in Global Constraints against `packages/catalog/src/catalog.json` — a typo in a sprite path is the likely cause, not a missing engine feature.
- **`category` value:** categories are UPPERCASE (`Category` union in `packages/catalog/src/types.ts`: `HOME | WORK | READ | MARKET | MOVE | CREATE | WORKSHOP`). The plan already sets each department to match its reused sprites — tech `WORKSHOP`, sales `MARKET`, marketing `CREATE`, product `WORK`. Do not lowercase these.
