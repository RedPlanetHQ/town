import type { Metadata } from "next";
import { Geist, Geist_Mono, Press_Start_2P } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Pixel display font — used by the CORE OS-style boot/loading screens.
// Mirrors core-website's setup so the visual language stays consistent
// across the marketing site and the town app.
const pressStart2P = Press_Start_2P({
  variable: "--font-press-start-2p",
  subsets: ["latin"],
  weight: "400",
});

// metadataBase resolves relative URLs in per-route `generateMetadata`
// (e.g. og:image: "/api/towns/<slug>/postcard.png") to absolute URLs.
// Defaults to the production host (town.getcore.me) so any deploy that
// forgets to set NEXT_PUBLIC_SITE_URL still ships share links pointing
// at prod instead of localhost. Override per-environment when needed.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://town.getcore.me";

// Defaults that flow through every page. Per-page metadata can:
//   • override title — picks up the template, so a page that exports
//     `title: "Onboarding"` renders as "Onboarding · town" in the
//     browser tab.
//   • override description / openGraph / twitter — replaces these.
// Icons cover the browser tab (favicon), iOS / iPadOS home screen
// (apple-touch-icon → /logo.png), and the desktop bookmark fallback.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "town",
    template: "%s · town",
  },
  description:
    "A pixel-art town built on CORE — a tiny world that knows you, lives in your browser, and remembers what you've been working on.",
  applicationName: "town",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/logo.png", type: "image/png" },
    ],
    apple: "/logo.png",
    shortcut: "/favicon.ico",
  },
  openGraph: {
    title: "town",
    description:
      "A pixel-art town built on CORE — a tiny world that knows you, lives in your browser, and remembers what you've been working on.",
    siteName: "town",
    type: "website",
    images: [{ url: "/logo.png", alt: "town" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "town",
    description:
      "A pixel-art town built on CORE — a tiny world that knows you, lives in your browser, and remembers what you've been working on.",
    images: ["/logo.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} ${pressStart2P.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
