import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@town/types", "@town/db"],
  // @napi-rs/canvas ships its platform-specific binary as a separate
  // optional dependency (skia.darwin-arm64.node, etc.). Next's bundler
  // tries to resolve those eagerly and chokes; marking the package
  // external keeps the require() at runtime, where pnpm has the right
  // binding on disk.
  //
  // pdfkit + svg-to-pdfkit + fontkit read font metric files (Helvetica.afm,
  // etc.) via fs.readFileSync(__dirname + "/data/...") at construction time.
  // Next's server bundler rewrites those paths and the AFM assets stop
  // resolving. Keeping them external preserves the original require paths.
  serverExternalPackages: ["@napi-rs/canvas", "pdfkit", "svg-to-pdfkit", "fontkit"],
};

export default nextConfig;
