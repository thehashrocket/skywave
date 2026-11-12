import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { Providers } from "@/lib/trpc";
import "./globals.css";

const description =
  "Listen to shortwave and ham radio through public KiwiSDR receivers around the world, right in your browser.";

// Vercel sets the production hostname; link previews need absolute image URLs.
const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const metadata: Metadata = {
  metadataBase: new URL(host ? `https://${host}` : "http://localhost:3000"),
  title: "skywave: listen to shortwave radio in your browser",
  description,
  openGraph: { title: "skywave", description, type: "website", siteName: "skywave" },
  twitter: { card: "summary_large_image", title: "skywave", description },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Barlow+Condensed:wght@500;600&display=swap"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
