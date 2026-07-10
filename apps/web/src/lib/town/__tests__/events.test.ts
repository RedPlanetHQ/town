import { describe, it, expect, vi } from "vitest";

// `@town/db` instantiates PrismaClient at import time; the functions under
// test (signBody / verifyHmac / parseEnvelope) never touch it, so stub the
// module to keep this suite free of any generated-client / DB dependency.
vi.mock("@town/db", () => ({ prisma: {} }));

import { signBody, verifyHmac, parseEnvelope } from "../events";

const SECRET = "test-webhook-secret";
const BODY = '{"hello":"town"}';

describe("signBody", () => {
  it("produces the expected hex-encoded sha256 HMAC", () => {
    expect(signBody(SECRET, BODY)).toBe(
      "0393e476a462db2573b47f3e5653ce7339dde121d315a556e9b147ba4104b879",
    );
  });

  it("is deterministic for the same secret and body", () => {
    expect(signBody(SECRET, BODY)).toBe(signBody(SECRET, BODY));
  });

  it("changes when the secret or body changes", () => {
    expect(signBody("other-secret", BODY)).not.toBe(signBody(SECRET, BODY));
    expect(signBody(SECRET, BODY + " ")).not.toBe(signBody(SECRET, BODY));
  });
});

describe("verifyHmac", () => {
  it("accepts a valid signature", () => {
    expect(verifyHmac(BODY, signBody(SECRET, BODY), SECRET)).toBe(true);
  });

  it("rejects a signature over a tampered body", () => {
    const signature = signBody(SECRET, BODY);
    expect(verifyHmac('{"hello":"hacked"}', signature, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyHmac(BODY, signBody("wrong-secret", BODY), SECRET)).toBe(
      false,
    );
  });

  it("rejects an empty signature", () => {
    expect(verifyHmac(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    expect(verifyHmac(BODY, "abc123", SECRET)).toBe(false);
  });

  it("rejects a same-length signature that is not valid hex", () => {
    expect(verifyHmac(BODY, "z".repeat(64), SECRET)).toBe(false);
  });
});

describe("parseEnvelope", () => {
  const topic = {
    id: "topic-1",
    name: "gardening",
    count: 3,
    similar: [{ id: "topic-2", name: "plants", count: 1, score: 0.9 }],
  };

  const addedEnvelope = () => ({
    id: "evt-1",
    userId: "user-1",
    type: "memory.added",
    occurredAt: "2026-07-07T00:00:00.000Z",
    version: 1,
    payload: {
      memoryUuid: "mem-1",
      summary: "planted tomatoes",
      identityAspects: ["gardener"],
      topics: [topic],
    },
  });

  const updatedEnvelope = () => ({
    ...addedEnvelope(),
    type: "memory.updated",
    payload: {
      memoryUuid: "mem-1",
      summary: "planted more tomatoes",
      identityAspects: ["gardener"],
      topicsAdded: [topic],
    },
  });

  it("accepts a valid memory.added envelope", () => {
    const raw = addedEnvelope();
    const parsed = parseEnvelope(raw);
    expect(parsed.id).toBe("evt-1");
    expect(parsed.userId).toBe("user-1");
    expect(parsed.type).toBe("memory.added");
    expect(parsed.version).toBe(1);
    expect(parsed.payload).toEqual(raw.payload);
  });

  it("accepts a valid memory.updated envelope", () => {
    expect(parseEnvelope(updatedEnvelope()).type).toBe("memory.updated");
  });

  it("rejects a non-object envelope", () => {
    expect(() => parseEnvelope(null)).toThrow(/must be an object/);
    expect(() => parseEnvelope("string")).toThrow(/must be an object/);
    expect(() => parseEnvelope([1, 2])).toThrow(/must be an object/);
  });

  it("rejects missing or empty ids", () => {
    expect(() => parseEnvelope({ ...addedEnvelope(), id: "" })).toThrow(
      /envelope\.id/,
    );
    expect(() => parseEnvelope({ ...addedEnvelope(), userId: 7 })).toThrow(
      /envelope\.userId/,
    );
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      parseEnvelope({ ...addedEnvelope(), type: "memory.deleted" }),
    ).toThrow(/unknown envelope\.type/);
  });

  it("rejects a version other than 1", () => {
    expect(() => parseEnvelope({ ...addedEnvelope(), version: 2 })).toThrow(
      /version must be 1/,
    );
  });

  it("rejects a non-ISO occurredAt", () => {
    expect(() =>
      parseEnvelope({ ...addedEnvelope(), occurredAt: "not-a-date" }),
    ).toThrow(/occurredAt/);
  });

  it("rejects a payload missing memoryUuid", () => {
    const raw = addedEnvelope();
    const { memoryUuid: _drop, ...payload } = raw.payload;
    expect(() => parseEnvelope({ ...raw, payload })).toThrow(/memoryUuid/);
  });

  it("rejects a non-string summary", () => {
    const raw = addedEnvelope();
    expect(() =>
      parseEnvelope({ ...raw, payload: { ...raw.payload, summary: 42 } }),
    ).toThrow(/summary/);
  });

  it("rejects identityAspects containing non-strings", () => {
    const raw = addedEnvelope();
    expect(() =>
      parseEnvelope({
        ...raw,
        payload: { ...raw.payload, identityAspects: ["ok", 5] },
      }),
    ).toThrow(/identityAspects\[1\]/);
  });

  it("rejects memory.added without a topics array", () => {
    const raw = addedEnvelope();
    const { topics: _drop, ...payload } = raw.payload;
    expect(() => parseEnvelope({ ...raw, payload })).toThrow(/topics/);
  });

  it("rejects memory.updated without a topicsAdded array", () => {
    const raw = updatedEnvelope();
    const { topicsAdded: _drop, ...payload } = raw.payload;
    expect(() => parseEnvelope({ ...raw, payload })).toThrow(/topicsAdded/);
  });

  it("rejects a malformed topic", () => {
    const raw = addedEnvelope();
    expect(() =>
      parseEnvelope({
        ...raw,
        payload: { ...raw.payload, topics: [{ ...topic, count: "3" }] },
      }),
    ).toThrow(/count must be a finite number/);
  });

  it("rejects a malformed topic sibling", () => {
    const raw = addedEnvelope();
    expect(() =>
      parseEnvelope({
        ...raw,
        payload: {
          ...raw.payload,
          topics: [{ ...topic, similar: [{ id: "x", name: "y", count: 1 }] }],
        },
      }),
    ).toThrow(/score must be a finite number/);
  });
});
