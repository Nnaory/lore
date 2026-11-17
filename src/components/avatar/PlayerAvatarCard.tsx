/**
 * PlayerAvatarCard — choose how you appear on the stage canvas.
 *
 * Shows the current avatar; "Change" opens the built-in ASCII presets and
 * an upload that converts the player's own picture to ASCII art on this
 * device (detail and invert can be tuned before saving). Only the ASCII
 * text is saved — see lib/avatar/avatar.ts.
 */

"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { imageToAscii, MONO_CELL_ASPECT, type PixelSource } from "@/lib/ascii/image-to-ascii";
import { ACCEPTED_IMAGE_TYPES, ImageReadError, readImagePixels, type ReadImagePixels } from "@/lib/ascii/load-image";
import { AVATAR_PRESETS, avatarArt, avatarName, saveAvatar } from "@/lib/avatar/avatar";
import { usePlayerAvatar } from "@/lib/avatar/use-player-avatar";
import { AsciiArt } from "./AsciiArt";

const MIN_COLUMNS = 20;
const MAX_COLUMNS = 48;
const DEFAULT_COLUMNS = 32;

/** Font size that fits `art` in a box `width` px wide (capped at `max`). */
function fitSize(art: string, width: number, max: number): number {
  const columns = Math.max(1, ...art.split("\n").map((l) => l.length));
  return Math.min(max, width / (columns * MONO_CELL_ASPECT));
}

type PlayerAvatarCardProps = {
  /** Decodes the chosen file; injectable for tests (jsdom has no canvas). */
  readPixels?: ReadImagePixels;
};

export function PlayerAvatarCard({ readPixels = readImagePixels }: PlayerAvatarCardProps) {
  const avatar = usePlayerAvatar();
  const [open, setOpen] = useState(false);
  const [pixels, setPixels] = useState<PixelSource | null>(null);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [invert, setInvert] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const preview = useMemo(
    () => (pixels ? imageToAscii(pixels, { columns, invert }) : null),
    [pixels, columns, invert]
  );
  const current = avatarArt(avatar);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // choosing the same file again still fires change
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      setPixels(await readPixels(file));
    } catch (err) {
      setPixels(null);
      setError(err instanceof ImageReadError ? err.message : "This image could not be read.");
    } finally {
      setReading(false);
    }
  }

  function save(next: Parameters<typeof saveAvatar>[0]) {
    if (saveAvatar(next)) {
      setError(null);
      return true;
    }
    setError("Your avatar could not be saved in this browser.");
    return false;
  }

  function saveCustom() {
    if (preview && save({ kind: "custom", art: preview })) setPixels(null);
  }

  return (
    <section
      className="lore-glass lore-glass-panel rounded-panel @container w-full flex flex-col gap-3 p-4 text-left"
      aria-labelledby="player-avatar-heading"
      data-testid="player-avatar"
    >
      <h2 id="player-avatar-heading" className="lore-eyebrow">
        Your avatar
      </h2>

      <div className="flex items-center gap-4">
        <div
          className="lore-well rounded-tip w-24 h-20 flex-shrink-0 flex items-center justify-center overflow-hidden"
          data-testid="player-avatar-current"
        >
          <AsciiArt art={current} size={fitSize(current, 84, 8)} label={`Your avatar: ${avatarName(avatar)}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
            {avatarName(avatar)}
          </p>
          <p className="text-xs" style={{ color: "var(--foreground-faint)" }}>
            How you appear on the story stage.
          </p>
        </div>
        <button
          type="button"
          data-testid="player-avatar-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="lore-pill lore-pill-sm flex-shrink-0"
        >
          {open ? "Done" : "Change"}
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-4 pt-1" data-testid="player-avatar-editor">
          <div role="radiogroup" aria-label="Preset avatars" className="grid grid-cols-2 @md:grid-cols-4 gap-2">
            {AVATAR_PRESETS.map((preset) => {
              const selected = avatar.kind === "preset" && avatar.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`avatar-preset-${preset.id}`}
                  onClick={() => save({ kind: "preset", id: preset.id })}
                  className="lore-tile rounded-tip p-2 flex flex-col items-center gap-2"
                >
                  <div className="h-16 flex items-center justify-center overflow-hidden">
                    <AsciiArt art={preset.art} size={fitSize(preset.art, 84, 7)} label={preset.name} />
                  </div>
                  <span className="text-xs" style={{ color: selected ? "var(--accent-gold)" : "var(--foreground-muted)" }}>
                    {preset.name}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-2">
            <label className="lore-pill lore-pill-sm lore-pill-accent self-start focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent-gold)]">
              {reading ? "Reading…" : "Use your own picture"}
              <input
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                className="sr-only"
                data-testid="avatar-upload-input"
                onChange={handleFile}
                disabled={reading}
              />
            </label>
            <p className="text-xs" style={{ color: "var(--foreground-faint)" }}>
              Turned into ASCII art on this device. The picture itself is not saved or uploaded.
            </p>
            {error && (
              <p role="alert" data-testid="avatar-error" className="text-xs" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}
          </div>

          {preview && (
            <div data-testid="avatar-preview" className="lore-well rounded-tip p-4 flex flex-col items-center gap-4">
              <AsciiArt art={preview} size={fitSize(preview, 280, 11)} label="Preview of your picture as ASCII art" />
              <div className="w-full flex flex-wrap items-center gap-x-5 gap-y-2 text-xs" style={{ color: "var(--foreground-muted)" }}>
                <label className="flex items-center gap-2 flex-1 min-w-40">
                  Detail
                  <input
                    type="range"
                    min={MIN_COLUMNS}
                    max={MAX_COLUMNS}
                    step={2}
                    value={columns}
                    onChange={(e) => setColumns(Number(e.target.value))}
                    data-testid="avatar-detail"
                    className="flex-1 accent-[var(--accent)]"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={invert}
                    onChange={(e) => setInvert(e.target.checked)}
                    data-testid="avatar-invert"
                    className="accent-[var(--accent)]"
                  />
                  Invert (for bright backgrounds)
                </label>
              </div>
              <div className="w-full flex gap-2">
                <button
                  type="button"
                  data-testid="avatar-preview-cancel"
                  onClick={() => setPixels(null)}
                  className="lore-pill lore-pill-sm flex-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="avatar-preview-save"
                  onClick={saveCustom}
                  className="lore-pill lore-pill-sm lore-pill-primary flex-1"
                >
                  Use this avatar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
