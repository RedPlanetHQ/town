# AI Startup Town — deployment setup

Content-only town, deploys via `town deploy` like the others. **No external
integrations required** — every NPC is a conversational advisor, so the town
works in guest mode out of the box.

## The roster

| Building | NPC | Helps with |
|---|---|---|
| The Welcome Room | **Ivy** | Concierge — routes you to the right advisor |
| The Founder's Loft | **Paul Graham** | Founder story & insight |
| The Case Study Room | **Ali Rowghani** | The problem & why now |
| The Marketing Studio | **Garry Tan** | Positioning & marketing |
| The Engineering Bay | **Diana Hu** | Technical architecture & scale |
| The War Room | **Michael Seibel** | Traction & the one metric |
| The GTM Booth | **Dalton Caldwell** | Distribution & first 100 users |

Ivy is the concierge: she asks what the founder is building and what they're
stuck on, then sends them to the single best-fit advisor. The six advisors each
own one topic and run a real office-hours conversation on it.

## How it works

There is no pitch deck and no document. Each advisor is a self-contained
persona defined entirely by its `npcs/*.mdx` prompt. Ivy routes; the advisors
coach. Nothing is written to any external service — the only permission any NPC
holds is `core.memory_search`, used to recognise a returning visitor.

## The office-hours method

Every advisor runs its conversation the same disciplined way (adapted from the
YC office-hours playbook), which is what makes them feel like real partners
rather than themed chatbots:

- **One question at a time** — ask, then wait; never dump a checklist.
- **Specificity is currency** — demand the name, the number, the actual moment.
- **Push twice** — the polished answer first, the true one after a second push.
- **Take a position** — say whether it works and what evidence would change it;
  never "interesting" or "could work."
- **Name the failure pattern** — "solution in search of a problem,"
  "hypothetical users," "waiting to launch until it's perfect."
- **Escape hatch** — if the founder is impatient, ask the two most critical
  questions, give a read, and let them go.
- **Close with an assignment** — one concrete thing to do and a reason to come
  back.

Each advisor also carries its own four **beats** — the specific sub-questions it
walks the founder through (e.g. PG: Scene · Insight · Founder-market fit · Early
users). The beats are spoken coaching prompts, not form fields.

## Deploy

```bash
cd towns/ai-startup-town
town deploy
```

That's it. No OAuth, no template doc, no integration to connect. The town
renders and every advisor chats immediately.

## Guest access

The town is private by default. Share the invite link
`/{slug}?invite_code=<shareCode>` for guest (read-only) visitors, or make the
town public. Guests can walk the map and chat with every advisor; no sign-in
required.
