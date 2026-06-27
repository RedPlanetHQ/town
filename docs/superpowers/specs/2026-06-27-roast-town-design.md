# Roast Town — Concept Brief

**Date:** 2026-06-27
**Status:** Concept locked, ready for character/persona detailing
**Type:** Showcase town (one of three planned demo towns)

---

## Context: the showcase strategy

We're building a handful of pre-made **showcase towns** to give people clarity on
what Town can be, before the eventual CLI ("give us a URL, we build your town").
These towns optimize for **fun, not functionality** — wandering, talking to
strangers and AI NPCs, having a laugh.

**Target audience for the showcase:** general / viral public. The bar each town
must clear: a hook you can explain in five words, where the *conversation itself*
is the payoff people screenshot and send to a friend.

### The core design principle (the one that matters most)

> **A town needs a verb, not just a cast.** "Talk to cool characters" is not an
> activity — it goes flat in 30 seconds. The towns that work give you something to
> *do*, and the characters serve that activity.

This is why "Dead Famous Town" and "Anime Town" were rejected: great rosters, no
verb. Roasting and solving are verbs; talking is not.

### The planned showcase set

| Town | Verb | Status |
|---|---|---|
| **Roast Town** | roasting | **This doc — concept locked** |
| **Murder Mystery Town** | find the suspect | Liked; not yet detailed |
| **3rd town (TBD)** | chosen by "what's the verb?" not "who's the cast?" | Open |

Held in back pocket: **Hype Town** — the exact inverse of Roast Town (every NPC
unconditionally believes in you). Release later as the twin: *"the town that
roasts you / the town that loves you."*

---

## Roast Town

**One-liner:** A town where every building is a different way to roast or get
roasted.

**The verb:** roasting.

**Structure:** Roast Town is a hub. It is *not* one mechanic — each building is a
different flavor of the roast verb, so a single town showcases the full range.
This matches the engine's existing model where every room is its own little
experience.

### Build scope — v1 is chat-engine only (no new game code)

Decided: **ship Roast Town as pure content on the existing engine.** No new
building types, no custom mechanics (no URL fetch, no timer, no score UI). Every
building reuses an existing building shell (gym / office / store / studio / …)
reskinned by persona, and the only verbs are what the engine already gives NPCs:
**1:1 chat** and **per-building group chat** (`api/group-chat/[slug]/[building]`).

How each building degrades to pure content:

- **Roast Pit** → a building whose NPCs are the 4 panelists, run as a **group
  chat**. The player *pastes their pitch / describes their site in the message*;
  all four panelists pile on from their lens. No URL fetching, no score UI — the
  multi-angle roast still lands. (Real URL-fetch + scoring is a deferred upgrade,
  not v1.)
- **Clap-Back Bar** → Challenger + Judge as NPCs. The battle is conversational;
  the Judge persona simply *declares* a winner in chat. No timer, no scoreboard.
- **Burn Dojo** → Sensei Slim, plain 1:1 chat. Maps onto the **gym** shell.

This makes Roast Town entirely a matter of writing NPC `.mdx` personas + seeding a
town (slug + plot + npcs), with zero net-new features.

**Progression:** All buildings open from the start (no gating). Best for a
showcase — visitors reach the viral Roast Pit immediately, no grind. There's a
natural soft arc — **learn → fight → unleash** — but nothing is locked.

### Buildings (v1)

#### 🥊 The Burn Dojo — *train · low stakes*
You roast NPCs (training dummies + sparring partners) and a coach gives you
real-time feedback on your burns. This is where players learn the verb before the
stakes rise.

- **Sensei Slim** — roast master / coach. Critiques the player's insults
  ("too soft — go for the ego"), levels them up.
- Screenshot moment: leveling up your own burn from weak to brutal.

#### 🎤 The Clap-Back Bar — *fight · the centerpiece*
A **timed 1v1 roast battle**. An NPC challenger trades burns with the player
round-for-round; when the clock runs out, a judge NPC declares the winner.

- **The Challenger** — the player's opponent; throws burns at the player, the
  player fires back.
- **The Judge** — scores each round, calls the win/loss when time expires.
- *(optional)* **The Crowd** — reacts, "ooooh"s, fuels the screenshot.
- Key property: **time-bound** match with a declared winner.
- Screenshot moment: your best comeback + the judge's verdict.

#### 🕳️ The Roast Pit — *unleash · the viral payoff*
The player drops a **real target** and a panel of four NPCs roasts *it*, each from a
different lens. This is the money building: roasting someone's *actual* stuff is the
most viral mechanic in the project, and a direct, playable preview of the eventual
"give us a URL and we'll build/roast your town" CLI vision.

**No host** — the player drops a target and the panel goes straight in.

**The Panel (4 judges, each a different roast lens):**

| Panelist | Lens | Voice / bit |
|---|---|---|
| **Chad Ventures** 🕶️ | Money / market — jaded VC | Patagonia vest, checks phone mid-roast. *"This is a feature, not a company. Next."* |
| **Margot** 🎨 | Taste / craft — design, UX, writing | Art-school disdain, withering understatement. *"Bold choice using five fonts. Were they all on sale?"* |
| **Kai** 🧢 | Culture / vibes — is it cringe, is it dated | Gen-Z intern, current slang. *"This is giving 2017 LinkedIn hustle. It's so over."* |
| **Rex** 💻 | Tech / code — the stack, the repo | Grizzled 10x dev. *"jQuery. In 2026. I need a moment."* |

The panelists also **bicker with each other** — extra comedy beyond the roast itself.

**Accepted targets (3):**

- **Website URL** — the Pit fetches title / meta / content and roasts the site. Core
  viral case, closest to the CLI vision.
- **GitHub repo** — roast the stack, README, language, stars. Plays to Rex.
- **"Roast me" (self)** — the player drops a selfie or self-description; the panel
  roasts the player personally. Most personal, most shareable.
- *(Cut from v1: free-text startup pitch.)*

**Flow:**
1. Player steps to the mic → *"What are we roasting today?"*
2. Player drops a target (URL / GitHub / self).
3. The Pit fetches & summarizes the target (scrape for URL, repo metadata for GitHub,
   image/text description for self).
4. Each of the four panelists roasts in turn, from their lens, bickering.
5. A final **verdict + roast score** the player can screenshot / share.

Screenshot moment: the savage four-angle roast of the player's real website / repo / self.

---

## Open items (next session)

v1 is pure content on the existing chat engine, so the work is personas + seeding:

- Write all **NPC personas as `.mdx`** matching `apps/web/src/data/npc-templates/`:
  Roast Pit panel (Chad / Margot / Kai / Rex), Clap-Back Bar (Challenger + Judge),
  Burn Dojo (Sensei Slim) — voice, backstory, roast style, signature lines, and the
  Judge's "declare a winner" wrap. Panelists should reference "whatever you paste."
- Confirm **building-shell mapping** (which existing shell each building reuses) and
  that the Roast Pit shell supports a **multi-NPC / group-chat** building.
- Decide **how the town gets provisioned** (like `core-town`): a seed user + Town row
  + plot + `seedNpcs()`. Likely a seed script; needs a public slug + share code +
  a landing-page link.
- Decide the **3rd showcase town** (verb-first).
- Later: detail **Murder Mystery Town**.

### Deferred (post-v1 upgrades, not needed to ship)

- Roast Pit **real target fetch**: URL scrape, GitHub metadata, selfie handling, fed
  to the panel as context (the CLI-vision version).
- Clap-Back Bar **timed match + scoring UI** (timer, rounds, scoreboard).
