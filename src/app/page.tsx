/**
 * Landing Page
 *
 * Entry point for LORE: create a story from your own material (/create)
 * or play the built-in demo campaign (/game).
 */

import Link from "next/link";
import { SavedStories } from "@/components/home/SavedStories";

export default function Home() {
  return (
    <div
      className="lore-bg flex flex-col flex-1 items-center justify-center min-h-screen"
    >
      <main className="flex flex-col items-center gap-8 text-center px-6 py-16 max-w-md w-full">
        {/* Wordmark */}
        <div className="flex flex-col items-center gap-2">
          <div
            className="w-12 h-12 rounded-lg flex items-center justify-center text-xl font-bold"
            style={{ backgroundColor: "var(--accent)", color: "var(--foreground)" }}
            aria-label="LORE"
          >
            L
          </div>
          <h1
            className="text-3xl font-semibold tracking-widest uppercase"
            style={{ color: "var(--foreground)" }}
          >
            LORE
          </h1>
          <p
            className="text-sm tracking-wide"
            style={{ color: "var(--foreground-muted)" }}
          >
            Learn by Living the Knowledge.
          </p>
        </div>

        <div className="lore-divider w-full" />

        {/* Campaign preview */}
        <div className="flex flex-col gap-1 w-full">
          <p
            className="text-xs tracking-widest uppercase"
            style={{ color: "var(--foreground-faint)" }}
          >
            Available Campaign
          </p>
          <p
            className="text-base font-medium"
            style={{ color: "var(--foreground)" }}
          >
            The Last Beacon
          </p>
          <p
            className="text-sm"
            style={{ color: "var(--foreground-muted)" }}
          >
            A world where ancient beacons are all that hold reality together.
          </p>
        </div>

        <div className="flex flex-col gap-3 w-full">
          <Link
            href="/create"
            className="w-full px-8 py-3 rounded text-sm font-medium tracking-wide transition-opacity hover:opacity-80 active:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--background)",
            }}
          >
            Create from your material
          </Link>
          <Link
            href="/game"
            className="w-full px-8 py-3 rounded text-sm font-medium tracking-wide transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            style={{
              border: "1px solid var(--border)",
              color: "var(--foreground-muted)",
            }}
          >
            Play the demo
          </Link>
        </div>

        <p
          className="text-xs"
          style={{ color: "var(--foreground-faint)" }}
        >
          PDF · DOCX · PPTX · or pasted text
        </p>

        <SavedStories />
      </main>
    </div>
  );
}
