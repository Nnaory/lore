/**
 * Tests — home page chat field (HomeComposer)
 *
 * @vitest-environment jsdom
 *
 * The field hands typed text or one attached file to /create. These tests
 * check what the player can do with it, and what /create is given.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home/HomeComposer";
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

function notesFile(name = "week3.txt") {
  return new File(["## Vectors\nA vector has direction."], name, { type: "text/plain" });
}

describe("HomeComposer — text", () => {
  it("cannot send while the field is empty or only spaces", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    expect(send()).toBeDisabled();

    await user.type(input(), "   ");
    expect(send()).toBeDisabled();
  });

  it("sends typed text to /create and empties the field", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.type(input(), "A vector has direction and size.");
    await user.click(send());

    expect(push).toHaveBeenCalledWith("/create");
    expect(takePendingMaterial()).toEqual({ kind: "text", text: "A vector has direction and size." });
    expect(input().value).toBe("");
  });

  it("sends on Enter and adds a line on Shift+Enter", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.type(input(), "line one{Shift>}{Enter}{/Shift}line two");
    expect(input().value).toBe("line one\nline two");
    expect(push).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/create");
    expect(takePendingMaterial()).toEqual({ kind: "text", text: "line one\nline two" });
  });

  it("does nothing on Enter when there is nothing to send", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(push).not.toHaveBeenCalled();
    expect(takePendingMaterial()).toBeNull();
  });
});

describe("HomeComposer — file", () => {
  it("shows the attached file and sends it to /create", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    const file = notesFile();
    await user.upload(screen.getByTestId("home-file-input"), file);

    expect(screen.getByTestId("home-file-chip").textContent).toContain("week3.txt");
    expect(send()).toBeEnabled();

    await user.click(send());
    expect(push).toHaveBeenCalledWith("/create");
    const taken = takePendingMaterial();
    expect(taken?.kind === "file" && taken.file).toBe(file);
    expect(screen.queryByTestId("home-file-chip")).toBeNull();
  });

  it("turns typing off while a file is attached, and back on when it is removed", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    await user.upload(screen.getByTestId("home-file-input"), notesFile());
    expect(input()).toBeDisabled();

    await user.click(screen.getByTestId("home-file-remove"));
    expect(screen.queryByTestId("home-file-chip")).toBeNull();
    expect(input()).toBeEnabled();
    expect(send()).toBeDisabled();
  });

  it("turns attaching off while there is text, so text is never dropped silently", async () => {
    const user = userEvent.setup();
    render(<HomeComposer />);
    expect(attach()).toBeEnabled();

    await user.type(input(), "some notes");
    expect(attach()).toBeDisabled();

    await user.clear(input());
    expect(attach()).toBeEnabled();
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
