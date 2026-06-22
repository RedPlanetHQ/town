// Permission-gated tool factory for NPC chats.
//
// Each NPC ships with an NpcPermissions grant (see npc-templates.ts). At
// chat time we hand the grant + the town owner's CORE access token to
// buildNpcTools(), which produces an AI-SDK `tools` object containing only
// the tools the NPC is explicitly allowed to call. Anything not in the
// grant is simply not present on the model's tool surface — no implicit
// access, even for memory_search.
//
// All HTTP calls go to CORE_OAUTH_BASE with `Authorization: Bearer <owner
// token>`. The owner token gates the data scope: memory, integrations,
// tasks, skills, and reminders are always the TOWN OWNER's, regardless of
// who is chatting. The NPC's grant gates what the model may *do* with that
// scope.

import { tool, type Tool } from "ai";
import { z } from "zod";

import type { TownCatalog } from "@town/types";

import { prisma } from "./db";
import type { NpcPermissions } from "./npc-templates";
import { recordTownActivity } from "./town-activity";
import {
  findItem,
  findTag,
  isWebSearchConfigured,
  renderItemSvg,
  webSearch,
} from "./town-tools";

const CORE_BASE_ENV = "CORE_OAUTH_BASE";

interface FetchContext {
  ownerToken: string;
  base: string;
}

function makeContext(ownerToken: string | null): FetchContext | { error: string } {
  if (!ownerToken) return { error: "no-owner-token" };
  const base = process.env[CORE_BASE_ENV];
  if (!base) return { error: "core-base-not-set" };
  return { ownerToken, base };
}

async function coreFetch(
  ctx: FetchContext,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${ctx.base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.ownerToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Log the full upstream detail server-side so an operator can
    // diagnose; only surface the status code to the model. CORE error
    // bodies routinely include internal paths/ids and we don't want
    // those landing in a chat reply by accident.
    console.warn(
      `[npc-tools] CORE ${res.status} on ${path}: ${text.slice(0, 500)}`,
    );
    return { error: `core ${res.status}` };
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    console.warn(
      `[npc-tools] CORE bad json on ${path}: ${text.slice(0, 500)}`,
    );
    return { error: "core-bad-json" };
  }
}

/**
 * Cache integration_account_id → slug for the duration of one chat request.
 * We can't trust the model to remember which account id maps to which slug,
 * so every integration tool re-resolves slugs from the cache at call time
 * before checking the permission grant. The cache itself is loaded once
 * (first call) — if CORE returns 0 accounts, subsequent calls short-circuit.
 */
class IntegrationResolver {
  private inflight: Promise<Array<{ id: string; slug: string; name?: string }>> | null = null;

  constructor(private ctx: FetchContext) {}

  /** Load once per chat. Concurrent callers (AI SDK can dispatch parallel
   *  tool calls in one turn) share the in-flight promise instead of each
   *  hitting CORE. Failures cache an empty array via the same path so
   *  retries don't thrash. */
  load(): Promise<Array<{ id: string; slug: string; name?: string }>> {
    if (!this.inflight) this.inflight = this.fetch();
    return this.inflight;
  }

  private async fetch(): Promise<Array<{ id: string; slug: string; name?: string }>> {
    // GET /api/v1/integration_account returns { accounts: [...] } where each
    // entry shapes as { id, accountId, integrationDefinition: { id, name,
    // slug, ... } }. The slug is the cross-account identity we permission
    // on; the human name is on the definition too.
    const res = (await coreFetch(this.ctx, "/api/v1/integration_account")) as
      | { accounts?: Array<Record<string, unknown>> }
      | { error: string };
    if ("error" in res) {
      console.warn("[npc-tools] integration_account list failed", res);
      return [];
    }
    const list = Array.isArray(res.accounts) ? res.accounts : [];
    const out: Array<{ id: string; slug: string; name?: string }> = [];
    for (const a of list) {
      const id = typeof a.id === "string" ? a.id : null;
      const def =
        a.integrationDefinition && typeof a.integrationDefinition === "object"
          ? (a.integrationDefinition as Record<string, unknown>)
          : null;
      const slug = def && typeof def.slug === "string" ? def.slug : null;
      if (!id || !slug) continue;
      const name = def && typeof def.name === "string" ? def.name : undefined;
      out.push({ id, slug, name });
    }
    return out;
  }

  async slugFor(accountId: string): Promise<string | null> {
    const accounts = await this.load();
    return accounts.find((a) => a.id === accountId)?.slug ?? null;
  }
}

function integrationGrant(
  perms: NpcPermissions,
  slug: string,
): { allowed: boolean; actions?: string[] } {
  const list = perms.integrations ?? [];
  const entry = list.find((g) => g.slug === slug);
  if (!entry) return { allowed: false };
  return { allowed: true, actions: entry.actions };
}

function isActionAllowed(
  perms: NpcPermissions,
  slug: string,
  action: string,
): boolean {
  const grant = integrationGrant(perms, slug);
  if (!grant.allowed) return false;
  // No `actions` filter → level-1 grant (full integration).
  if (!grant.actions) return true;
  return grant.actions.includes(action);
}

/** Metadata for one callable skill — used to advertise the skill to
 *  the model in `read_skill`'s tool description so it doesn't have to
 *  guess opaque ids. Loaded once per chat by loadCallableSkillMeta. */
export interface CallableSkillMeta {
  id: string;
  title: string;
  /** Short summary the model uses to decide whether the skill is
   *  worth fetching. Falls back to a content snippet if the CORE
   *  skill record has no explicit description field. */
  description: string;
}

/** Per-chat context for the town-scoped tools (web_search / grant_tag /
 *  give_item). The route handler resolves these from the visitor cookie
 *  + town slug before calling buildNpcTools — passing null disables
 *  every town tool, which is what personal-town chats want. */
export interface TownContext {
  townSlug: string;
  /** "user:<id>" / "guest:<id>" — same shape Conversation rows use. */
  subjectKey: string;
  /** Display name + character for the visitor. Threaded through so the
   *  award tools can write a TownActivity row without re-resolving the
   *  viewer. */
  subjectName: string;
  subjectCharacter: string | null;
  /** NPC row id, stored on VisitorTag.awardedByNpc / VisitorItem.awardedByNpc
   *  for audit. May be null if the NPC is ephemeral / not persisted. */
  npcId: string | null;
  /** NPC display name (for activity feed metadata). */
  npcName: string | null;
  /** The town's catalog (tags + item templates with SVG bodies). null
   *  means the town hasn't authored one yet — grant_tag and give_item
   *  silently don't register. */
  catalog: TownCatalog | null;
  /** True when the caller is the town's owner chatting in their own
   *  town. The award tools (grant_tag / give_item) refuse to register
   *  for owners — earning your own NPC's tags would pollute the data
   *  and isn't a meaningful in-world reward. web_search stays on. */
  isOwner: boolean;
  /** Absolute base URL for constructed share links (e.g. "https://town.getcore.me").
   *  When omitted, give_item returns a path-relative share_url. */
  publicBaseUrl?: string;
}

/**
 * Build the AI-SDK tools object for an NPC chat turn.
 *
 * - `ownerToken` may be null when the resident hasn't linked CORE; in that
 *   case every tool returns {error: "no-owner-token"} and the model falls
 *   back to common sense.
 * - `permissions` is the NPC's grant. Tools not granted are not present on
 *   the returned object — the model literally cannot see them.
 * - `callableSkills` is the metadata for skills under
 *   `permissions.skills.callable`. When present, each entry's id +
 *   title + description gets embedded in `read_skill`'s tool
 *   description so the model knows what's available without having
 *   to guess. Pass `[]` (or omit) to fall back to the previous
 *   "model has to guess ids" behaviour.
 */
export function buildNpcTools(
  ownerToken: string | null,
  permissions: NpcPermissions,
  callableSkills: CallableSkillMeta[] = [],
  townCtx: TownContext | null = null,
): Record<string, Tool> {
  const ctxOrErr = makeContext(ownerToken);
  const tools: Record<string, Tool> = {};

  // ── memory_search ─────────────────────────────────────────────────────
  if (permissions.core?.memory_search) {
    tools.memory_search = tool({
      description:
        "Search the town RESIDENT's CORE memory graph for facts relevant to a query. " +
        "Use when the conversation needs grounded context about the resident's life, " +
        "work, projects, or thinking. Don't call for small talk.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Natural-language query to run against the resident's memory."),
        limit: z
          .number()
          .min(1)
          .max(20)
          .default(5)
          .describe("Max number of episodes/facts to return."),
      }),
      async execute({ query, limit }) {
        if ("error" in ctxOrErr) return { error: ctxOrErr.error };
        return await coreFetch(ctxOrErr, "/api/v1/search", {
          method: "POST",
          body: JSON.stringify({ query, limit }),
        });
      },
    });
  }

  // ── Integrations (list/list-actions/execute) ──────────────────────────
  const hasAnyIntegrationGrant = (permissions.integrations ?? []).length > 0;
  if (hasAnyIntegrationGrant && !("error" in ctxOrErr)) {
    const grantedSlugs = new Set(
      (permissions.integrations ?? []).map((g) => g.slug),
    );
    const resolver = new IntegrationResolver(ctxOrErr);

    tools.list_integrations = tool({
      description:
        "List the resident's connected CORE integrations that this NPC is allowed to use. " +
        "Returns [{integration_account_id, slug, name}]. Call this before list_integration_actions " +
        "or execute_integration_action to learn what's available.",
      inputSchema: z.object({}),
      async execute() {
        const all = await resolver.load();
        return {
          integrations: all
            .filter((a) => grantedSlugs.has(a.slug))
            .map((a) => ({
              integration_account_id: a.id,
              slug: a.slug,
              name: a.name ?? a.slug,
            })),
        };
      },
    });

    tools.list_integration_actions = tool({
      description:
        "List the actions available on a connected integration. Optionally filter with a " +
        "natural-language query (CORE will rank by relevance). Returns only actions this NPC " +
        "is permitted to invoke.",
      inputSchema: z.object({
        integration_account_id: z.string().min(1),
        query: z.string().optional().describe(
          "Natural-language query to filter actions, e.g. 'send email' or 'create event'.",
        ),
      }),
      async execute({ integration_account_id, query }) {
        const slug = await resolver.slugFor(integration_account_id);
        if (!slug || !grantedSlugs.has(slug)) {
          return { error: "integration-not-permitted" };
        }
        const path =
          `/api/v1/integration_account/${encodeURIComponent(integration_account_id)}/action` +
          (query ? `?query=${encodeURIComponent(query)}` : "");
        const res = (await coreFetch(ctxOrErr, path)) as {
          actions?: Array<Record<string, unknown>>;
          error?: string;
        };
        if ("error" in res && res.error) return res;
        const actions = Array.isArray(res.actions) ? res.actions : [];
        const grant = integrationGrant(permissions, slug);
        // Level-1 grant: return everything. Level-2: filter to whitelist.
        const filtered = grant.actions
          ? actions.filter(
              (a) => typeof a.name === "string" && grant.actions!.includes(a.name),
            )
          : actions;
        return { actions: filtered };
      },
    });

    tools.execute_integration_action = tool({
      description:
        "Invoke an action on a connected integration. Use list_integration_actions to learn the " +
        "action name and required parameters. Returns CORE's tool-result envelope " +
        "{result: {content: [...], isError: bool}}.",
      inputSchema: z.object({
        integration_account_id: z.string().min(1),
        action: z.string().min(1).describe("Action name as returned by list_integration_actions."),
        parameters: z
          .record(z.string(), z.unknown())
          .describe("Action parameters object. Shape comes from the action's inputSchema."),
      }),
      async execute({ integration_account_id, action, parameters }) {
        const slug = await resolver.slugFor(integration_account_id);
        if (!slug || !grantedSlugs.has(slug)) {
          return { error: "integration-not-permitted" };
        }
        if (!isActionAllowed(permissions, slug, action)) {
          return { error: "action-not-permitted", action, slug };
        }
        return await coreFetch(
          ctxOrErr,
          `/api/v1/integration_account/${encodeURIComponent(integration_account_id)}/action`,
          {
            method: "POST",
            body: JSON.stringify({ action, parameters }),
          },
        );
      },
    });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────
  const taskGrant = new Set(permissions.core?.tasks ?? []);
  if (taskGrant.has("read") && !("error" in ctxOrErr)) {
    tools.list_tasks = tool({
      description:
        "List the resident's CORE tasks. Optional filters: status (Todo/Waiting/Ready/Working/Review/Done) " +
        "and search (free-text against title/description).",
      inputSchema: z.object({
        status: z
          .enum(["Todo", "Waiting", "Ready", "Working", "Review", "Done"])
          .optional(),
        search: z.string().optional(),
      }),
      async execute({ status, search }) {
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        if (search) params.set("search", search);
        const qs = params.toString();
        return await coreFetch(ctxOrErr, `/api/v1/tasks${qs ? `?${qs}` : ""}`);
      },
    });
  }
  if (taskGrant.has("write") && !("error" in ctxOrErr)) {
    tools.create_task = tool({
      description:
        "Create a new CORE task for the resident. `title` is required. To capture a " +
        "reminder, set either `nextRunAt` (one-shot at a specific ISO timestamp) or " +
        "`schedule` (RRule string like 'FREQ=DAILY;BYHOUR=9' for recurring). Use " +
        "sparingly — confirm with the player before capturing a task or reminder.",
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z
          .enum(["Todo", "Waiting", "Ready", "Working", "Review", "Done"])
          .optional(),
        nextRunAt: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp for a one-shot reminder."),
        schedule: z
          .string()
          .optional()
          .describe("RRule string for a recurring reminder."),
        maxOccurrences: z
          .number()
          .min(1)
          .optional()
          .describe("Cap the number of fires when scheduled."),
      }),
      async execute(payload) {
        return await coreFetch(ctxOrErr, "/api/v1/tasks", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
    });
    tools.update_task = tool({
      description:
        "Update an existing CORE task. Patch only the fields provided. " +
        "Use the displayId or id returned by list_tasks/create_task.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z
          .enum(["Todo", "Waiting", "Ready", "Working", "Review", "Done"])
          .optional(),
        nextRunAt: z.string().optional(),
      }),
      async execute({ taskId, ...patch }) {
        return await coreFetch(
          ctxOrErr,
          `/api/v1/tasks/${encodeURIComponent(taskId)}`,
          { method: "PATCH", body: JSON.stringify(patch) },
        );
      },
    });
  }

  // Reminders aren't a separate tool surface — CORE tasks already accept
  // `schedule` (RRule) and `nextRunAt` (one-shot), so a "remind me" intent
  // resolves to create_task with a schedule. Keeping the surface narrow
  // means the model doesn't have to choose between two near-identical
  // APIs.

  // ── Skills ────────────────────────────────────────────────────────────
  // GET /api/v1/skills/:id returns { skill: {...} } — unwrap so the model
  // sees just the skill record instead of the envelope.
  const callable = permissions.skills?.callable ?? [];
  if (callable.length > 0 && !("error" in ctxOrErr)) {
    const allowed = new Set(callable);

    // Advertise the available skills directly in the tool description
    // — the model would otherwise have to guess opaque ids. We only
    // list skills we have metadata for; ones that failed to load
    // silently fall back to the "model guesses" behaviour for that id.
    const knownMeta = callableSkills.filter((s) => allowed.has(s.id));
    const advertised =
      knownMeta.length > 0
        ? knownMeta
            .map((s) => `- id="${s.id}" — ${s.title}: ${s.description}`)
            .join("\n")
        : "(no skill metadata available — call with one of the granted ids)";

    tools.read_skill = tool({
      description: [
        "Read a CORE skill (a stored playbook / workflow / persona document) by id.",
        "Returns the skill record including its `content` field. Use to load detailed",
        "instructions on demand.",
        "",
        "Available skill_ids you may pass:",
        advertised,
      ].join("\n"),
      inputSchema: z.object({
        skill_id: z.string().min(1),
      }),
      async execute({ skill_id }) {
        if (!allowed.has(skill_id)) return { error: "skill-not-permitted" };
        const res = (await coreFetch(
          ctxOrErr,
          `/api/v1/skills/${encodeURIComponent(skill_id)}`,
        )) as { skill?: Record<string, unknown>; error?: string };
        if ("error" in res && res.error) return res;
        return res.skill ?? { error: "skill-not-found" };
      },
    });
  }

  // ── Town: web_search ─────────────────────────────────────────────────
  // Permission-gated, env-gated. The tool is only present when both the
  // NPC has the grant AND the server has a search provider configured —
  // so the model never sees a tool it can't actually use.
  if (permissions.town?.web_search && isWebSearchConfigured()) {
    tools.web_search = tool({
      description:
        "Search the public web for facts to ground a reply. Use sparingly — only when the conversation needs a recent or specific external fact (a real article, a recent event, a public figure's actual position). Don't call for small talk.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Natural-language search query."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Max number of results to return."),
      }),
      async execute({ query, limit }) {
        try {
          return await webSearch(query, limit);
        } catch (e) {
          return {
            error: "web-search-failed",
            detail: e instanceof Error ? e.message : "unknown",
          };
        }
      },
    });
  }

  // Per-turn award budgets — one grant_tag and one give_item per chat
  // request. The model gets to make a deliberate, single award; further
  // calls within the same turn return {error: "award-limit-reached"} so
  // the NPC doesn't end up spamming pills above the visitor's head or
  // dumping a stack of duplicate cards into their inventory.
  let tagAwardsRemaining = 1;
  let itemAwardsRemaining = 1;

  // ── Town: grant_tag ──────────────────────────────────────────────────
  // Registers only when (a) NPC is permitted, (b) we have a town context,
  // (c) the caller is NOT the town owner, (d) the catalog ships at least
  // one tag the NPC may grant. Owner gate: the public town's "owner" is
  // the company account; we don't want operators piling up first-contact
  // / convicted / roasted tags on themselves while sanity-checking NPCs.
  // The tool description embeds the NPC's whitelisted tag set + each
  // tag's authored "when to grant" hint, so the model has everything it
  // needs inline — no discovery tool.
  const tagGrant = permissions.town?.grant_tag;
  if (tagGrant && townCtx && !townCtx.isOwner && townCtx.catalog) {
    const allowedTagDefs = tagGrant.allowed_tag_ids
      .map((id) => findTag(townCtx.catalog!, id))
      .filter((t): t is NonNullable<typeof t> => !!t);

    if (allowedTagDefs.length > 0) {
      const allowedIds = new Set(allowedTagDefs.map((t) => t.id));
      const lines = allowedTagDefs.map(
        (t) =>
          `- ${t.id}  ${t.emoji} ${t.label} — ${t.description}` +
          (t.defaultTtlSeconds === null
            ? " (permanent)"
            : ` (expires after ${Math.round(t.defaultTtlSeconds / 3600)}h)`),
      );
      tools.grant_tag = tool({
        description: [
          "Award a tag to the visitor you're talking to. Tags float above the visitor's character in the overworld for other players to see — they're a visible reward for a moment in the conversation.",
          "Only grant when the visitor has clearly earned it per the tag's described trigger. Don't grant on small talk or as a greeting.",
          "",
          "Tags you may grant:",
          ...lines,
        ].join("\n"),
        inputSchema: z.object({
          tag_id: z.string().min(1).describe("One of the tag ids listed above."),
          reason: z
            .string()
            .max(200)
            .optional()
            .describe(
              "One short sentence explaining what the visitor did to earn this. Stored for audit, never shown.",
            ),
        }),
        async execute({ tag_id, reason }) {
          if (tagAwardsRemaining <= 0) {
            return { error: "award-limit-reached", detail: "one tag per turn" };
          }
          if (!allowedIds.has(tag_id)) {
            return { error: "tag-not-permitted", tag_id };
          }
          const def = findTag(townCtx.catalog!, tag_id);
          if (!def) return { error: "tag-not-in-catalog", tag_id };
          // Decrement before the write so a transient DB error doesn't
          // re-open the budget for a retry within the same turn.
          tagAwardsRemaining--;
          const expiresAt =
            def.defaultTtlSeconds === null
              ? null
              : new Date(Date.now() + def.defaultTtlSeconds * 1000);
          // Upsert — re-granting the same tag refreshes the expiry and
          // updates the awardedByNpc/reason audit. Idempotent for the
          // model so it can re-grant without polluting the row count.
          // We probe `existed` first so the activity feed only logs
          // on the FIRST award; re-grants are silent.
          const existed = await prisma.visitorTag.findUnique({
            where: {
              townSlug_subjectKey_tagId: {
                townSlug: townCtx.townSlug,
                subjectKey: townCtx.subjectKey,
                tagId: tag_id,
              },
            },
            select: { id: true },
          });
          await prisma.visitorTag.upsert({
            where: {
              townSlug_subjectKey_tagId: {
                townSlug: townCtx.townSlug,
                subjectKey: townCtx.subjectKey,
                tagId: tag_id,
              },
            },
            update: {
              awardedByNpc: townCtx.npcId,
              reason: reason ?? null,
              expiresAt,
            },
            create: {
              townSlug: townCtx.townSlug,
              subjectKey: townCtx.subjectKey,
              tagId: tag_id,
              awardedByNpc: townCtx.npcId,
              reason: reason ?? null,
              expiresAt,
            },
          });
          if (!existed) {
            void recordTownActivity({
              townSlug: townCtx.townSlug,
              kind: "tag_awarded",
              subjectKey: townCtx.subjectKey,
              subjectName: townCtx.subjectName,
              subjectCharacter: townCtx.subjectCharacter,
              metadata: {
                tagId: def.id,
                tagLabel: def.label,
                tagEmoji: def.emoji,
                npcId: townCtx.npcId,
                npcName: townCtx.npcName,
              },
            }).catch((e) =>
              console.warn("[town-activity] tag_awarded failed", e),
            );
          }
          return {
            ok: true,
            tag: {
              id: def.id,
              label: def.label,
              emoji: def.emoji,
              color: def.color,
              expiresAt: expiresAt?.toISOString() ?? null,
            },
          };
        },
      });
    }
  }

  // ── Town: give_item ──────────────────────────────────────────────────
  // Same gating shape as grant_tag — owners don't receive collectibles
  // from their own NPCs. The tool description inlines the field schema
  // for every template the NPC may issue so the model doesn't need a
  // discovery call.
  const itemGrant = permissions.town?.give_item;
  if (itemGrant && townCtx && !townCtx.isOwner && townCtx.catalog) {
    const allowedItemDefs = itemGrant.allowed_template_ids
      .map((id) => findItem(townCtx.catalog!, id))
      .filter((t): t is NonNullable<typeof t> => !!t);

    if (allowedItemDefs.length > 0) {
      const allowedTemplateIds = new Set(allowedItemDefs.map((t) => t.id));
      const lines = allowedItemDefs.map((it) => {
        const fieldSpec = it.fields
          .map((f) => `${f.name}≤${f.maxLength}`)
          .join(", ");
        return `- ${it.id}  "${it.label}" — ${it.description}\n    fields: { ${fieldSpec} }`;
      });
      tools.give_item = tool({
        description: [
          "Hand the visitor a collectible card. Cards are designer-made SVG templates with fillable text fields — the visitor receives a shareable image they can post or save to their inventory.",
          "Only issue when the conversation has reached a moment that calls for it (per the template's described trigger).",
          "",
          "Templates you may issue:",
          ...lines,
        ].join("\n"),
        inputSchema: z.object({
          template_id: z
            .string()
            .min(1)
            .describe("One of the template ids listed above."),
          // Accept primitive values (string / number / boolean / null).
          // Models routinely pass numeric values for fields like sentence
          // length ("sentence: 30") and a stricter z.record(string, string)
          // would reject them, surfacing as a bad-request error in the
          // chat. renderItemSvg coerces to a trimmed string at substitution
          // time; nulls become empty strings (and trip the field-empty
          // validator there).
          fields: z
            .record(
              z.string(),
              z.union([z.string(), z.number(), z.boolean(), z.null()]),
            )
            .describe(
              "Object mapping each template field name to its value. Values are HTML-escaped before substitution; respect each field's maxLength.",
            ),
        }),
        async execute({ template_id, fields }) {
          if (itemAwardsRemaining <= 0) {
            return { error: "award-limit-reached", detail: "one item per turn" };
          }
          if (!allowedTemplateIds.has(template_id)) {
            return { error: "template-not-permitted", template_id };
          }
          const def = findItem(townCtx.catalog!, template_id);
          if (!def) return { error: "template-not-in-catalog", template_id };
          // Coerce all values to strings for the renderer. null becomes ""
          // (which renderItemSvg will reject as empty), other primitives
          // are stringified.
          const stringFields: Record<string, string> = {};
          for (const [k, v] of Object.entries(fields)) {
            stringFields[k] = v === null || v === undefined ? "" : String(v);
          }
          const rendered = renderItemSvg(def, stringFields);
          if (rendered.issues.length > 0) {
            return {
              error: "field-validation-failed",
              issues: rendered.issues,
            };
          }
          // Decrement only after field validation passes — a bad-input
          // call shouldn't burn the budget, so the model can retry with
          // corrected fields within the same turn.
          itemAwardsRemaining--;
          // Persist only the field values, not the rendered SVG. The
          // share endpoint re-renders on demand against the current
          // catalog so a designer's SVG fix propagates to past cards.
          const row = await prisma.visitorItem.create({
            data: {
              townSlug: townCtx.townSlug,
              subjectKey: townCtx.subjectKey,
              templateId: template_id,
              fields: stringFields,
              awardedByNpc: townCtx.npcId,
            },
            select: { id: true },
          });
          void recordTownActivity({
            townSlug: townCtx.townSlug,
            kind: "item_awarded",
            subjectKey: townCtx.subjectKey,
            subjectName: townCtx.subjectName,
            subjectCharacter: townCtx.subjectCharacter,
            metadata: {
              itemId: row.id,
              templateId: def.id,
              templateLabel: def.label,
              npcId: townCtx.npcId,
              npcName: townCtx.npcName,
            },
          }).catch((e) =>
            console.warn("[town-activity] item_awarded failed", e),
          );
          const sharePath = `/items/${row.id}`;
          const share_url = townCtx.publicBaseUrl
            ? `${townCtx.publicBaseUrl.replace(/\/$/, "")}${sharePath}`
            : sharePath;
          return {
            ok: true,
            item_id: row.id,
            template_id,
            share_url,
          };
        },
      });
    }
  }

  return tools;
}

/**
 * Fetch lightweight metadata (id, title, description) for every skill
 * the NPC is allowed to `read_skill`. Returned list is the input to
 * buildNpcTools' `callableSkills` parameter — the route handler runs
 * this in parallel with loadInjectedSkills.
 *
 * Failures are silent per-id; a missing or deleted callable skill
 * just drops out of the model's "available skills" list rather than
 * breaking the chat. Returns [] when no callables, no owner token,
 * or every fetch failed.
 */
export async function loadCallableSkillMeta(
  ownerToken: string | null,
  permissions: NpcPermissions,
): Promise<CallableSkillMeta[]> {
  const ids = permissions.skills?.callable ?? [];
  if (ids.length === 0) return [];
  const ctxOrErr = makeContext(ownerToken);
  if ("error" in ctxOrErr) return [];

  // Parallel fetch — usually fewer than ~5 skills, no need to batch.
  const results = await Promise.all(
    ids.map(async (id) => {
      const res = (await coreFetch(
        ctxOrErr,
        `/api/v1/skills/${encodeURIComponent(id)}`,
      )) as { skill?: Record<string, unknown>; error?: string };
      if ("error" in res && res.error) return null;
      const skill = res.skill;
      if (!skill || typeof skill !== "object") return null;
      // Skill records carry either `description` (one-liner) or a
      // longer `content`. Prefer the explicit description; fall back
      // to the first ~140 chars of content so the model gets *some*
      // signal even when the author didn't write a summary.
      const explicit =
        typeof skill.description === "string" ? skill.description.trim() : "";
      const fallback =
        typeof skill.content === "string"
          ? skill.content.replace(/\s+/g, " ").slice(0, 140).trim()
          : "";
      return {
        id: typeof skill.id === "string" ? skill.id : id,
        title:
          typeof skill.title === "string" ? skill.title : "Untitled skill",
        description: explicit || fallback || "(no description)",
      } satisfies CallableSkillMeta;
    }),
  );
  return results.filter((r): r is CallableSkillMeta => r !== null);
}

/**
 * Fetch the content of skills the NPC should have preloaded into context.
 * The route handler appends the returned text to the system prompt so the
 * model "knows" these skills from turn 1 instead of having to call read_skill.
 *
 * Returns [] when nothing is configured, no owner token, or all fetches fail.
 * Failures are silent — a missing inject skill shouldn't break chat.
 */
export async function loadInjectedSkills(
  ownerToken: string | null,
  permissions: NpcPermissions,
): Promise<Array<{ id: string; title: string; content: string }>> {
  const ids = permissions.skills?.inject ?? [];
  if (ids.length === 0) return [];
  const ctxOrErr = makeContext(ownerToken);
  if ("error" in ctxOrErr) return [];
  const out: Array<{ id: string; title: string; content: string }> = [];
  for (const id of ids) {
    // CORE wraps single-skill GETs in { skill: {...} } — unwrap before
    // reading the content field.
    const res = (await coreFetch(
      ctxOrErr,
      `/api/v1/skills/${encodeURIComponent(id)}`,
    )) as { skill?: Record<string, unknown>; error?: string };
    if ("error" in res && res.error) continue;
    const skill = res.skill;
    if (!skill || typeof skill !== "object") continue;
    if (typeof skill.content !== "string") continue;
    out.push({
      id: typeof skill.id === "string" ? skill.id : id,
      title: typeof skill.title === "string" ? skill.title : "Skill",
      content: skill.content,
    });
  }
  return out;
}
