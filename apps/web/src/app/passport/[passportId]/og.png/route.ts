// GET /passport/[passportId]/og.png — social-card image for the passport.
//
// Renders the first spread (identity + first 6 stamps) as an SVG, then
// rasterizes it to a 1200×630 PNG via sharp. Sized for Twitter's large
// summary card + generic OG scrapers.

import sharp from "sharp";

import { loadPassportDataByPassportId } from "@/lib/passport/load";
import { PASSPORT_THEMES } from "@/lib/passport/theme";
import { renderSpread } from "@/lib/passport/render";

export const runtime = "nodejs";

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

type Params = { passportId: string };

export async function GET(_req: Request, ctx: { params: Promise<Params> }) {
  const { passportId } = await ctx.params;
  const data = await loadPassportDataByPassportId(passportId);
  if (!data) return new Response("not found", { status: 404 });

  const svg = renderSpread(data, 0);
  const theme = PASSPORT_THEMES[data.kind];

  // The spread is 900×560 (aspect ~1.61); OG is 1200×630 (aspect ~1.90).
  // Letterbox with the page color as the border so it reads as one
  // continuous parchment surface instead of a card on a white void.
  const png = await sharp(Buffer.from(svg, "utf8"))
    .resize(OG_WIDTH, OG_HEIGHT, {
      fit: "contain",
      background: theme.page,
    })
    .png()
    .toBuffer();

  return new Response(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      // Modest CDN cache: passport contents change as stamps accumulate,
      // but individual OG scrapers cache their own copies for a while
      // anyway, so a short server-side cache balances freshness + load.
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}
