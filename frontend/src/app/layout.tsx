/**
 * Root layout. Loads the LORE fonts (Space Grotesk + JetBrains Mono, declared in
 * ./fonts) as CSS variables on <html>, mounts the shared backdrop once, and sets
 * the liquid-glass class before first paint. GlassFilter, PumpkinBackdrop and
 * the LIQUID_GLASS_CHECK script stay until the ui-redesign cleanup (task 18).
 */
import type { Metadata } from "next";
import { GlassFilter } from "@/components/backdrop/GlassFilter";
import { PumpkinBackdrop } from "@/components/backdrop/PumpkinBackdrop";
import { jetbrainsMono, spaceGrotesk } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "LORE — Interactive Learning Visual Novel",
  description: "Learn by Living the Knowledge.",
};

/**
 * Chromium can refract what is behind glass (see GlassFilter), other browsers
 * cannot. This runs while the HTML is parsed, so the class is on <html> before
 * the first paint: next/script's beforeInteractive only runs at hydration,
 * which would make every panel visibly switch from frosted to refracting.
 */
const LIQUID_GLASS_CHECK = `if (/Chrome\\//.test(navigator.userAgent)) document.documentElement.classList.add("liquid");`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the script in <head> adds a class to <html> before React hydrates it.
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: LIQUID_GLASS_CHECK }} />
      </head>
      <body className="min-h-full flex flex-col">
        <GlassFilter />
        <PumpkinBackdrop />
        {children}
      </body>
    </html>
  );
}
