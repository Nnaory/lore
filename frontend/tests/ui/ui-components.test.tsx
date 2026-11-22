/**
 * @vitest-environment jsdom
 *
 * Tests for the Kit `ui` components (Icon, ErrorLine, Button).
 * Verifies the stroke/cap contract of Icon, the alert semantics of ErrorLine
 * and the variant, href and disabled behaviour of Button (Requirements 3.4, 14.3).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import type { NextRouter } from "next/router";
import { Button } from "@/components/ui/Button";
import { ErrorLine } from "@/components/ui/ErrorLine";
import { Icon, type IconName } from "@/components/ui/Icon";

const NAMES: IconName[] = [
  "back",
  "exit",
  "file-up",
  "paperclip",
  "arrow-up",
  "file",
  "close",
  "check",
  "play",
  "alert",
];

describe("Icon", () => {
  it.each(NAMES)("renders %s with stroke 2, square caps and currentColor", (name) => {
    render(<Icon name={name} data-testid="icon" />);
    const svg = screen.getByTestId("icon");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("stroke-linecap")).toBe("square");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("is decorative without a label and an image with one", () => {
    const { rerender } = render(<Icon name="check" data-testid="icon" />);
    expect(screen.getByTestId("icon").getAttribute("aria-hidden")).toBe("true");
    rerender(<Icon name="check" label="Done" data-testid="icon" />);
    const svg = screen.getByTestId("icon");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Done");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });

  it("applies the size prop", () => {
    render(<Icon name="play" size={16} data-testid="icon" />);
    const svg = screen.getByTestId("icon");
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
  });
});

describe("ErrorLine", () => {
  it("has role alert with the ERROR chip and message", () => {
    render(<ErrorLine data-testid="err">Upload failed</ErrorLine>);
    const el = screen.getByRole("alert");
    expect(el).toBe(screen.getByTestId("err"));
    expect(el.textContent).toContain("ERROR");
    expect(el.textContent).toContain("Upload failed");
    expect(el.querySelector(".bg-ember.text-ink")).not.toBeNull();
  });
});

describe("Button", () => {
  it("defaults to a primary button of type button", () => {
    render(<Button data-testid="btn">Go</Button>);
    const btn = screen.getByTestId("btn");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("data-variant")).toBe("primary");
    expect(btn.className).toContain("bg-ember");
    expect(btn.className).toContain("min-h-[44px]");
  });

  it("renders the outline variant", () => {
    render(
      <Button variant="outline" data-testid="btn">
        Go
      </Button>,
    );
    const btn = screen.getByTestId("btn");
    expect(btn.getAttribute("data-variant")).toBe("outline");
    expect(btn.className).toContain("border-cream");
  });

  it("renders an anchor when href is given", () => {
    render(
      <Button href="/create" data-testid="btn">
        Go
      </Button>,
    );
    const a = screen.getByTestId("btn");
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("/create");
  });

  it.each([
    ["variant disabled", { variant: "disabled" as const }],
    ["disabled prop", { disabled: true }],
  ])("is natively and aria disabled via %s", (_label, props) => {
    render(
      <Button {...props} data-testid="btn">
        Go
      </Button>,
    );
    const btn = screen.getByTestId("btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("data-variant")).toBe("disabled");
    expect(btn.className).toContain("bg-smoke");
  });

  it("keeps external links as plain anchors", () => {
    render(
      <Button href="https://example.com/x" data-testid="btn">
        Go
      </Button>,
    );
    const a = screen.getByTestId("btn");
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("https://example.com/x");
  });

  it("handles internal link clicks client-side via the router (no full page load)", () => {
    const push = vi.fn().mockResolvedValue(true);
    const router = {
      push,
      replace: vi.fn().mockResolvedValue(true),
      prefetch: vi.fn().mockResolvedValue(undefined),
      locale: undefined,
      isLocaleDomain: false,
    } as unknown as NextRouter;
    render(
      <RouterContext.Provider value={router}>
        <Button href="/play/abc" data-testid="btn">
          Go
        </Button>
      </RouterContext.Provider>,
    );
    const a = screen.getByTestId("btn");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("renders a disabled href button as a disabled <button>, not a link", () => {
    render(
      <Button href="/x" variant="disabled" data-testid="btn">
        Go
      </Button>,
    );
    const btn = screen.getByTestId("btn");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("href")).toBeNull();
  });
});
