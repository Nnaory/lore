/**
 * @vitest-environment jsdom
 *
 * AdvancedOptions: language segments, instructions counter, no length selector (design 6.3).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AdvancedOptions } from "@/components/setup/AdvancedOptions";
import { ChaptersSection } from "@/components/setup/ChaptersSection";
import type { StoryLanguage } from "@/lib/setup/create-form";

function Harness() {
  const [language, setLanguage] = useState<StoryLanguage>("en");
  const [text, setText] = useState("");
  return (
    <AdvancedOptions
      language={language}
      customInstructions={text}
      onLanguageChange={setLanguage}
      onInstructionsChange={setText}
    />
  );
}

function setup(overrides: Partial<Parameters<typeof AdvancedOptions>[0]> = {}) {
  const onLanguageChange = vi.fn();
  const onInstructionsChange = vi.fn();
  render(
    <AdvancedOptions
      language="en"
      customInstructions="abc"
      onLanguageChange={onLanguageChange}
      onInstructionsChange={onInstructionsChange}
      {...overrides}
    />,
  );
  return { onLanguageChange, onInstructionsChange };
}

describe("AdvancedOptions", () => {
  it("renders language radiogroup and reports the choice", () => {
    const { onLanguageChange } = setup();
    expect(screen.getByTestId("language-en").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("language-id"));
    expect(onLanguageChange).toHaveBeenCalledWith("id");
  });

  it("shows the n / 500 counter, reports edits and has no story-length selector", () => {
    const { onInstructionsChange } = setup();
    expect(screen.getByText("3 / 500")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Instructions for the storyteller"), { target: { value: "x" } });
    expect(onInstructionsChange).toHaveBeenCalledWith("x");
    expect(screen.queryByText(/Short · 3 chapters/)).toBeNull();
  });

  it("operates the language radiogroup from the keyboard (Tab, Enter, Space)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const en = screen.getByTestId("language-en");
    const id = screen.getByTestId("language-id");
    expect(en.getAttribute("aria-checked")).toBe("true");
    await user.tab();
    expect(document.activeElement).toBe(en);
    await user.tab();
    expect(document.activeElement).toBe(id);
    await user.keyboard("{Enter}");
    expect(id.getAttribute("aria-checked")).toBe("true");
    expect(en.getAttribute("aria-checked")).toBe("false");
    await user.tab({ shift: true });
    await user.keyboard(" ");
    expect(en.getAttribute("aria-checked")).toBe("true");
  });

  it("caps instructions at 500 characters and keeps the typed text in state", async () => {
    render(<Harness />);
    const box = screen.getByLabelText("Instructions for the storyteller") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    fireEvent.change(box, { target: { value: "hello" } });
    expect(box.value).toBe("hello");
    expect(screen.getByText("5 / 500")).toBeTruthy();
    const user = userEvent.setup();
    await user.clear(box);
    await user.click(box);
    await user.paste("a".repeat(600));
    expect(box.value.length).toBe(500);
    expect(screen.getByText("500 / 500")).toBeTruthy();
  });

  it("uses 44px touch targets on the language segments", () => {
    setup();
    for (const id of ["language-en", "language-id"]) {
      expect(screen.getByTestId(id).className).toContain("h-11");
    }
  });
});

describe("ChaptersSection advanced toggle", () => {
  it("opens and closes AdvancedOptions with aria-expanded and a 44px toggle", () => {
    render(
      <ChaptersSection
        length="short"
        onLengthChange={() => {}}
        advanced={<div data-testid="advanced-options" />}
      />,
    );
    const toggle = screen.getByTestId("advanced-toggle");
    expect(toggle.className).toContain("h-11");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("advanced-options")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("advanced-options")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("advanced-options")).toBeNull();
  });
});
