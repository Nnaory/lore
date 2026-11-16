/**
 * Landing Page
 *
 * Entry point for LORE: create a story from your own material (/create)
 * or play the built-in demo campaign (/game).
 *
 * Halloween theme: liquid-glass panels over the ASCII pumpkin night, after
 * the ascii-animals reference. The night itself is the root layout's
 * (components/backdrop/PumpkinBackdrop), so this page has no background of
 * its own and only draws what sits on top of it.
 */

import Link from "next/link";
import { ArrowRight, FileText, ScrollText } from "lucide-react";
import { SavedStories } from "@/components/home/SavedStories";
import { PlayerAvatarCard } from "@/components/avatar/PlayerAvatarCard";
import { GlassScope } from "@/components/home/GlassScope";
import { PumpkinMark } from "@/components/home/PumpkinMark";

export default function Home() {
  return (
    <GlassScope className="theme-halloween relative flex-1 min-h-dvh">
      <main className="relative z-10 min-h-dvh flex flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-[720px] flex flex-col gap-4">
          <header className="flex flex-col items-center gap-4 mb-3 text-center">
            <PumpkinMark />
            <div className="flex flex-col items-center gap-2">
              <h1
                className="lore-halo text-[clamp(24px,5vw,32px)] font-medium leading-[1.15] tracking-[0.32em] pl-[0.32em]"
                style={{ color: "var(--foreground)" }}
              >
                LORE
              </h1>
              <p className="lore-halo text-sm tracking-wide" style={{ color: "var(--foreground-muted)" }}>
                Learn by Living the Knowledge.
              </p>
            </div>
          </header>

          <section
            aria-labelledby="home-create-heading"
            className="lore-glass lore-glass-composer rounded-card flex flex-col gap-[18px] pt-[18px] pr-3 pb-3 pl-[18px]"
          >
            <div className="flex items-start gap-2.5 pr-2">
              <ScrollText size={18} aria-hidden="true" className="flex-none mt-1" style={{ color: "var(--foreground-faint)" }} />
              <div className="min-w-0">
                <h2 id="home-create-heading" className="text-[17px] leading-[1.55] font-medium" style={{ color: "var(--foreground)" }}>
                  Turn your material into a story
                </h2>
                <p className="mt-1 text-sm leading-6" style={{ color: "var(--foreground-muted)" }}>
                  Bring lecture notes, a chapter, or a slide deck. LORE builds a world around it where every
                  challenge is solved with what you learn.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pl-7">
              <p className="flex items-center gap-2 text-xs" style={{ color: "var(--foreground-faint)" }}>
                <FileText size={14} aria-hidden="true" />
                PDF · DOCX · PPTX · or pasted text
              </p>
              <Link href="/create" className="lore-pill lore-pill-primary">
                Create from your material
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>

            <div className="lore-hairline ml-7 mr-1.5" />

            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pl-7">
              <div className="min-w-0">
                <p className="lore-eyebrow mb-1.5">Demo campaign</p>
                <p className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                  The Last Beacon
                </p>
                <p className="text-xs leading-5" style={{ color: "var(--foreground-faint)" }}>
                  A world where ancient beacons are all that hold reality together.
                </p>
              </div>
              <Link href="/game" className="lore-pill">
                Play the demo
              </Link>
            </div>
          </section>

          <PlayerAvatarCard />

          <SavedStories />
        </div>
      </main>
    </GlassScope>
  );
}
