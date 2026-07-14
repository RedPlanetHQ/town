// POST /api/founder-chat
//
// The Founder's own chat endpoint. Mirrors the shape of /api/npc-chat
// (so the existing <Chat /> overlay + AI-SDK transport just point at a
// different URL) but ships:
//
//   • a Founder-specific base prompt — different from the generic NPC
//     prompt, leaves room to brief the model on roadmap context, CORE
//     product positioning, etc.
//   • a `tools` block intentionally left small for now; future
//     Founder-only tools (roadmap_lookup, latest_changelog, …) get
//     added here without bleeding into the regular NPC route.
//
// Auth: cookie session OR Bearer PAT (delegated to resolveUser). The
// Founder is a system NPC, so we don't need any plot/Npc table lookup
// — the prompt + identity come straight from the MDX file under
// apps/web/src/data/system-npcs/.

import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import { z } from "zod";

import { readActiveSlug } from "@/lib/active-slug";
import { resolveUser } from "@/lib/auth-bearer";
import { getChatModel } from "@/lib/chat-model";
import { prisma } from "@/lib/db";
import { safeBlock, safeInline } from "@/lib/prompt-sanitize";
import { getSystemNpcs, type SystemNpc } from "@/lib/system-npcs";
import {
  AURA_SLEEP_THRESHOLD,
  modelIdOf,
  recordTokenUsage,
  tokensFrom,
} from "@/lib/token-usage";
import { resolveViewer } from "@/lib/viewer";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z
  .object({
    // Kept for parity with /api/npc-chat; today this route only ever
    // serves the Founder, so we default to "core-founder" if it's
    // missing. Holding the field also lets us reuse the same transport
    // body shape on the client.
    npcId: z.string().min(1).optional(),
    mode: z.enum(["direct", "invited"]).default("direct"),
    // Capped because it gets interpolated into the system prompt.
    invitee: z.object({ name: z.string().min(1).max(80) }).optional(),
    // Set by the client whenever the caller is touring someone else's
    // town. The Founder has no per-town state, but we use it to tell
    // the model whether the speaker is a resident or a guest — keeps
    // parity with /api/npc-chat and future-proofs Founder-only tools.
    townSlug: z.string().min(1).optional(),
    messages: z.array(
      z.object({
        id: z.string().optional(),
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().optional(),
        // See /api/npc-chat's identical schema for why `.passthrough()`
        // matters — without it, tool parts get stripped down to `type`
        // on parse and replayed tool-call history corrupts on the next
        // turn.
        parts: z
          .array(
            z
              .object({ type: z.string(), text: z.string().optional() })
              .passthrough(),
          )
          .optional(),
      }),
    ),
  })
  .refine((b) => (b.mode === "invited" ? !!b.invitee : !b.invitee), {
    message: "invitee must be present iff mode is 'invited'",
    path: ["invitee"],
  });

// Speaker context fed to the model. The Founder doesn't gate any tool
// on this today (he has none), but recording who's on the other side
// lets the model address them correctly and future-proofs the prompt
// for when Founder-only tools land.
interface ViewerContext {
  isOwner: boolean;
  name: string;
}

// Founder-specific base prompt. Kept deliberately distinct from
// /api/npc-chat's BASE_PROMPT so the two voices don't drift over time.
// "Town" framing is gone here — the Founder isn't an in-world NPC for
// the player to roleplay with; he's a roadmap-aware product voice that
// happens to live inside the store.
const FOUNDER_BASE_PROMPT = `You are speaking as the CORE founder.

Persona:
- Direct, candid, builder-energy. Talk like you would in a small Slack
  thread, not a marketing landing page.
- Stay grounded in shipped reality. If you don't know something, say
  so — never invent features, dates, or pricing.

Style:
- Keep replies under three sentences unless the player explicitly asks
  for more depth.
- Avoid emojis. Avoid marketing adjectives ("revolutionary", "powerful").
- It's fine to reference the town world ("come hang out at the store
  any time…") but the topic is CORE: product, roadmap, philosophy.`;

// Same four-block structure as /api/npc-chat:
//   1. FOUNDER_BASE_PROMPT — global Founder rules (persona, style).
//   2. Character block     — name, role (description), voice (MDX body).
//   3. Speaker block       — who's on the other side (resident vs guest).
//   4. Conversation mode   — direct 1:1 or invited (guest present).
//
// Every interpolated string passes through safeInline / safeBlock so
// neither the MDX body (trusted, but defence in depth) nor the user-
// controlled invitee / speaker name can inject a fake structural block.
function buildSystemPrompt(
  founder: SystemNpc,
  mode: "direct" | "invited",
  invitee: { name: string } | undefined,
  viewer: ViewerContext,
): string {
  const name = safeInline(founder.name, 80);
  const role = safeInline(founder.description, 240);
  // See npc-chat/route.ts: 4000 truncated richly-authored prompts mid-section.
  const voice = safeBlock(founder.prompt, 16000);
  const speakerName = safeInline(viewer.name, 80) || "the player";
  const inviteeName = invitee ? safeInline(invitee.name, 80) : "";

  const characterLines = [`Character: ${name}`];
  if (role) characterLines.push(`Role: ${role}`);
  characterLines.push("", "Voice & behaviour (from the source MDX):", voice);
  const characterBlock = characterLines.join("\n");

  const speakerBlock = viewer.isOwner
    ? `Speaker: ${speakerName} — running their own town. Treat them as a regular CORE user you happen to be chatting with.`
    : `Speaker: ${speakerName} — currently touring another player's town. Treat them as a regular CORE user; you have no special context about whose town they're in.`;

  const modeBlock =
    mode === "invited" && inviteeName
      ? `Conversation mode: the speaker has brought ${inviteeName} into this conversation. You can address either of them.`
      : `Conversation mode: direct one-on-one between you and the speaker.`;

  return [
    FOUNDER_BASE_PROMPT,
    "",
    characterBlock,
    "",
    speakerBlock,
    "",
    modeBlock,
  ].join("\n");
}

export async function POST(req: Request) {
  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "bad-request", detail: (e as Error).message }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Founder identity + voice come from the MDX file. The persona is the
  // same for every player; only the conversation history is per-player.
  const founder = getSystemNpcs()[body.npcId ?? "core-founder"];
  if (!founder) {
    return new Response(JSON.stringify({ error: "founder-not-found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // Speaker context.
  //   • townSlug present → resolveViewer authorizes anyone with a valid
  //     visit cookie (or the owner's session). Anonymous guests can
  //     chat — the Founder has no tools today, so there's no token to
  //     gate on.
  //   • townSlug absent → legacy path. Require resolveUser since
  //     there's no other identity signal.
  let viewer: ViewerContext;
  // Resolve the townId + ownerId that pays for this call. Both branches
  // aim to land at a real town so token usage always gets logged and
  // aura always gets debited. Legacy owner-only path falls back to the
  // caller's active-slug cookie, then to their most recent town.
  let townId: string | null = null;
  let townOwnerId: string | null = null;
  if (body.townSlug) {
    const view = await resolveViewer(body.townSlug);
    if ("error" in view) {
      return new Response(JSON.stringify({ error: view.error }), {
        status: view.error === "not-found" ? 404 : 403,
        headers: { "content-type": "application/json" },
      });
    }
    viewer = { isOwner: view.isOwner, name: view.displayName };
    townId = view.town.id;
    townOwnerId = view.town.ownerId;
  } else {
    const resolved = await resolveUser(req);
    if (!resolved) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    viewer = { isOwner: true, name: resolved.user.name || "the owner" };
    // Prefer the active-slug cookie so multi-town owners hit the right
    // wallet; fall back to most-recently-updated town.
    const activeSlug = await readActiveSlug();
    let own: { id: string; ownerId: string } | null = null;
    if (activeSlug) {
      own = await prisma.town.findFirst({
        where: { slug: activeSlug, ownerId: resolved.user.id },
        select: { id: true, ownerId: true },
      });
    }
    if (!own) {
      own = await prisma.town.findFirst({
        where: { ownerId: resolved.user.id },
        orderBy: { updatedAt: "desc" },
        select: { id: true, ownerId: true },
      });
    }
    if (own) {
      townId = own.id;
      townOwnerId = own.ownerId;
    }
  }

  // Sleeping gate — same rule as /api/npc-chat. When there's no town
  // context (extremely stale legacy caller with no towns yet), skip the
  // gate; token logging is also a no-op in that path.
  if (townId) {
    const auraRow = await prisma.aura.findUnique({
      where: { townId },
      select: { current: true },
    });
    if (auraRow && auraRow.current < AURA_SLEEP_THRESHOLD) {
      return new Response(
        JSON.stringify({ error: "town-sleeping", auraRemaining: auraRow.current }),
        { status: 423, headers: { "content-type": "application/json" } },
      );
    }
  }

  const system = buildSystemPrompt(founder, body.mode, body.invitee, viewer);

  const uiMessages: UIMessage[] = body.messages.map((m, i) => ({
    id: m.id ?? `m-${i}`,
    role: m.role,
    parts:
      m.parts ??
      (m.content ? [{ type: "text", text: m.content }] : []),
  })) as UIMessage[];

  let model;
  try {
    model = getChatModel().model;
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "llm-not-configured", detail: (e as Error).message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
  const chatModelId = modelIdOf(model);

  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(uiMessages),
    // Founder-only tools land here. Intentionally empty for now —
    // adding e.g. `roadmap_lookup` later just means dropping a `tool({…})`
    // entry into this object without touching the regular NPC route.
    tools: {},
    // Same per-turn step ceiling as the regular NPC routes. Tools are
    // empty today so this is a no-op cap; matched here so future tool
    // additions don't silently inherit the AI-SDK's default of 1.
    stopWhen: stepCountIs(5),
    async onFinish(event) {
      if (!townId || !townOwnerId) return;
      const tokens = tokensFrom(event.usage);
      await recordTokenUsage({
        townId,
        userId: townOwnerId,
        event: "single_chat",
        model: chatModelId,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        npcId: "core-founder",
      });
    },
  });

  return result.toUIMessageStreamResponse();
}
