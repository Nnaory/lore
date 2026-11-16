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
    <section className="w-full flex flex-col gap-3 text-left" aria-labelledby="player-avatar-heading" data-testid="player-avatar">
      <h2 id="player-avatar-heading" className="text-xs tracking-widest uppercase" style={{ color: "var(--foreground-faint)" }}>
        Your avatar
      </h2>

      <div
        className="rounded-lg p-3 flex items-center gap-4"
        style={{ backgroundColor: "var(--background-panel)", border: "1px solid var(--border-dim)" }}
      >
        <div className="w-24 h-20 flex-shrink-0 flex items-center justify-center overflow-hidden" data-testid="player-avatar-current">
          <AsciiArt art={current} size={fitSize(current, 92, 8)} label={`Your avatar: ${avatarName(avatar)}`} />
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
          className="flex-shrink-0 px-3 py-1.5 rounded text-xs"
          style={{ color: "var(--foreground-muted)", border: "1px solid var(--border)" }}
        >
          {open ? "Done" : "Change"}
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-4" data-testid="player-avatar-editor">
          <div role="radiogroup" aria-label="Preset avatars" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                  className="rounded-lg p-2 flex flex-col items-center gap-2 transition-colors"
                  style={{
                    backgroundColor: "var(--background-panel)",
                    border: `1px solid ${selected ? "var(--accent-gold)" : "var(--border-dim)"}`,
                  }}
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
            <label
              className="self-start px-4 py-2 rounded text-xs font-medium cursor-pointer focus-within:ring-2"
              style={{ color: "var(--accent-gold)", border: "1px solid var(--accent-gold)" }}
            >
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
            <div
              data-testid="avatar-preview"
              className="rounded-lg p-4 flex flex-col items-center gap-4"
              style={{ backgroundColor: "var(--background)", border: "1px solid var(--border)" }}
            >
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
                    className="flex-1 accent-[var(--accent-gold)]"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={invert}
                    onChange={(e) => setInvert(e.target.checked)}
                    data-testid="avatar-invert"
                    className="accent-[var(--accent-gold)]"
                  />
                  Invert (for bright backgrounds)
                </label>
              </div>
              <div className="w-full flex gap-2">
                <button
                  type="button"
                  data-testid="avatar-preview-cancel"
                  onClick={() => setPixels(null)}
                  className="flex-1 px-4 py-2 rounded text-xs"
                  style={{ color: "var(--foreground-muted)", border: "1px solid var(--border)" }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="avatar-preview-save"
                  onClick={saveCustom}
                  className="flex-1 px-4 py-2 rounded text-xs font-medium"
                  style={{ backgroundColor: "var(--accent-gold)", color: "var(--background)" }}
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
