/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChaptersSection } from "@/components/setup/ChaptersSection";

describe("ChaptersSection", () => {
  it("draws five boxes, default 3 selected, 1/2/4 aria-disabled", () => {
    render(<ChaptersSection length="short" onLengthChange={() => {}} />);
    const boxes = screen.getAllByRole("radio");
    expect(boxes).toHaveLength(5);
    expect(screen.getByTestId("chapters-3").getAttribute("aria-checked")).toBe("true");
    for (const n of [1, 2, 4]) {
      expect(screen.getByTestId(`chapters-${n}`).getAttribute("aria-disabled")).toBe("true");
    }
    expect(screen.getByTestId("chapters-5").getAttribute("aria-disabled")).toBeNull();
  });

  it("maps 5 to medium and ignores disabled boxes", () => {
    const onChange = vi.fn();
    render(<ChaptersSection length="short" onLengthChange={onChange} />);
    fireEvent.click(screen.getByTestId("chapters-4"));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("chapters-5"));
    expect(onChange).toHaveBeenCalledWith("medium");
  });

  it("toggles the advanced panel", () => {
    render(<ChaptersSection length="short" onLengthChange={() => {}} advanced={<p>panel</p>} />);
    expect(screen.queryByText("panel")).toBeNull();
    fireEvent.click(screen.getByTestId("advanced-toggle"));
    expect(screen.getByText("panel")).toBeTruthy();
  });
});
