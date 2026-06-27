// Parses the Vercel AI SDK UI Message Stream (SSE wire format) from
// `/api/creator` into the discrete chunk types the chat UI consumes.
//
// We hand-roll the SSE parse instead of using `readUIMessageStream` from
// `ai` because the helper assembles into a UIMessage (good for chat
// transcripts, lossy for a TUI that wants to render each chunk as it
// arrives — tool calls in particular flicker if we wait for the message
// to settle). Manual parsing keeps every `text-delta`, `tool-input-*`,
// and `tool-output-*` event individually addressable.
//
// Wire shape: standard SSE — each event is `data: <JSON>\n\n` and the
// JSON body is one UIMessageChunk variant. The stream ends with a
// `data: [DONE]\n\n` sentinel.

export type StreamChunk =
  | { type: "start"; messageId?: string }
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "finish" }
  | { type: "abort"; reason?: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | {
      type: "tool-input-start";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool-input-delta";
      toolCallId: string;
      inputTextDelta: string;
    }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool-output-available";
      toolCallId: string;
      output: unknown;
    }
  | {
      type: "tool-output-error";
      toolCallId: string;
      errorText: string;
    }
  | { type: "error"; errorText: string };

export interface PostCreatorOpts {
  townUrl: string;
  pat: string;
  townSlug: string;
  message: string;
  signal?: AbortSignal;
}

export interface CreatorStreamResult {
  conversationId: string | null;
  chunks: AsyncIterable<StreamChunk>;
}

/** POST /api/creator and return an async iterator of parsed chunks plus
 *  the `x-conversation-id` header value the server stamps on the
 *  response. */
export async function streamCreator(
  opts: PostCreatorOpts,
): Promise<CreatorStreamResult> {
  const res = await fetch(`${opts.townUrl}/api/creator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.pat}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      townSlug: opts.townSlug,
      message: opts.message,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /api/creator → ${res.status} ${text}`);
  }
  if (!res.body) {
    throw new Error("POST /api/creator returned an empty body");
  }
  const conversationId = res.headers.get("x-conversation-id");
  return {
    conversationId,
    chunks: parseSseStream(res.body),
  };
}

/** Generic SSE → JSON-chunk iterator. The UI message stream encodes one
 *  chunk per `data:` event with `[DONE]` as the terminator. We tolerate
 *  the (rare) keep-alive `:` comment lines too. */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamChunk> {
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const chunk = parseEvent(event);
        if (chunk) yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(event: string): StreamChunk | null {
  // SSE event = one or more lines. We only care about `data:` lines and
  // we ignore comments (`:` prefix) + bare `event:` lines.
  const lines = event.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      data += line.slice(5).replace(/^ /, "");
    }
  }
  if (!data) return null;
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as StreamChunk;
  } catch {
    return null;
  }
}
