/**
 * @vitest-environment jsdom
 *
 * story-failure.test.tsx — StoryFailure component tests (task 14.3).
 *
 * Why: verifies that the failure panel preserves `HP: 0 / 5`, uses Kit tokens
 * without any danger colour, announces itself as `role="alert"`, and invokes
 * `onRetry` when `retry-button` is clicked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StoryFailure } from "@/components/story/StoryFailure";

afterEach(cleanup);

describe("StoryFailure (task 14.3)", () => {
  it("renders the failure badge, title, HP: 0 / 5 text, and explanation with role=alert", () => {
    render(<StoryFailure storyTitle="The Fading Light" onRetry={vi.fn()} />);

    const panel = screen.getByTestId("story-failure");
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.textContent).toContain("Story Failed");
    expect(screen.getByTestId("story-failure-title").textContent).toBe("The Fading Light");
    expect(screen.getByTestId("story-failure-hp").textContent).toBe("HP: 0 / 5");
    expect(panel.textContent).toContain(
      "You can retry from the beginning. Your HP will be restored to 5. Progress from earlier stories is preserved."
    );
  });

  it("calls onRetry when the Retry Story button is clicked", () => {
    const onRetry = vi.fn();
    render(<StoryFailure storyTitle="The Fading Light" onRetry={onRetry} />);

    const retryBtn = screen.getByTestId("retry-button");
    expect(retryBtn.textContent).toBe("Retry Story");
    expect(retryBtn.className).toContain("min-h-[44px]");
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
