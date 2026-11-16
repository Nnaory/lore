// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlayerAvatarCard } from "@/components/avatar/PlayerAvatarCard";
import { AVATAR_KEY, AVATAR_PRESETS, loadAvatar } from "@/lib/avatar/avatar";
import { ImageReadError } from "@/lib/ascii/load-image";
import type { PixelSource } from "@/lib/ascii/image-to-ascii";

afterEach(() => window.localStorage.removeItem(AVATAR_KEY));

/** Left half black, right half white. */
function halves(size = 32): PixelSource {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const g = i % size < size / 2 ? 0 : 255;
    data.set([g, g, g, 255], i * 4);
  }
  return { width: size, height: size, data };
}

const png = () => new File(["x"], "me.png", { type: "image/png" });

describe("PlayerAvatarCard", () => {
  it("shows the default avatar and saves a chosen preset", async () => {
    const user = userEvent.setup();
    render(<PlayerAvatarCard />);
    expect(screen.getByRole("img", { name: "Your avatar: Wanderer" })).toBeInTheDocument();

    await user.click(screen.getByTestId("player-avatar-toggle"));
    await user.click(screen.getByTestId("avatar-preset-familiar"));

    expect(loadAvatar()).toEqual({ kind: "preset", id: "familiar" });
    expect(screen.getByRole("img", { name: "Your avatar: Familiar" })).toBeInTheDocument();
    expect(screen.getByTestId("avatar-preset-familiar")).toHaveAttribute("aria-checked", "true");
  });

  it("converts an uploaded picture, lets the player tune it, and saves only ASCII", async () => {
    const user = userEvent.setup();
    const readPixels = vi.fn(async () => halves());
    render(<PlayerAvatarCard readPixels={readPixels} />);

    await user.click(screen.getByTestId("player-avatar-toggle"));
    await user.upload(screen.getByTestId("avatar-upload-input"), png());

    const preview = await screen.findByRole("img", { name: /Preview/ });
    const firstLine = preview.textContent!.split("\n")[0];
    expect(firstLine).toMatch(/^ +@+$/); // dark left, bright right
    expect(firstLine).toHaveLength(32);

    await user.click(screen.getByTestId("avatar-invert"));
    expect(screen.getByRole("img", { name: /Preview/ }).textContent!.split("\n")[0]).toMatch(/^@+ +$/);

    await user.click(screen.getByTestId("avatar-preview-save"));
    const saved = loadAvatar();
    expect(saved.kind).toBe("custom");
    expect(saved.kind === "custom" && saved.art.split("\n")[0]).toMatch(/^@+ +$/);
    expect(window.localStorage.getItem(AVATAR_KEY)).not.toContain("data:");
    expect(screen.queryByTestId("avatar-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Your avatar: Your picture" })).toBeInTheDocument();
  });

  it("shows a readable error when the picture cannot be read", async () => {
    const user = userEvent.setup();
    const readPixels = vi.fn(async () => {
      throw new ImageReadError("Choose a PNG, JPG, WebP or GIF image.");
    });
    render(<PlayerAvatarCard readPixels={readPixels} />);

    await user.click(screen.getByTestId("player-avatar-toggle"));
    await user.upload(screen.getByTestId("avatar-upload-input"), png());

    await waitFor(() => expect(screen.getByTestId("avatar-error")).toHaveTextContent("Choose a PNG"));
    expect(screen.queryByTestId("avatar-preview")).not.toBeInTheDocument();
    expect(loadAvatar().kind).toBe("preset");
  });

  it("cancelling a preview keeps the current avatar", async () => {
    const user = userEvent.setup();
    render(<PlayerAvatarCard readPixels={async () => halves()} />);

    await user.click(screen.getByTestId("player-avatar-toggle"));
    await user.upload(screen.getByTestId("avatar-upload-input"), png());
    await user.click(await screen.findByTestId("avatar-preview-cancel"));

    expect(screen.queryByTestId("avatar-preview")).not.toBeInTheDocument();
    expect(loadAvatar()).toEqual({ kind: "preset", id: AVATAR_PRESETS[0].id });
  });
});
