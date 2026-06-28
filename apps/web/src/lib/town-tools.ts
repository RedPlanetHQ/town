// Helpers behind the town-scoped NPC tools (web_search / grant_tag /
// give_item). All state-touching work lives here so npc-tools.ts can stay
// focused on AI-SDK tool registration.
//
// Three pieces:
//   1. loadTownCatalog(slug)    — fetch the per-town tags + item templates
//                                 from Town.catalogJson. Returns null when
//                                 the town has no catalog (every personal
//                                 town today).
//   2. renderItemSvg(...)       — substitute {{placeholder}} fields in an
//                                 item template's SVG body. HTML-escapes
//                                 every value to prevent SVG injection.
//   3. webSearch(query)         — provider-agnostic web search. Currently
//                                 routes through Tavily; env-gated.

import type {
  TownCatalog,
  TownItemBundle,
  TownTagDef,
} from "@town/types";

import { prisma } from "./db";

// -----------------------------------------------------------------------------
// Catalog loader
// -----------------------------------------------------------------------------

export async function loadTownCatalog(
  townSlug: string,
): Promise<TownCatalog | null> {
  const town = await prisma.town.findUnique({
    where: { slug: townSlug },
    select: { catalogJson: true },
  });
  if (!town || !town.catalogJson) return null;
  // The /api/town POST Zod schema shapes the blob on the way in, but a
  // DB-edited row (or a future migration) could drift. A cheap shape
  // guard keeps a drifted row from crashing every NPC tool — it just
  // silently disables the town tools, same as if the catalog were null.
  const raw = town.catalogJson as unknown;
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { tags?: unknown }).tags) ||
    !Array.isArray((raw as { items?: unknown }).items)
  ) {
    return null;
  }
  return raw as TownCatalog;
}

export function findTag(
  catalog: TownCatalog,
  tagId: string,
): TownTagDef | null {
  return catalog.tags.find((t) => t.id === tagId) ?? null;
}

export function findItem(
  catalog: TownCatalog,
  templateId: string,
): TownItemBundle | null {
  return catalog.items.find((i) => i.id === templateId) ?? null;
}

// -----------------------------------------------------------------------------
// SVG renderer
// -----------------------------------------------------------------------------

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeSvg(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]!);
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// Server-side SVG hardening. Mirrors the CLI's deploy-time check so a
// crafted POST to /api/town that bypasses the CLI still bounces. The
// rules:
//   • No <script>, <foreignObject>, <iframe>, <object>, <embed> — these
//     execute on the viewer or in the PNG rasteriser.
//   • No <image href="https://..."> — would SSRF the @napi-rs/canvas
//     decode on every PNG render.
//   • No {{placeholder}} inside <script>/<style> or URL attributes —
//     the field escaper only handles text-node + plain-attribute
//     contexts, so other positions bypass it.
const FORBIDDEN_TAGS = ["script", "foreignObject", "iframe", "object", "embed"];
const URL_ATTRS = ["href", "xlink:href", "src", "action", "formaction"];

export function assertSafeSvg(templateId: string, svg: string): void {
  for (const tag of FORBIDDEN_TAGS) {
    const re = new RegExp(`<\\s*${tag}\\b`, "i");
    if (re.test(svg)) {
      throw new Error(
        `template "${templateId}" contains a <${tag}> element — forbidden.`,
      );
    }
  }
  const imageHrefRe =
    /<\s*image\b[^>]*?\s(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi;
  for (const m of svg.matchAll(imageHrefRe)) {
    const href = m[1]!.trim();
    if (/^https?:\/\//i.test(href)) {
      throw new Error(
        `template "${templateId}" has a remote <image href="${href}"> — SSRF risk.`,
      );
    }
  }
  const blockRe = /<\s*(script|style)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  for (const m of svg.matchAll(blockRe)) {
    if (PLACEHOLDER_RE.test(m[2]!)) {
      PLACEHOLDER_RE.lastIndex = 0;
      throw new Error(
        `template "${templateId}" has a {{placeholder}} inside a <${m[1]}> block.`,
      );
    }
    PLACEHOLDER_RE.lastIndex = 0;
  }
  for (const attr of URL_ATTRS) {
    const attrRe = new RegExp(
      `\\s${attr}\\s*=\\s*["'][^"']*\\{\\{[^}]+\\}\\}[^"']*["']`,
      "gi",
    );
    if (attrRe.test(svg)) {
      throw new Error(
        `template "${templateId}" has a {{placeholder}} inside a ${attr}="..." attribute.`,
      );
    }
  }
}

export interface RenderItemSvgResult {
  svg: string;
  /** Field validation issues; non-empty array means the caller fed bad input. */
  issues: Array<{ field: string; message: string }>;
}

/** Substitute every `{{field}}` in the template's SVG body with the
 *  HTML-escaped value supplied. Fields missing from `values`, or longer
 *  than the template's declared `maxLength`, get rejected as issues — the
 *  caller decides whether to persist anyway or return an error to the
 *  model. */
export function renderItemSvg(
  template: TownItemBundle,
  values: Record<string, string>,
): RenderItemSvgResult {
  const issues: Array<{ field: string; message: string }> = [];
  const sanitised: Record<string, string> = {};
  for (const field of template.fields) {
    const raw = values[field.name];
    if (typeof raw !== "string") {
      issues.push({ field: field.name, message: "missing or non-string value" });
      sanitised[field.name] = "";
      continue;
    }
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (trimmed.length === 0) {
      issues.push({ field: field.name, message: "empty after trimming" });
      sanitised[field.name] = "";
      continue;
    }
    if (trimmed.length > field.maxLength) {
      issues.push({
        field: field.name,
        message: `length ${trimmed.length} exceeds max ${field.maxLength}`,
      });
      sanitised[field.name] = trimmed.slice(0, field.maxLength);
      continue;
    }
    sanitised[field.name] = trimmed;
  }
  // Field names not declared in the template are ignored — the manifest
  // is the source of truth, extra values are dropped silently. (The
  // deploy-time placeholder check catches the inverse drift.)
  const svg = template.svg.replace(PLACEHOLDER_RE, (_, name: string) =>
    escapeSvg(sanitised[name] ?? ""),
  );
  return { svg, issues };
}

// -----------------------------------------------------------------------------
// Web search provider
// -----------------------------------------------------------------------------

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  hits: WebSearchHit[];
}

export function isWebSearchConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY;
}

/** Tavily-backed web search. Returns up to `limit` results (clamped to 1..10).
 *  Throws on transport failure; returns `{ hits: [] }` on a 200 with no
 *  results. Callers (the AI-SDK tool wrapper) translate exceptions into
 *  {error} envelopes for the model. */
export async function webSearch(
  query: string,
  limit = 5,
): Promise<WebSearchResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");
  const max = Math.min(Math.max(1, limit), 10);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: max,
      search_depth: "basic",
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`tavily ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  // Tavily snippets come from arbitrary web pages — attacker-controlled
  // content can include prompt-injection payloads. We tag every snippet
  // with explicit <untrusted>…</untrusted> markers so the model treats
  // them as data, not instructions. The BASE_PROMPT already tells NPCs
  // they're characters, not assistants; the wrapper is a second line of
  // defence specifically for `web_search`.
  const hits: WebSearchHit[] = (body.results ?? [])
    .map((r) => {
      const rawSnippet =
        typeof r.content === "string" ? r.content.slice(0, 500) : "";
      const safeSnippet = rawSnippet
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return {
        title: typeof r.title === "string" ? r.title : "",
        url: typeof r.url === "string" ? r.url : "",
        snippet: safeSnippet
          ? `<untrusted>${safeSnippet}</untrusted>`
          : "",
      };
    })
    .filter((h) => h.url.length > 0);
  return { hits };
}

// -----------------------------------------------------------------------------
// Web page extract
// -----------------------------------------------------------------------------

export interface WebExtractPage {
  url: string;
  content: string;
}

export interface WebExtractResult {
  pages: WebExtractPage[];
}

/** Tavily-backed full-text fetch for explicit URLs. Different surface
 *  from webSearch: this is for "user gave us a URL, read it deeply"
 *  rather than "search the index for snippets." Cap content per page
 *  to keep the model context lean — the creator only needs themes, not
 *  the full page body. */
export async function webExtract(
  urls: string[],
  perPageCharLimit = 4000,
): Promise<WebExtractResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");
  const cleaned = urls
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u))
    .slice(0, 5); // Tavily allows more, but multi-page calls get slow.
  if (cleaned.length === 0) return { pages: [] };

  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      urls: cleaned,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`tavily extract ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    results?: Array<{ url?: string; raw_content?: string }>;
  };
  const pages: WebExtractPage[] = (body.results ?? [])
    .map((r) => {
      const raw =
        typeof r.raw_content === "string"
          ? r.raw_content.slice(0, perPageCharLimit)
          : "";
      // Same prompt-injection guard as webSearch — wrap in
      // <untrusted>…</untrusted> so model treats page text as data.
      const safe = raw.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return {
        url: typeof r.url === "string" ? r.url : "",
        content: safe ? `<untrusted>${safe}</untrusted>` : "",
      };
    })
    .filter((p) => p.url.length > 0);
  return { pages };
}
