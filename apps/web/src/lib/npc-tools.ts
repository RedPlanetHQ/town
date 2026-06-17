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

import type { NpcPermissions } from "./npc-templates";

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
    return { error: `core ${res.status}`, detail: text.slice(0, 500) };
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: "core-bad-json", detail: text.slice(0, 500) };
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

/**
 * Build the AI-SDK tools object for an NPC chat turn.
 *
 * - `ownerToken` may be null when the resident hasn't linked CORE; in that
 *   case every tool returns {error: "no-owner-token"} and the model falls
 *   back to common sense.
 * - `permissions` is the NPC's grant. Tools not granted are not present on
 *   the returned object — the model literally cannot see them.
 */
export function buildNpcTools(
  ownerToken: string | null,
  permissions: NpcPermissions,
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
    tools.read_skill = tool({
      description:
        "Read a CORE skill (a stored playbook / workflow / persona document) by id. " +
        "Returns the skill record including its `content` field. Use to load detailed " +
        "instructions on demand.",
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

  return tools;
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
