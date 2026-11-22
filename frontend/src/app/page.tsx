/**
 * Landing Page
 *
 * Home option B, "Greeted by Hazel": a hero (components/home/HomeHero, a
 * 1440x900 / 390x844 board scaled as a whole) where Hazel greets the player
 * and the composer is her dialogue box's bottom bar. The player attaches a
 * material file (required) and may type extra instructions; sending continues
 * at /create. The built-in demo link (/game) sits in the hero. Below the hero,
 * in a 680px column, are the stories saved in this browser, which this page
 * is the only way to reopen.
 *
 * The page paints no background of its own: the animated pumpkin night is the
 * root layout's (components/backdrop/PumpkinBackdrop); the hero only adds the
 * grid lines.
 */

import { HomeHero } from "@/components/home/HomeHero";
import { SavedStories } from "@/components/home/SavedStories";

export default function Home() {
  return (
    <main className="relative flex-1 min-h-dvh">
      <HomeHero />
      <div className="mx-auto w-full max-w-[712px] px-4 pb-16 pt-8">
        <SavedStories />
      </div>
    </main>
  );
}
