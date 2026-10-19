import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/lib/trpc";
import "./globals.css";

export const metadata: Metadata = {
  title: "skywave",
  description: "Listen to shortwave and amateur radio through public KiwiSDR receivers.",
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
      </body>
    </html>
  );
}
