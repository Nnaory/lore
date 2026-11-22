/**
 * @vitest-environment jsdom
 *
 * ending-display.test.tsx — EndingDisplay component tests (task 12.3).
 *
 * Why: verifies that each ending type maps to the right StatusBadge variant
 * and text (`Success` = done, `Failed` = locked, `Partial Success` = available),
 * and that the region carries the accessible `Story ending: {title}` label.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EndingDisplay } from "@/components/story/EndingDisplay";
import type { Ending } from "@/lib/types/scene";

afterEach(cleanup);

function makeEnding(overrides: Partial<Ending> = {}): Ending {
  return {
    ending_id: "end_1",
    title: "The Beacon Holds",
    type: "success",
    narration: "Light returns to the tower.",
    world_state_changes: {},
    relationship_changes: {},
    ...overrides,
  };
}

describe("EndingDisplay (task 12.3)", () => {
  it.each([
    ["success", "Success", "done"],
    ["failure", "Failed", "locked"],
    ["partial_success", "Partial Success", "available"],
  ] as const)("renders the %s badge as %s (%s)", (type, label, variant) => {
    render(<EndingDisplay ending={makeEnding({ type, title: `Title ${type}` })} />);

    const region = screen.getByTestId("ending-display");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe(`Story ending: Title ${type}`);

    const badge = screen.getByTestId("ending-type-badge");
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute("data-variant")).toBe(variant);
  });

  it("renders the ending title and narration inside a scrollable Kit panel", () => {
    render(
      <EndingDisplay
        ending={makeEnding({
          title: "The City Holds",
          narration: "First paragraph.\n\nSecond paragraph.",
        })}
      />
    );
    const region = screen.getByTestId("ending-display");
    expect(region.textContent).toContain("The City Holds");
    expect(region.textContent).toContain("First paragraph.");
    expect(region.textContent).toContain("Second paragraph.");
    expect(region.className).toContain("overflow-y-auto");
  });
});
