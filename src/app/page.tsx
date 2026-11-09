/**
 * Landing Page
 *
 * Simple entry point for LORE. Provides a link to the story viewer.
 * Full campaign setup UI is planned for a later milestone.
 */

import Link from "next/link";

export default function Home() {
  return (
    <div
      className="lore-bg flex flex-col flex-1 items-center justify-center min-h-screen"
    >
      <main className="flex flex-col items-center gap-8 text-center px-8 py-16 max-w-md">
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
        <div className="flex flex-col gap-1">
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

        <Link
          href="/game"
          className="px-8 py-3 rounded text-sm font-medium tracking-wide transition-opacity hover:opacity-80 active:opacity-60"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--foreground)",
          }}
        >
          Begin Adventure
        </Link>

        <p
          className="text-xs"
          style={{ color: "var(--foreground-faint)" }}
        >
          Milestone 2 — Story Viewer Demo
        </p>
      </main>
    </div>
  );
}
