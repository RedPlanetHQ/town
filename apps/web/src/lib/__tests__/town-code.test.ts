import { describe, it, expect } from "vitest";
import {
  normalizeSlug,
  isValidSlug,
  generateShareCode,
  normalizeCode,
  visitorCookieName,
  parseVisitorCookie,
} from "../town-code";

describe("normalizeSlug", () => {
  it("lowercases and trims", () => {
    expect(normalizeSlug("  MyTown  ")).toBe("mytown");
  });

  it("replaces runs of invalid characters with a single hyphen", () => {
    expect(normalizeSlug("My Cool Town!")).toBe("my-cool-town");
    expect(normalizeSlug("a__b..c")).toBe("a-b-c");
  });

  it("collapses consecutive hyphens", () => {
    expect(normalizeSlug("a---b")).toBe("a-b");
  });

  it("strips leading and trailing hyphens", () => {
    expect(normalizeSlug("-town-")).toBe("town");
    expect(normalizeSlug("!!town!!")).toBe("town");
  });

  it("caps the result at 32 characters", () => {
    expect(normalizeSlug("x".repeat(40))).toBe("x".repeat(32));
  });

  it("returns empty string when nothing valid remains", () => {
    expect(normalizeSlug("!!!")).toBe("");
  });
});

describe("isValidSlug", () => {
  it("accepts a normal slug", () => {
    expect(isValidSlug("my-town")).toBe(true);
    expect(isValidSlug("ab")).toBe(true);
    expect(isValidSlug("a1-b2")).toBe(true);
  });

  it("enforces the 2-32 length bounds", () => {
    expect(isValidSlug("a")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("x".repeat(32))).toBe(true);
    expect(isValidSlug("x".repeat(33))).toBe(false);
  });

  it("rejects reserved route segments", () => {
    for (const reserved of ["api", "auth", "onboarding", "_next", "public"]) {
      expect(isValidSlug(reserved)).toBe(false);
    }
  });

  it("rejects uppercase and invalid characters", () => {
    expect(isValidSlug("My-Town")).toBe(false);
    expect(isValidSlug("my_town")).toBe(false);
    expect(isValidSlug("my town")).toBe(false);
  });

  it("rejects leading or trailing hyphens", () => {
    expect(isValidSlug("-town")).toBe(false);
    expect(isValidSlug("town-")).toBe(false);
  });
});

describe("generateShareCode", () => {
  it("returns 6 characters from the Crockford alphabet (no I/L/O/U)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateShareCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });
});

describe("normalizeCode", () => {
  it("uppercases and trims", () => {
    expect(normalizeCode("  abc123  ")).toBe("ABC123");
  });

  it("strips separators and other non-alphanumerics", () => {
    expect(normalizeCode("ab-12 3")).toBe("AB123");
  });
});

describe("visitorCookieName", () => {
  it("is namespaced per slug", () => {
    expect(visitorCookieName("my-town")).toBe("town-visit-my-town");
  });
});

describe("parseVisitorCookie", () => {
  const valid = { n: "Ada", c: "ABC123", ch: "wizard", g: "guest-1" };

  it("parses a well-formed cookie", () => {
    expect(parseVisitorCookie(JSON.stringify(valid))).toEqual(valid);
  });

  it("returns null for a missing cookie", () => {
    expect(parseVisitorCookie(undefined)).toBeNull();
    expect(parseVisitorCookie("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseVisitorCookie("{not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseVisitorCookie('"just a string"')).toBeNull();
    expect(parseVisitorCookie("[1,2,3]")).toBeNull();
  });

  it("returns null when any field is missing or empty", () => {
    for (const key of ["n", "c", "ch", "g"] as const) {
      const missing: Record<string, string> = { ...valid };
      delete missing[key];
      expect(parseVisitorCookie(JSON.stringify(missing))).toBeNull();

      const empty = { ...valid, [key]: "" };
      expect(parseVisitorCookie(JSON.stringify(empty))).toBeNull();
    }
  });

  it("returns null when a field has the wrong type", () => {
    expect(parseVisitorCookie(JSON.stringify({ ...valid, n: 42 }))).toBeNull();
  });

  it("drops unknown extra fields", () => {
    expect(
      parseVisitorCookie(JSON.stringify({ ...valid, evil: "payload" })),
    ).toEqual(valid);
  });
});
