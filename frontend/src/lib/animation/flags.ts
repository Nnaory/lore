/**
 * Animation build flag (pure).
 *
 * Lesson animations are switched on per build by `NEXT_PUBLIC_ANIMATIONS=on`. Every other value
 * (`off`, `ON`, `true`, `1`, an empty string, or no value at all) reads as off, so a typo can
 * never turn the feature on and a build without the variable behaves as it did before the
 * feature existed (design 7.9, Requirement 36.1).
 *
 * `readAnimationsFlag` reads the literal `process.env.NEXT_PUBLIC_ANIMATIONS`. Next.js inlines
 * only that exact expression into the client bundle, the same way it does for
 * `NEXT_PUBLIC_PROJECT_STORE` in `lib/state/project-store.ts`. Do not read it through a variable
 * or a destructured `process.env`.
 */

/** True only for the exact string `"on"`. */
export function animationsEnabled(raw: string | undefined): boolean {
  return raw === "on";
}

/** The build-time flag: true when this build was made with `NEXT_PUBLIC_ANIMATIONS=on`. */
export function readAnimationsFlag(): boolean {
  // Literal access: Next.js replaces it at build time.
  return animationsEnabled(process.env.NEXT_PUBLIC_ANIMATIONS);
}
