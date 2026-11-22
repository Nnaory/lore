/**
 * Root layout. Loads the LORE fonts (Space Grotesk + JetBrains Mono, declared in
 * ./fonts) as CSS variables on <html> and mounts the shared animated ASCII
 * pumpkin backdrop (`PumpkinBackdrop`) once across all routes.
 */
import type { Metadata } from "next";
import { PumpkinBackdrop } from "@/components/backdrop/PumpkinBackdrop";
import { jetbrainsMono, spaceGrotesk } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "LORE — Interactive Learning Visual Novel",
  description: "Learn by Living the Knowledge.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <PumpkinBackdrop />
        {children}
      </body>
    </html>
  );
}
