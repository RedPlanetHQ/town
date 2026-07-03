# Interview Town — deployment setup

Content-only town. Deploys via `town-cli`. Depends on **web search**
being configured for the town owner's account (`isWebSearchConfigured`
must return true in the running `apps/web/src/lib/town-tools.ts`
environment) — each interviewer uses it to look up the visitor's
LinkedIn or GitHub before asking their opening question.

Every interviewer is self-contained. There is no template, no
Google Docs, no accumulating shared document. The artifact each
visitor leaves with is a set of up to seven **Interview Scorecards** —
one per building visited.

## The roster

| Building | Interviewer | Lens | Scoring axis |
|---|---|---|---|
| The Green Room | Piers Morgan | Hostile TV | Honesty vs. deflection |
| The Radio Booth | Terry Gross | Public radio | Self-awareness |
| The Confessional | Marc Maron | WTF-style personal | Willingness to sit in discomfort |
| The Systems Room | Alex Xu | FAANG systems design | System-thinking depth |
| The Coding Bay | Gayle McDowell | Coding interview | Solution communication + edge coverage |
| The Case Room | Victor Cheng | McKinsey case | Structured reasoning under pressure |
| The Portico | Socrates | Socratic philosophical | Consistency of belief under questioning |

Each interviewer scores on a **different axis** — the scorecards are
not fungible. A 10 from Terry Gross means something different from a
10 from Piers Morgan.

## How each interview runs

Every building follows the same shape:

1. **Interviewer greets in character and asks for a URL.**
   - Piers / Terry / Marc / Victor / Socrates default to LinkedIn.
   - Alex Xu / Gayle McDowell default to GitHub.
   - All accept whichever the visitor sends.
2. **Interviewer calls `web_search`** on the URL or a targeted query
   (`site:linkedin.com/in/<handle>`, `site:github.com/<handle>`,
   `<name> career`, etc.). Reads the returned snippets. Extracts 1–3
   specific facts.
3. **Interviewer asks a signature-style question** informed by what
   they found — a needle for Piers, a pivot for Terry, a system-design
   prompt matched to the visitor's stack for Alex, etc.
4. **3–5 substantive exchanges** in character, following the
   interviewer's specific probing style.
5. **Scorecard issued via `give_item`** on the shared
   `interview-scorecard` template, filled with:
   - interviewer name
   - lens
   - topic (what was probed)
   - score (0–10 on their axis)
   - verdict (one line in their voice)

If the visitor won't share a URL, each interviewer has a **fallback
opener** in their prompt — a generic signature question they can lead
with instead.

## Tool surface per interviewer

Every interviewer has exactly the same two grants:

```yaml
permissions:
  town:
    web_search: true
    give_item:
      allowed_template_ids:
        - interview-scorecard
```

- No Google Docs (no template to edit).
- No `memory_search` (each session is self-contained).
- No `list_documents` / `clone_document` / `replace_text`.
- No CORE integrations.

## Prerequisites

- Web search provider configured on the town owner's environment.
  Confirm `isWebSearchConfigured()` returns true.
- Nothing else. No CORE integration setup, no template doc.

## Deploy

```
cd towns/interview-town
town deploy
```

Ship the town under a dedicated CORE account, mint a share code, and
publish the URL wherever the marketing goes.

## Scorecard template

Field schema (see `items/manifest.json`):

- **interviewer** — the interviewer's own name (e.g. `Piers Morgan`)
- **lens** — one-line label (e.g. `Hostile TV`, `Socratic`)
- **topic** — what was probed, ≤ 80 chars
- **score** — `0`–`10`, or `9.5` etc.
- **verdict** — one savage / warm / precise sentence in the
  interviewer's voice, ≤ 100 chars

Visual design (see `items/interview-scorecard.svg`):

- 1200×630 landscape
- Cream background (`#f6f2e8`), navy primary (`#2c3e50`) — reads as
  professional evaluation, deliberately not comedic like Roast Town's
  crimson-on-black
- Score huge in center, verdict as pull quote, interviewer as
  attribution, topic as footer

## Screenshot moment

Each visitor collects up to seven scorecards. The screenshot they'll
actually post is usually **the harshest one** — that's the mechanic
working as intended. Piers giving them a 3, Marc naming the thing they
wouldn't say, Alex Xu telling them their system-design was
memorization not thinking. That's the town.
