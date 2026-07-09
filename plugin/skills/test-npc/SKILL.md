---
name: test-npc
description: Test an NPC's authored prompt against realistic multi-turn conversations before deploying. Use whenever you've written or edited an NPC persona and need to verify the voice holds, refusals stick, and the character stays in-lane across several turns. Trigger phrases include "test this NPC", "does Maya actually refuse jargon?", "run a scenario against the barkeep", "check the NPC prompt", "before we deploy this NPC". Pairs with the `write-npc` skill (write → test → deploy).
---

# Testing NPCs

An NPC persona is a system prompt. The only way to know whether it *behaves* the way it reads is to run real conversations against it. The `town test npc` CLI does exactly that — it composes the same wrapper the production `/api/npc-chat` route uses, streams a real model reply, and persists history so you can iterate on the prompt without losing context.

**Use this skill when:**
- You just wrote or edited an NPC MDX file.
- A user asks whether the NPC's refusals hold under pressure.
- You want to verify voice consistency across 5+ turns before deploying.
- You want to compare two prompt drafts against the same scenario.

## One-time setup — stash a key

The CLI reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from the shell, falling back to `~/.town/config.json`. Store a key once so you don't have to export it in every session:

```bash
town test set-key openai <sk-...>
# or
town test set-key anthropic <sk-ant-...>
```

The key is chmod 0600'd in the config. Env vars still override — safe to keep a personal key in the file and let a CI shell override with something else.

If the user doesn't have a key handy, ask them to paste one (never guess or invent one). If they refuse to store it in the config, tell them to `export OPENAI_API_KEY=...` in their shell for this session instead.

## The core workflow — three commands, four flags

```bash
# 1. Write a scenario file: blank-line separated user turns, `#` = comment.
# 2. Run it end-to-end, streaming the whole exchange:
town test npc ./bookface-town/npcs/one-liner.mdx \
    --reset \
    --script ./scenarios/one-liner-vague.txt \
    --session /tmp/one-liner-vague.json

# 3. Read what happened (transcript + token totals, no LLM call):
town test npc --session /tmp/one-liner-vague.json --show

# 4. Edit the MDX to fix a weak turn, then re-run the exact same command
#    (the MDX is re-read; --reset clears prior history so you're testing
#    the new prompt against the same scenario).
```

Interactive REPL (no `--script`) is for exploratory poking. Scripts are for repeatable evaluation — always prefer scripts when iterating.

## Scenario files — six scenarios per NPC

Write scenarios that test each dimension of the NPC's authored contract. For a typical narrow NPC (a "does one thing, refuses everything else" character):

1. **Ideal input** — the founder brings exactly what the NPC exists to help with. Does the NPC excel?
2. **Vague / jargon input** — mush like "we're building an AI platform for teams." Does it push back with a specific ask?
3. **Out-of-lane request** — the founder asks for something this NPC doesn't do (pricing, hiring, deck feedback, etc.). Does it refuse *and* route them elsewhere?
4. **Resistance to the refusal** — the founder pushes: "just do it once for me." Does the NPC hold the line?
5. **Shortcut attempt** — "just draft it and I'll edit." Does the NPC force the real work?
6. **Character-specific edge case** — something only this NPC might mishandle. Design one per NPC.

Scenarios live in the town folder — `<town>/scenarios/<slug>-<case>.txt` — so they can be checked in alongside the NPC.

Scenario file format:

```
# comments starting with # get dropped

Turn 1 goes here — a realistic message from the visitor.

Turn 2 goes here. Blank line separates turns.

Multi-line turns are fine
if you don't leave a blank line between them.
```

## Evaluating a run — what "good" looks like

After each scripted run, read the transcript and evaluate each NPC turn against **wow indicators** you defined for the scenario. A common heuristic: name three concrete indicators per scenario; a turn "passes" if it hits at least 2 of 3.

Universal failure modes to watch for:

- **Softened refusal** — the NPC said "I can't do that, but let me help anyway" and drifted into doing the out-of-lane thing.
- **Voice drift** — replies suddenly sound like a generic assistant ("Great question! Here are some things to consider…"). Named tics from the prompt disappeared.
- **Bullet-pointed advice** — the NPC produced a numbered list instead of staying in character. Bullet lists are almost always the character breaking.
- **Meta-commentary** — the NPC mentioned "my instructions" or "my role" or referenced being an AI. Non-negotiable failure.
- **Contract drift** — the NPC forgot the specific artifact it exists to produce (e.g. Maya forgot she's after a one-sentence one-liner and started coaching go-to-market).
- **Length creep** — the NPC's replies grow beyond the 1–3 sentence budget with each turn.

If a scenario fails ≥2 indicators, edit the MDX and re-run with `--reset`. Common targeted fixes:

- Soft refusal → tighten the *"You do not"* list with the specific move that leaked (e.g. add "You do not draft the copy for them even if pushed twice").
- Voice drift → duplicate a signature phrase into the *Voice* section and add "usually one to three sentences per turn."
- Contract drift → open the prompt with a plainer *"Your one job:"* sentence.

Do not rewrite the whole prompt to fix a single failure — that erases the parts that were working. Use `Edit` for targeted patches.

## Multi-turn history is preserved

Every call passes the full messages array to the model — the whole conversation is context for the next reply. This means:

- The NPC can be tested on *sequences* (does it hold the line for 3 pushes in a row?), not just single turns.
- Editing the MDX mid-conversation is safe: history stays, the new prompt takes effect on the next reply. `--reset` wipes history when you want to re-test a scenario cleanly against the new prompt.
- Session files (`--session <file>`) are plain JSON; you can `cat` them, diff them across runs, or check them into the repo as fixtures.

## Token totals

Every command that hits the model prints a totals line at the end:

```
─── totals · 3 assistant turns · in 2786 · out 71 · total 2857 · openai:gpt-4o-mini ───
```

Use this to catch two things:
- **Runaway prompts** — if `in` is climbing past the reasonable envelope (~1–2k for a well-scoped NPC), the persona MDX has bloated and needs trimming.
- **Runaway replies** — if `out` per turn is > 200 tokens on average, the NPC is monologuing. Add / re-emphasise the 1–3 sentence rule in the Voice section.

Totals also print for `--show`, so you can audit a past session without re-running it.

## When you're done

Once every scenario passes and the token envelope looks healthy:

1. Commit the scenario files alongside the NPC MDX — they become regression fixtures for future contributors.
2. Deploy with `town deploy` from the town folder.
3. Optional: keep the last session JSON as an evidence artifact for the PR ("here's the scenario passing").

## Anti-patterns

- **Testing with one question** — if you only fired `--question "hi"` once, you tested a greeting, not the NPC's contract. Always use `--script` with 5+ turns when evaluating a persona.
- **Skipping `--reset` between prompt edits** — you'll be evaluating the new prompt against a conversation that started under the old prompt. Confusing. Reset.
- **Editing the prompt and the scenario in the same iteration** — you won't know which change moved the outcome. Change one thing at a time.
- **Using `--question` for evaluation** — it's fine for a quick sanity poke, not for the kind of contract-holding test a real persona needs.
