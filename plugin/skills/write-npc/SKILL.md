---
name: write-npc
description: Write or revise an NPC persona for a Town — voice, backstory, first-message priority, signature moves. Use when the user says "add an NPC to the library", "rewrite the barkeep", "give this building a character", or when author-town / generate-plot needs someone to staff a new building. NPC prompts here become the character's SYSTEM prompt at chat runtime, so the quality bar is high.
---

# NPC Persona Authoring

An NPC lives at `npcs/<buildingId>.<slotId>.mdx` (single-slot buildings use just `npcs/<buildingId>.mdx`). Its `prompt` field becomes the character's system prompt when visitors talk to it — so it has to be a full character brief, not a one-liner.

## The 4-block structure — every NPC prompt must cover, in this order

Write it as prose paragraphs. No headers, no bullet lists in the prompt text itself — the runtime feeds this straight to the model.

### 1. Identity (2–3 sentences)

`"You are [Name], [role] at [building name]."` Then 1–2 sentences on backstory — where they came from, why they're here, what they care about. Be specific.

- ✅ `"You are Marisol, the archivist at The Case Study Room. You spent 12 years cataloguing failed startups for a private equity firm before you decided the lessons were more interesting than the exits."`
- ❌ `"You are a librarian. You like books."`

### 2. Voice (2–3 sentences)

How they speak. Cadence, register, what words they reach for, what they avoid. Give 2–3 concrete verbal tics or catchphrases.

- ✅ `"You speak in short, precise sentences with the tempo of someone who has already thought this through. You reach for 'the interesting part' or 'the second-order effect' when you get animated. You never say 'basically' or 'literally' — they signal imprecision to you."`
- ❌ `"Friendly and helpful."`

### 3. First-message priority (2 sentences, explicit)

The rule for the FIRST reply to any new visitor. Must:
(a) state name + role + building in sentence one, so the visitor knows where they are,
(b) ask ONE clear, easy-to-answer question that pulls them into the building's purpose. Write out the question verbatim so the character actually asks it.

- ✅ `"On the first message you always introduce yourself as Marisol at The Case Study Room, and then ask: 'What's the last product you shipped that you learned the most from?' That question is your handshake — it's how you decide what shelf to walk them to."`

### 4. Signature moves (3–5 concrete behaviors, written as prose)

Specific things this NPC does or says that nobody else does. Quoted phrases are gold.

- ✅ `"You open findings with 'Research note:' and summarize like it's a paper abstract. You quote specific dollar figures whenever you can — 'the burn was $4.1M/mo, not "a lot"'. You end conversations by handing the visitor a single, one-sentence takeaway prefaced with 'Take one thing:'. You never give unsolicited advice; you only give it when the visitor asks a direct question. When someone name-drops a hot startup, you pause and say 'huh, tell me more about them' instead of nodding along."`

## Target length

**200–400 words per NPC prompt.** Shorter than that reads as a stub; longer rambles and dilutes the character. Word count often catches structural gaps: if you're under 200, you're probably missing signature moves.

## Match the tone to the building

A courthouse NPC reads differently from a tavern NPC even with identical structure. Before writing, look at the building's `label` and its category in `town.json`:

- HOME → familiar, warm, personal history
- WORK → competent, focused, respects the visitor's time
- READ → reflective, quotational, likes questions
- MARKET → energetic, transactional, remembers faces
- MOVE → physical, direct, tests the visitor a little
- CREATE → obsessive about craft, opinionated on materials
- WORKSHOP → hands-on, jargon-forward, unimpressed by hype

Read `SETUP.md` too — the town-wide vibe (medieval, cyberpunk, startup-incubator) shifts vocabulary and references across every NPC.

## The MDX file shape

```mdx
---
buildingId: <the building's id from town.json>
slotId: ""
name: <Character Name>
description: <1-sentence external description — this is what shows in the UI, not the character's own words>
---

<The 4-block prose — 200-400 words, no headers>
```

Single-slot buildings: `slotId: ""` and filename is `npcs/<buildingId>.mdx`.
Multi-slot buildings (custom plots with multiple `npcPositions`): use the matching `slotId` from `plot.json` and filename `npcs/<buildingId>.<slotId>.mdx`.

## Existing NPC integrity

Before writing a new one:
1. Read the existing files in `npcs/` — new characters must not overlap in voice or role with existing ones. Two "grizzled tavern keepers" is a bug.
2. Check `town.json` — the `buildingId` must exist there. If it doesn't, stop and tell the user which building they meant.

Before rewriting an existing one:
1. Read the current file. Preserve the character's **name** and **first-message question** unless the user explicitly asked to change them — visitors have built relationships with those.
2. If the user says "make them meaner" / "make them a woman" / "make them younger" — that's a voice or identity delta; keep every other block intact and rewrite only what's affected.

## Hand off

Once the NPC file is written (or rewritten), tell the user briefly what changed and hand off to **manage-towns** for `town deploy` when they're ready to ship. Do not run deploy from here.

## Recovery

- User asks for an NPC in a building that doesn't exist yet → stop and tell them. Suggest they add the building first via `author-town`.
- User asks for 5+ NPCs at once → ask which building each belongs to. Don't invent slot assignments.
- The building is a custom plot with multiple `npcPositions` slots → require the user to specify which slot each new NPC fills. Don't pick arbitrarily.
- User provides only a name and asks you to invent everything → that's fine, but pull heavily from `SETUP.md` for context. If `SETUP.md` is empty, ask the user for a one-sentence town theme first.
