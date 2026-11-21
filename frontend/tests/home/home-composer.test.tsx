/**
 * Tests — home page chat field (HomeComposer)
 *
 * @vitest-environment jsdom
 *
 * The field needs a material file. Typed text is only extra instructions,
 * never material. These tests check what the player can do with it, what
 * warning they get without a file, and what /create is given.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home/HomeComposer";
import { MAX_INSTRUCTIONS_CHARS } from "@/lib/setup/create-form";
import { takePendingMaterial } from "@/lib/setup/pending-material";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => {
  push.mockReset();
  takePendingMaterial();
});

const input = () => screen.getByTestId("home-input") as HTMLTextAreaElement;
const send = () => screen.getByTestId("home-send") as HTMLButtonElement;
const attach = () => screen.getByTestId("home-attach") as HTMLButtonElement;
const warning = () => screen.queryByTestId("home-file-required");

function notesFile(name = "week3.txt") {
  return new File(["## Vectors\nA vector has direction."], name, { type: "text/plain" });
}

describe("HomeComposer — without a file", () => {
  it("cannot send while nothing is attached", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    expect(send()).toBeDisabled();

    await user.type(input(), "belajar vector");
    expect(send()).toBeDisabled();
  });

  it("warns that text alone is not material", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    expect(warning()).toBeNull();

    await user.type(input(), "belajar vector");
    expect(warning()?.getAttribute("role")).toBe("alert");
    expect(warning()?.textContent).toMatch(/attach a material file/i);
  });

  it("does not warn for spaces only", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.type(input(), "   ");
    expect(warning()).toBeNull();
  });

  it("does not navigate on Enter and keeps the typed text", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.type(input(), "belajar vector{Enter}");

    expect(push).not.toHaveBeenCalled();
    expect(takePendingMaterial()).toBeNull();
    expect(input().value).toBe("belajar vector");
    expect(warning()).not.toBeNull();
  });

  it("does nothing on Enter when the field is empty", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(push).not.toHaveBeenCalled();
    expect(takePendingMaterial()).toBeNull();
  });

  it("keeps attaching available while there is text", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.type(input(), "some notes");
    expect(attach()).toBeEnabled();
  });

  it("limits the instructions to the allowed length", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.click(input());
    await user.paste("x".repeat(MAX_INSTRUCTIONS_CHARS + 50));
    expect(input().value).toHaveLength(MAX_INSTRUCTIONS_CHARS);
    expect(screen.getByTestId("home-instructions-count").textContent).toBe(
      `${MAX_INSTRUCTIONS_CHARS} / ${MAX_INSTRUCTIONS_CHARS}`
    );
  });
});

describe("HomeComposer — with a file", () => {
  it("shows the attached file and sends it to /create with no instructions", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    const file = notesFile();
    await user.upload(screen.getByTestId("home-file-input"), file);

    expect(screen.getByTestId("home-file-chip").textContent).toContain("week3.txt");
    expect(send()).toBeEnabled();

    await user.click(send());
    expect(push).toHaveBeenCalledWith("/create");
    const taken = takePendingMaterial();
    expect(taken?.file).toBe(file);
    expect(taken?.instructions).toBe("");
    expect(screen.queryByTestId("home-file-chip")).toBeNull();
  });

  it("sends typed text along as instructions, not as material", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    const file = notesFile();
    await user.upload(screen.getByTestId("home-file-input"), file);
    await user.type(input(), "belajar vector, fokus ke dot product");
    expect(warning()).toBeNull();

    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/create");
    expect(takePendingMaterial()).toEqual({ file, instructions: "belajar vector, fokus ke dot product" });
    expect(input().value).toBe("");
  });

  it("adds a line on Shift+Enter instead of sending", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.upload(screen.getByTestId("home-file-input"), notesFile());
    await user.type(input(), "line one{Shift>}{Enter}{/Shift}line two");
    expect(input().value).toBe("line one\nline two");
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps typing available while a file is attached", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.upload(screen.getByTestId("home-file-input"), notesFile());
    expect(input()).toBeEnabled();
  });

  it("goes back to needing a file when it is removed", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.upload(screen.getByTestId("home-file-input"), notesFile());
    await user.type(input(), "tone: light");
    await user.click(screen.getByTestId("home-file-remove"));

    expect(screen.queryByTestId("home-file-chip")).toBeNull();
    expect(send()).toBeDisabled();
    expect(warning()).not.toBeNull();
  });

  it("replaces the attached file when another is chosen", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.upload(screen.getByTestId("home-file-input"), notesFile("first.txt"));
    await user.upload(screen.getByTestId("home-file-input"), notesFile("second.txt"));

    expect(screen.getByTestId("home-file-chip").textContent).toContain("second.txt");
    expect(screen.getByTestId("home-file-chip").textContent).not.toContain("first.txt");
  });
});
