/**
 * Player avatar — browser localStorage
 *
 * The player appears on the stage canvas as ASCII art: one of the built-in
 * presets, or art converted from their own picture. Only the finished
 * ASCII text is stored (a few hundred bytes); the picture itself is never
 * kept or sent anywhere.
 *
 *   lore:avatar → { kind: "preset", id } | { kind: "custom", art }
 *
 * SSR-safe and never throws: unreadable or invalid data falls back to the
 * default preset.
 */

import { z } from "zod";

export const AVATAR_KEY = "lore:avatar";
/** Fired on window after the avatar is saved in this tab. */
export const AVATAR_EVENT = "lore:avatar-change";

/** Limits for custom art (the picker produces at most 48 columns). */
export const MAX_ART_COLUMNS = 64;
export const MAX_ART_ROWS = 40;

/** Strip the first newline of a template and the trailing whitespace of every line. */
function art(raw: string): string {
  return raw
    .replace(/^\n/, "")
    .replace(/\n\s*$/, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

export const AVATAR_PRESETS = [
  {
    id: "wanderer",
    name: "Wanderer",
    art: art(String.raw`
     .-'''''-.
    /  .---.  \
   |  / o o \  |
   |  \  ^  /  |
   |   '---'   |
    \  _____  /
   .-'/     \'-.
  /  |   *   |  \
 |   |       |   |
 '---'-------'---'
`),
  },
  {
    id: "scholar",
    name: "Scholar",
    art: art(String.raw`
      _______
  ___/_______\___
 '------. .------'
    .---'-'---.
   |  .-. .-.  |
   |--|o|-|o|--|
   |  '-' '-'  |
   |    ___    |
    \  '---'  /
     '-.___.-'
`),
  },
  {
    id: "automaton",
    name: "Automaton",
    art: art(String.raw`
         o
         |
   .-----------.
   |  [O] [O]  |
   |     ^     |
   |  [=====]  |
   '-----------'
    __|_____|__
   |  | [#] |  |
   |__|_____|__|
`),
  },
  {
    id: "familiar",
    name: "Familiar",
    art: art(String.raw`
    /\_____/\
   /  o   o  \
  ( ==  ^  == )
   )         (
  (           )
 ( (  )   (  ) )
(__(__)___(__)__)
`),
  },
] as const;

export type AvatarPresetId = (typeof AVATAR_PRESETS)[number]["id"];

export type PlayerAvatar = { kind: "preset"; id: AvatarPresetId } | { kind: "custom"; art: string };

export const DEFAULT_AVATAR: PlayerAvatar = { kind: "preset", id: "wanderer" };

const PRESET_IDS = AVATAR_PRESETS.map((p) => p.id) as [AvatarPresetId, ...AvatarPresetId[]];

/** True when `text` is printable-ASCII art within the size limits. */
export function isValidArt(text: string): boolean {
  if (text.trim() === "" || !/^[\x20-\x7E\n]*$/.test(text)) return false;
  const lines = text.split("\n");
  return lines.length <= MAX_ART_ROWS && lines.every((line) => line.length <= MAX_ART_COLUMNS);
}

const AvatarSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), id: z.enum(PRESET_IDS) }),
  z.object({ kind: z.literal("custom"), art: z.string().refine(isValidArt) }),
]);

/** Parse a stored value; anything unreadable becomes the default avatar. */
export function parseAvatar(raw: string | null): PlayerAvatar {
  if (!raw) return DEFAULT_AVATAR;
  try {
    const result = AvatarSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}

/** The raw stored value (a stable string snapshot for useSyncExternalStore). */
export function readStoredAvatar(): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(AVATAR_KEY) : null;
  } catch {
    return null;
  }
}

export function loadAvatar(): PlayerAvatar {
  return parseAvatar(readStoredAvatar());
}

/** Save the avatar; false when it is invalid or storage is unavailable. */
export function saveAvatar(avatar: PlayerAvatar): boolean {
  if (!AvatarSchema.safeParse(avatar).success) return false;
  try {
    window.localStorage.setItem(AVATAR_KEY, JSON.stringify(avatar));
    window.dispatchEvent(new Event(AVATAR_EVENT));
    return true;
  } catch {
    return false;
  }
}

/** The ASCII art to draw for an avatar. */
export function avatarArt(avatar: PlayerAvatar): string {
  if (avatar.kind === "custom") return avatar.art;
  return (AVATAR_PRESETS.find((p) => p.id === avatar.id) ?? AVATAR_PRESETS[0]).art;
}

/** A short label: the preset's name, or "Your picture". */
export function avatarName(avatar: PlayerAvatar): string {
  if (avatar.kind === "custom") return "Your picture";
  return (AVATAR_PRESETS.find((p) => p.id === avatar.id) ?? AVATAR_PRESETS[0]).name;
}
