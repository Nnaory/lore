/**
 * @vitest-environment jsdom
 *
 * status-badge.test.tsx - StatusBadge variants (task 9.3).
 *
 * Why: the badge carries story state in CampaignLobby; each variant must be
 * identifiable by `data-variant` and must stay flat (no radius) per the Kit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/StatusBadge";

afterEach(cleanup);

const VARIANTS: StatusBadgeVariant[] = ["done", "current", "available", "locked"];

describe("StatusBadge", () => {
  it.each(VARIANTS)("renders the %s variant with data-variant and its label", (variant) => {
    render(
      <StatusBadge variant={variant} data-testid="badge">
        Label {variant}
      </StatusBadge>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.getAttribute("data-variant")).toBe(variant);
    expect(badge.textContent).toBe(`Label ${variant}`);
  });

  it("uses a distinct class set per variant", () => {
    const classes = VARIANTS.map((variant) => {
      const { getByTestId, unmount } = render(
        <StatusBadge variant={variant} data-testid="badge">
          x
        </StatusBadge>,
      );
      const cls = getByTestId("badge").className;
      unmount();
      return cls;
    });
    expect(new Set(classes).size).toBe(VARIANTS.length);
  });

  it.each(VARIANTS)("has no rounded class in the %s variant", (variant) => {
    render(
      <StatusBadge variant={variant} data-testid="badge">
        x
      </StatusBadge>,
    );
    expect(screen.getByTestId("badge").className).not.toMatch(/rounded/);
  });
});
