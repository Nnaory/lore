import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { GlassFilter } from "@/components/backdrop/GlassFilter";
import { PumpkinBackdrop } from "@/components/backdrop/PumpkinBackdrop";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
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
