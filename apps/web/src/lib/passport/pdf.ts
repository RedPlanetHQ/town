import PDFDocument from "pdfkit";
// svg-to-pdfkit ships no types.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SVGtoPDF = require("svg-to-pdfkit") as (
  doc: PDFKit.PDFDocument,
  svg: string,
  x: number,
  y: number,
  opts?: { width?: number; height?: number; assumePt?: boolean; preserveAspectRatio?: string },
) => void;

import type { PassportData } from "./types";
import { SPREAD_HEIGHT, SPREAD_WIDTH, renderSpread, spreadCountFor } from "./render";

/** Renders a Town passport to a PDF Buffer, one spread per page. */
export async function renderPassportPdf(data: PassportData): Promise<Buffer> {
  const totalSpreads = spreadCountFor(data.stamps.length);

  const doc = new PDFDocument({
    size: [SPREAD_WIDTH, SPREAD_HEIGHT],
    margin: 0,
    info: {
      Title: `Town Passport — ${data.displayName}`,
      Author: data.displayName,
      Subject: `Town Passport ${data.passportId}`,
      Creator: "Town",
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", (err: Error) => reject(err));
  });

  for (let i = 0; i < totalSpreads; i++) {
    if (i > 0) doc.addPage({ size: [SPREAD_WIDTH, SPREAD_HEIGHT], margin: 0 });
    const svg = renderSpread(data, i);
    SVGtoPDF(doc, svg, 0, 0, {
      width: SPREAD_WIDTH,
      height: SPREAD_HEIGHT,
      preserveAspectRatio: "xMidYMid meet",
    });
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}
