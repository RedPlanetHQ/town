import type { PassportData, PassportStamp } from "./types";

const SAMPLE_TOWNS: Array<{ slug: string; name: string }> = [
  { slug: "core-town",       name: "CORE TOWN" },
  { slug: "murder-mystery",  name: "MYSTERY" },
  { slug: "startup",         name: "STARTUP" },
  { slug: "roast-town",      name: "ROAST" },
  { slug: "interview",       name: "INTERVIEW" },
  { slug: "tenkai",          name: "TENKAI" },
  { slug: "cafe-verde",      name: "CAFE VERDE" },
  { slug: "harbor",          name: "HARBOR" },
  { slug: "atelier",         name: "ATELIER" },
  { slug: "arcadia",         name: "ARCADIA" },
  { slug: "gilded-fox",      name: "GILDED FOX" },
  { slug: "nightingale",     name: "NIGHTINGALE" },
  { slug: "cinder-hall",     name: "CINDER HALL" },
  { slug: "kite-park",       name: "KITE PARK" },
  { slug: "aurora",          name: "AURORA" },
  { slug: "wren-and-tide",   name: "WREN & TIDE" },
  { slug: "opal-street",     name: "OPAL STREET" },
  { slug: "moss-and-marrow", name: "MOSS + MARROW" },
  { slug: "the-loom",        name: "THE LOOM" },
  { slug: "riverbend",       name: "RIVERBEND" },
  { slug: "small-hours",     name: "SMALL HOURS" },
  { slug: "polis",           name: "POLIS" },
  { slug: "harborlight",     name: "HARBORLIGHT" },
  { slug: "the-boneyard",    name: "BONEYARD" },
  { slug: "clockwork",       name: "CLOCKWORK" },
  { slug: "seagrass",        name: "SEAGRASS" },
  { slug: "silverwood",      name: "SILVERWOOD" },
  { slug: "old-post",        name: "OLD POST" },
];

/**
 * Produce a deterministic sample passport with `stampCount` stamps.
 * Used by the preview + pdf demo routes so we can render before the
 * Passport DB model lands.
 */
export function sampleData(stampCount: number, displayName = "Harshith Mullapudi"): PassportData {
  const base = new Date(Date.UTC(2026, 6, 12));
  const stamps: PassportStamp[] = Array.from({ length: stampCount }, (_, i) => {
    const town = SAMPLE_TOWNS[i % SAMPLE_TOWNS.length]!;
    return {
      townSlug: town.slug,
      townName: town.name,
      visitedAt: new Date(base.getTime() + i * 24 * 60 * 60 * 1000),
    };
  });

  return {
    kind: "authed",
    handle: "harshith",
    displayName,
    passportId: "TP-2026-000042",
    issuedAt: base,
    townsOwned: 3,
    stamps,
  };
}
