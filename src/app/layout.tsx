import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* usePathname() is only known at request time on dynamic routes (/play/[projectId]); there the backdrop is hidden anyway. */}
        <Suspense fallback={null}>
          <PumpkinBackdrop />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
