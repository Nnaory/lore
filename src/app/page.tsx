/**
 * Landing Page
 *
 * A chat-style entry point: the LORE mark and title above one field where the
 * player pastes material or attaches a document (components/home/HomeComposer).
 * Sending continues at /create. Below it sit the built-in demo campaign
 * (/game) and the stories saved in this browser, which this page is the only
 * way to reopen.
 *
 * Liquid-glass panels over the pumpkin night, after the ascii-animals
 * reference. The night itself is the root layout's
 * (components/backdrop/PumpkinBackdrop), so this page has no background of
 * its own and only draws what sits on top of it.
 *
 * Content hangs from a fixed top offset instead of being centred, so the
 * field does not move when the saved stories load in underneath it.
 */

import Link from "next/link";
import { HomeComposer } from "@/components/home/HomeComposer";
import { SavedStories } from "@/components/home/SavedStories";
import { PumpkinMark } from "@/components/home/PumpkinMark";

export default function Home() {
  return (
    <div className="relative flex-1 min-h-dvh">
      <main className="relative z-10 min-h-dvh flex flex-col items-center px-4 pt-[clamp(48px,20dvh,220px)] pb-16">
        <div className="w-full max-w-[720px] flex flex-col gap-6">
          <header className="flex flex-col items-center gap-4 text-center">
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

          <HomeComposer />

          <div className="flex justify-center">
            <Link
              href="/game"
              data-testid="home-demo-link"
              className="lore-glass lore-glass-panel rounded-pill h-8 px-4 flex items-center text-xs tracking-wide"
              style={{ color: "var(--foreground-muted)" }}
            >
              Play the demo: The Last Beacon
            </Link>
          </div>

          <SavedStories />
        </div>
      </main>
    </div>
  );
}
