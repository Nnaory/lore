// @vitest-environment jsdom
/**
 * Tests: useOnReveal (task 27.2), the Activity limitation recorded for task 27.1.
 *
 * React's `<Activity mode="hidden">` cleans up a component's effects and sets them up again when it
 * is visible. The hook must call `onReveal` once per hide-and-show, and never on first mount, in
 * Strict Mode, or on unmount. Time matters (the hook tells a hide from Strict Mode's synchronous
 * re-run by yielding to the microtask queue), so these tests yield with `await act(async ...)`
 * between hiding and showing, as a real navigation would.
 */
import { act, cleanup, render } from "@testing-library/react";
import { Activity, StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOnReveal } from "@/lib/stage/use-on-reveal";

afterEach(cleanup);

function Probe({ onReveal }: { onReveal: () => void }) {
  useOnReveal(onReveal);
  return <p data-testid="probe">probe</p>;
}

/** Lets the microtask the hook queues on clean-up run. */
const yieldToMicrotasks = () => act(async () => {});

function page(mode: "visible" | "hidden", onReveal: () => void, wrap?: (node: ReactNode) => ReactNode): ReactNode {
  const node = (
    <Activity mode={mode}>
      <Probe onReveal={onReveal} />
    </Activity>
  );
  return wrap ? wrap(node) : node;
}

describe("useOnReveal", () => {
  it("does not call onReveal on first mount", async () => {
    const onReveal = vi.fn();
    render(<Probe onReveal={onReveal} />);
    await yieldToMicrotasks();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("does not call onReveal on first mount in Strict Mode, where effects run, clean up and run again", async () => {
    const onReveal = vi.fn();
    render(
      <StrictMode>
        <Probe onReveal={onReveal} />
      </StrictMode>,
    );
    await yieldToMicrotasks();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("does not call onReveal when the component is unmounted", async () => {
    const onReveal = vi.fn();
    const view = render(<Probe onReveal={onReveal} />);
    view.unmount();
    await yieldToMicrotasks();
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("calls onReveal once when Activity hides the page and shows it again", async () => {
    const onReveal = vi.fn();
    const view = render(page("visible", onReveal));
    await yieldToMicrotasks();

    view.rerender(page("hidden", onReveal));
    await yieldToMicrotasks();
    expect(onReveal).not.toHaveBeenCalled(); // hidden is not revealed

    view.rerender(page("visible", onReveal));
    await yieldToMicrotasks();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("calls it once per reveal across several hide-and-show cycles", async () => {
    const onReveal = vi.fn();
    const view = render(page("visible", onReveal));
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      view.rerender(page("hidden", onReveal));
      await yieldToMicrotasks();
      view.rerender(page("visible", onReveal));
      await yieldToMicrotasks();
      expect(onReveal).toHaveBeenCalledTimes(cycle);
    }
  });

  it("calls it once, not twice, in Strict Mode (the page's effects run twice on reveal)", async () => {
    const onReveal = vi.fn();
    const strict = (node: ReactNode) => <StrictMode>{node}</StrictMode>;
    const view = render(page("visible", onReveal, strict));
    await yieldToMicrotasks();
    expect(onReveal).not.toHaveBeenCalled();

    view.rerender(page("hidden", onReveal, strict));
    await yieldToMicrotasks();
    view.rerender(page("visible", onReveal, strict));
    await yieldToMicrotasks();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("calls the latest callback, not the one from the render that set the effect up", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(page("visible", first));
    await yieldToMicrotasks();
    view.rerender(page("hidden", second));
    await yieldToMicrotasks();
    view.rerender(page("visible", second));
    await yieldToMicrotasks();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not call it after the component was unmounted while hidden", async () => {
    const onReveal = vi.fn();
    const view = render(page("visible", onReveal));
    view.rerender(page("hidden", onReveal));
    await yieldToMicrotasks();
    view.unmount();
    await yieldToMicrotasks();
    expect(onReveal).not.toHaveBeenCalled();
  });
});
