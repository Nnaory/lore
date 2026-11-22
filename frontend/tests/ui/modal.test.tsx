/**
 * @vitest-environment jsdom
 *
 * modal.test.tsx - the shared Modal (Pola M, task 7.3).
 *
 * Why: every dialog relies on the same behaviour: ARIA roles, initial focus on
 * `data-autofocus`, a Tab trap, Escape / scrim close, focus returning to the
 * opener, and a portal outside the scaled board.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";

afterEach(cleanup);

function Fixture({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <Modal onClose={onClose} labelledBy="t" data-testid="m">
      <h2 id="t">Title</h2>
      <button data-testid="first">First</button>
      <button data-testid="auto" data-autofocus>
        Auto
      </button>
      <button data-testid="last">Last</button>
    </Modal>
  );
}

describe("Modal", () => {
  it("exposes dialog semantics and portals into document.body", () => {
    const { container } = render(<Fixture />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("t");
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.closest("[data-testid=m-scrim]")?.parentElement).toBe(document.body);
  });

  it("focuses the data-autofocus element first", () => {
    render(<Fixture />);
    expect(document.activeElement).toBe(screen.getByTestId("auto"));
  });

  it("wraps Tab from last to first and Shift+Tab from first to last", () => {
    render(<Fixture />);
    screen.getByTestId("last").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByTestId("first"));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("last"));
  });

  it("calls onClose on Escape and on scrim click, but not on panel click", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("m-scrim"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the opener when it unmounts", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
          {open && <Fixture onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByTestId("auto"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
