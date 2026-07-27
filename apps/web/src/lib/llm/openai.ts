// OpenAI provider for the LLM router.
//
// Two version-mismatch traps we deliberately avoid:
//
// 1. OpenAI's `zodTextFormat` helper is pinned to Zod v3's surface. Our
//    curator schema lives in Zod v4 (because Anthropic's helper requires
//    v4). Passing the v4 schema through `zodTextFormat` produces a
//    malformed JSON schema and a 400 from the API. We bypass the helper
//    and convert via Zod v4's built-in `z.toJSONSchema()`.
//
// 2. OpenAI strict structured-output mode rejects open dictionaries
//    (`additionalProperties` other than `false`). The curator schema is
//    array-of-pairs for this reason — see lib/curator/schema.ts.
//
// We use `responses.create()` rather than `.parse()` because `.parse()`
// requires the SDK's auto-parseable format object produced by
// `zodTextFormat`. Since we're hand-building the JSON schema, we receive
// `output_text` and validate it ourselves with the same Zod schema.
//
// OpenAI auto-caches prompts >=1024 tokens with no opt-in, so the system
// text goes into `instructions` (the stable cacheable prefix) and the
// volatile per-call payload goes into `input`.

import OpenAI from "openai";
import { z } from "zod/v4";
import type { RunStructuredArgs, RunStructuredResult } from "./types";

// Truly lazy: the SDK throws at construction if OPENAI_API_KEY is unset.
// Next.js page-data collection imports this module at build time even on
// Anthropic-default deploys, so defer until first call.
//
// If OPENAI_BASE_URL is set, we route through an OpenAI-compatible proxy
// (e.g. LiteLLM, Vercel AI Gateway) using OPENAI_API_KEY as the security
// key sent to the proxy. Matches the pattern in core's model.server.ts.
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client === null) {
    const baseURL = process.env.OPENAI_BASE_URL?.trim();
    _client = new OpenAI(baseURL ? { baseURL } : undefined);
  }
  return _client;
}

export async function runStructuredOpenAI<T>(
  args: RunStructuredArgs<T>,
  model: string,
): Promise<RunStructuredResult<T>> {
  // Convert Zod v4 → JSON Schema. The result already has type/properties/
  // required/additionalProperties shaped for OpenAI strict mode because
  // the schema in curator/schema.ts uses .strict() at every level.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonSchema = z.toJSONSchema(args.zodSchema as any) as Record<
    string,
    unknown
  >;

  const response = await getClient().responses.create({
    model,
    instructions: args.system,
    input: args.user,
    text: {
      format: {
        type: "json_schema",
        name: `${args.taskKind}_output`,
        strict: true,
        schema: jsonSchema,
      },
    },
  });

  // `output_text` is the concatenated text content. With a structured
  // output format, this is JSON we can parse.
  const text = response.output_text;
  if (!text) {
    throw new Error("OpenAI returned no output_text");
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `OpenAI structured output was not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Validate with the same Zod schema. If OpenAI's schema engine did its
  // job this is a no-op; if it didn't, the throw is our safety net.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (args.zodSchema as any).parse(json) as T;

  return {
    parsed,
    usage: response.usage,
    providerUsed: "openai",
  };
}
