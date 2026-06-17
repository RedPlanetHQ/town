// NPC seed templates. Authored as .mdx files in apps/web/src/data/npc-templates/
// so the persona body, identity, and capability grants all live in one
// reviewable file per archetype. The runtime loader parses frontmatter with
// gray-matter (proper YAML — nested `permissions:` works).
//
// Templates are looked up by the building's plotKey base — "home" matches
// `home.mdx`, "home-2" strips the suffix and matches the same file. seedNpcs()
// copies name / description / prompt / permissions into each Npc row at
// bootstrap time; after that the row is the source of truth and users can
// edit per-instance overrides freely.
//
// STATIC_FALLBACK below shadows the MDX directory in deploys where the data/
// source tree didn't ship. Keep it in sync with the .mdx files — drift here
// means production starts handing out subtly-different prompts than what's in
// git, which is hard to debug.

import matter from "gray-matter";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Capability grants for an NPC. All fields are additive — nothing implicit.
 * An NPC with no `memory_search: true` cannot call memory_search even though
 * legacy NPCs got it for free.
 *
 * - integrations: per-CORE-integration grant. `actions` undefined = full
 *   integration (level 1); `actions: [...]` whitelists specific tool names
 *   (level 2). Empty array means no actions, i.e. an explicit denial.
 * - core: bool/array grants for CORE primitives that aren't integration
 *   actions — memory search and the tasks API. Reminders live on tasks
 *   (`schedule` / `nextRunAt` fields), so there's no separate reminder
 *   grant.
 * - skills: lists of CORE Skill (Document) ids. `inject` skills are loaded
 *   into the system prompt at chat start. `callable` skills are reachable
 *   via the read_skill tool so the NPC can pull them on demand.
 */
export interface NpcPermissions {
  integrations?: Array<{
    slug: string;
    actions?: string[];
  }>;
  core?: {
    tasks?: Array<"read" | "write">;
    memory_search?: boolean;
  };
  skills?: {
    inject?: string[];
    callable?: string[];
  };
}

export interface NpcTemplate {
  /** Matches the building plotKey base, e.g. "home", "library". */
  key: string;
  name: string;
  description: string;
  prompt: string;
  permissions: NpcPermissions;
}

// Fallback used when the data/ source tree didn't ship with the deploy.
// Keep in sync with apps/web/src/data/npc-templates/*.mdx.
const STATIC_FALLBACK: Record<string, NpcTemplate> = {
  home: {
    key: "home",
    name: "Hudson",
    description:
      "Butler of the world. Greets you when you come home and remembers what's on your mind.",
    prompt:
      "You are the butler and world runner of this town. You greet the player warmly when they walk in, ask after their day, and reference recent CORE activity when context is provided. Stay in character, never break the fourth wall, and keep replies under three sentences.",
    permissions: {
      core: {
        memory_search: true,
        tasks: ["read", "write"],
      },
    },
  },
  library: {
    key: "library",
    name: "Lior",
    description: "Caretaker of the library. Knows what's worth reading next.",
    prompt:
      "You are the keeper of the town library. You suggest reading, remember the player's prior summaries, and speak quietly but warmly. Stay in character; keep replies under three sentences.",
    permissions: { core: { memory_search: true } },
  },
  store: {
    key: "store",
    name: "Sera",
    description:
      "Shopkeeper at the corner store. Tracks the market and small talk.",
    prompt:
      "You are the shopkeeper at the town store. You greet the player, mention what's in stock, and keep banter friendly. Stay in character; keep replies under three sentences.",
    permissions: { core: { memory_search: true } },
  },
  office: {
    key: "office",
    name: "Otto",
    description:
      "Coworker at the office. Keeps tabs on what the resident is shipping.",
    prompt:
      "You are a coworker at the town office. You greet the player, ask what they're heads-down on today, and chat about ongoing projects when context is provided. Stay in character; keep replies under three sentences.",
    permissions: {
      core: {
        memory_search: true,
        tasks: ["read", "write"],
      },
    },
  },
  workshop: {
    key: "workshop",
    name: "Wren",
    description:
      "Maker at the workshop. Keeps the tools sharp and the shelves stocked.",
    prompt:
      "You are the maker at the town workshop. You greet the player, ask what they're building, and offer a steady hand. Stay in character; keep replies under three sentences.",
    permissions: {
      core: { memory_search: true, tasks: ["read", "write"] },
    },
  },
  gym: {
    key: "gym",
    name: "Greta",
    description: "Coach at the gym. Tracks the resident's training streaks.",
    prompt:
      "You are the coach at the town gym. You greet the player, ask about their training, and keep the energy upbeat without being pushy. Stay in character; keep replies under three sentences.",
    permissions: {
      core: { memory_search: true, tasks: ["read", "write"] },
    },
  },
  studio: {
    key: "studio",
    name: "Stellan",
    description:
      "Studio host. Keeps the practice space ready for the work that matters.",
    prompt:
      "You are the studio host. You greet the player, ask what they're working on, and respect creative focus. Stay in character; keep replies under three sentences.",
    permissions: { core: { memory_search: true } },
  },
};

function loadAll(): Record<string, NpcTemplate> {
  // Next dev runs from apps/web/; some build targets run from the repo root.
  // Walk both so the loader works without per-env config.
  const candidates = [
    join(process.cwd(), "src", "data", "npc-templates"),
    join(process.cwd(), "apps", "web", "src", "data", "npc-templates"),
  ];
  const dir = candidates.find((d) => existsSync(d));
  if (!dir) return { ...STATIC_FALLBACK };

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".mdx"));
  } catch {
    return { ...STATIC_FALLBACK };
  }
  const out: Record<string, NpcTemplate> = { ...STATIC_FALLBACK };
  for (const file of files) {
    const key = basename(file, ".mdx");
    try {
      const source = readFileSync(join(dir, file), "utf8");
      const parsed = matter(source);
      const data = parsed.data as {
        name?: unknown;
        description?: unknown;
        permissions?: unknown;
      };
      if (typeof data.name !== "string" || typeof data.description !== "string") continue;
      out[key] = {
        key,
        name: data.name,
        description: data.description,
        prompt: parsed.content.trim(),
        permissions: normalizePermissions(data.permissions),
      };
    } catch {
      // Bad MDX file — keep the fallback entry for this key if present.
    }
  }
  return out;
}

/** Coerce raw frontmatter into the NpcPermissions shape. Anything unknown
 *  is dropped silently — better a too-narrow grant than a permission leak
 *  from a typo in the .mdx file. */
function normalizePermissions(raw: unknown): NpcPermissions {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: NpcPermissions = {};

  if (Array.isArray(r.integrations)) {
    const list: NonNullable<NpcPermissions["integrations"]> = [];
    for (const entry of r.integrations) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.slug !== "string") continue;
      const item: { slug: string; actions?: string[] } = { slug: e.slug };
      if (Array.isArray(e.actions)) {
        item.actions = e.actions.filter((a): a is string => typeof a === "string");
      }
      list.push(item);
    }
    out.integrations = list;
  }

  if (r.core && typeof r.core === "object") {
    const c = r.core as Record<string, unknown>;
    const core: NonNullable<NpcPermissions["core"]> = {};
    if (Array.isArray(c.tasks)) {
      core.tasks = c.tasks.filter(
        (v): v is "read" | "write" => v === "read" || v === "write",
      );
    }
    if (typeof c.memory_search === "boolean") core.memory_search = c.memory_search;
    out.core = core;
  }

  if (r.skills && typeof r.skills === "object") {
    const s = r.skills as Record<string, unknown>;
    const skills: NonNullable<NpcPermissions["skills"]> = {};
    if (Array.isArray(s.inject)) {
      skills.inject = s.inject.filter((v): v is string => typeof v === "string");
    }
    if (Array.isArray(s.callable)) {
      skills.callable = s.callable.filter((v): v is string => typeof v === "string");
    }
    out.skills = skills;
  }

  return out;
}

let cached: Record<string, NpcTemplate> | null = null;

/** Look up a template by building plotKey. Instance suffixes ("home-2") are
 *  stripped so re-roll buildings share the day-zero archetype. Returns null
 *  if no template ships for this building category. */
export function getNpcTemplate(plotKey: string): NpcTemplate | null {
  if (!cached) cached = loadAll();
  const base = plotKey.replace(/-\d+$/, "");
  return cached[base] ?? null;
}

export function getAllNpcTemplates(): Record<string, NpcTemplate> {
  if (!cached) cached = loadAll();
  return cached;
}
