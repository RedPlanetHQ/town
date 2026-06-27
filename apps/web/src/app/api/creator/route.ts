// POST /api/creator — streaming chat endpoint for the AI town creator.
//
// Body:
//   { townSlug: string, message?: string,
//     action?: "clear-conversation" | "clear-changes" }
//
// Behaviour:
//   • action="clear-conversation" → marks the active CreatorConversation
//     row "cleared" and opens a fresh one. Returns the new id; history is
//     preserved for audit.
//   • action="clear-changes" → clears the active conversation's
//     pendingChanges JSON array (kept on the conversation row itself —
//     see schema.prisma). Returns the conversation id.
//   • Otherwise → debits TURN_COST aura, replays the conversation's
//     stored messages, appends the new user turn, and streams an
//     assistant reply via streamText() with the read + mutation tool
//     registries wired in. The full assistant message (text + tool calls
//     + tool results) is persisted on stream finish so the next turn can
//     replay it verbatim.
//
// Tool execution and the multi-step tool loop are handled by the Vercel
// AI SDK; we cap at stepCountIs(8) so a runaway model can't burn aura
// forever. The mutation tools debit aura inside their own transactions
// — see lib/creator/mutation-tools.ts — so a failing model still pays
// only for the staging it actually performed.

import { anthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { prisma } from "@/lib/db";
import { resolveTownForOwner } from "@/lib/resolve-town";
import {
  addBuildingTool,
  addNpcTool,
  deleteBuildingTool,
  deleteNpcTool,
  updateBuildingTool,
  updateNpcTool,
} from "@/lib/creator/mutation-tools";
import {
  getCurrentTownTool,
  getPlotkeyDetailsTool,
  listCategoriesTool,
  listPlotkeysTool,
  type ToolContext,
} from "@/lib/creator/read-tools";
import { getTownBySlug } from "@/lib/town";

export const dynamic = "force-dynamic";

const TURN_COST = 2;
const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_STEPS = 8;

type CreatorRequestBody = {
  townSlug?: string;
  message?: string;
  action?: "clear-conversation" | "clear-changes";
};

// GET /api/creator?slug=<slug>
//
// Hydrates the CLI chat surface on launch. Resolves the caller's town
// from `?slug=…`, finds (or lazily creates) the active conversation,
// and returns its message history + pending change queue + the town's
// live aura. Returning the conversation id lets the CLI display it /
// debug it; the POST handler still owns conversation rotation.
export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await resolveTownForOwner(req, resolved.user.id);
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });

  let convo = await prisma.creatorConversation.findFirst({
    where: { townId: r.townId, userId: resolved.user.id, status: "active" },
  });
  if (!convo) {
    convo = await prisma.creatorConversation.create({
      data: { townId: r.townId, userId: resolved.user.id },
    });
  }

  const [messages, aura] = await Promise.all([
    prisma.creatorMessage.findMany({
      where: { conversationId: convo.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, createdAt: true },
    }),
    prisma.aura.findUnique({ where: { townId: r.townId } }),
  ]);

  const pending = Array.isArray(convo.pendingChanges)
    ? (convo.pendingChanges as Array<{
        id: string;
        kind: string;
        payload: object;
        summary: string;
      }>)
    : [];

  return NextResponse.json({
    conversationId: convo.id,
    messages,
    pendingChanges: pending,
    aura: aura
      ? { current: aura.current, max: aura.max }
      : { current: 1000, max: 1000 },
  });
}

export async function POST(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: CreatorRequestBody;
  try {
    body = (await req.json()) as CreatorRequestBody;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const townSlug = body.townSlug;
  if (!townSlug) {
    return NextResponse.json({ error: "missing-town-slug" }, { status: 400 });
  }

  const town = await getTownBySlug(townSlug);
  if (!town || town.ownerId !== resolved.user.id) {
    return NextResponse.json({ error: "town-not-found" }, { status: 404 });
  }

  // Find or create the active conversation for this (town, user).
  let convo = await prisma.creatorConversation.findFirst({
    where: { townId: town.id, userId: resolved.user.id, status: "active" },
  });
  if (!convo) {
    convo = await prisma.creatorConversation.create({
      data: { townId: town.id, userId: resolved.user.id },
    });
  }

  // /clear in the CLI: archive the current conversation and start fresh.
  if (body.action === "clear-conversation") {
    await prisma.creatorConversation.update({
      where: { id: convo.id },
      data: { status: "cleared" },
    });
    const fresh = await prisma.creatorConversation.create({
      data: { townId: town.id, userId: resolved.user.id },
    });
    return NextResponse.json({
      conversationId: fresh.id,
      action: "cleared-conversation",
    });
  }

  // Drop the pending diff queue without closing the conversation. The
  // model loses the staged changes from its own perspective on the next
  // get_current_town call.
  if (body.action === "clear-changes") {
    await prisma.creatorConversation.update({
      where: { id: convo.id },
      data: { pendingChanges: [] as unknown as object },
    });
    return NextResponse.json({
      conversationId: convo.id,
      action: "cleared-changes",
    });
  }

  // Turn flow — needs a message.
  if (!body.message || !body.message.trim()) {
    return NextResponse.json({ error: "missing-message" }, { status: 400 });
  }

  // Aura check — we need at least TURN_COST aura to start the turn. The
  // mutation tools do their own per-call debits on top of this.
  const aura = await prisma.aura.findUnique({ where: { townId: town.id } });
  if (!aura || aura.current < TURN_COST) {
    return NextResponse.json(
      { error: "aura-empty", aura: aura ?? null },
      { status: 402 },
    );
  }

  // Replay prior history from the DB. CreatorMessage.content is the AI
  // SDK message body persisted on the previous turn's onFinish — for
  // user turns it's a plain string, for assistant turns it's the full
  // shape including tool call / tool result parts.
  const stored = await prisma.creatorMessage.findMany({
    where: { conversationId: convo.id },
    orderBy: { createdAt: "asc" },
  });

  // Build ModelMessage[]. We accept either plain-string content
  // (user turns) or the rich parts shape we persist for assistants —
  // the SDK normalizes both at the wire layer, so we cast through the
  // shared `ModelMessage` union to keep the TS overload happy.
  const history: ModelMessage[] = stored.map(
    (m) =>
      ({
        role: m.role as ModelMessage["role"],
        content: m.content as unknown,
      }) as ModelMessage,
  );
  const userText = body.message.trim();
  history.push({ role: "user", content: userText });

  const ctx: ToolContext = {
    townId: town.id,
    conversationId: convo.id,
    userId: resolved.user.id,
    prisma,
  };

  const tools = {
    get_current_town: getCurrentTownTool(ctx),
    list_categories: listCategoriesTool(),
    list_plotkeys: listPlotkeysTool(),
    get_plotkey_details: getPlotkeyDetailsTool(),
    add_building: addBuildingTool(ctx),
    delete_building: deleteBuildingTool(ctx),
    update_building: updateBuildingTool(ctx),
    add_npc: addNpcTool(ctx),
    update_npc: updateNpcTool(ctx),
    delete_npc: deleteNpcTool(ctx),
  };

  // Persist the user turn first so even an upstream failure (model
  // rejected, network blip) keeps the message in history.
  await prisma.creatorMessage.create({
    data: {
      conversationId: convo.id,
      role: "user",
      content: userText as unknown as object,
    },
  });

  // Debit turn aura up-front. Mutation tools self-debit on top.
  await prisma.aura.update({
    where: { townId: town.id },
    data: { current: { decrement: TURN_COST } },
  });

  const result = streamText({
    model: anthropic(process.env.ANTHROPIC_MODEL || DEFAULT_MODEL),
    system: buildSystemPrompt(town.name),
    messages: history,
    tools,
    toolChoice: "auto",
    stopWhen: stepCountIs(MAX_STEPS),
    onFinish: async ({ text, toolCalls, toolResults }) => {
      try {
        await prisma.creatorMessage.create({
          data: {
            conversationId: convo!.id,
            role: "assistant",
            content: {
              text,
              toolCalls,
              toolResults,
            } as unknown as object,
          },
        });
      } catch (e) {
        // Don't let a persistence failure tank the stream — the user
        // already got their answer; we just lose this turn from
        // history. Surface it in logs so we notice.
        console.error("[creator] persist assistant message failed", e);
      }
    },
  });

  return result.toUIMessageStreamResponse({
    headers: { "x-conversation-id": convo.id },
  });
}

function buildSystemPrompt(townName: string): string {
  return [
    `You are helping the user shape the town "${townName}".`,
    "",
    "Workflow:",
    "1. Use list_categories → list_plotkeys → get_plotkey_details when you need to pick a building. Don't guess plot keys.",
    "2. Use get_current_town to read the town's current state and your pending changes.",
    "3. Use mutation tools (add_building, update_building, add_npc, etc.) to stage changes. Each call is queued — the user reviews and approves wholesale later.",
    "4. Pair every new building with at least one NPC (use add_npc with a personality prompt that fits the building's vibe).",
    "5. Keep narration short. Show progress through tool calls, not prose.",
    "",
    "You have an `aura` budget; each turn costs 2 aura, each mutation costs 10 aura. If a tool returns { error: 'aura-empty' }, stop staging changes and tell the user.",
  ].join("\n");
}
