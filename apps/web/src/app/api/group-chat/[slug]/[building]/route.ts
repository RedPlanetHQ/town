// Thin Next.js stub. All logic lives in the feature folder so the
// feature can be deleted by removing this file + the import target +
// the prisma model.

export const runtime = "nodejs";
// NPC reply generation can take 10–30s; the streaming reply runs in
// the background after the response, but we still want headroom.
export const maxDuration = 60;

export { GET } from "@/features/group-chat/server/history";
export { POST } from "@/features/group-chat/server/route";
