/**
 * use-on-reveal.ts: tells a component that React's `<Activity>` has made it visible again after
 * hiding it (design 7.6; the limitation recorded for task 27.1).
 *
 * Why it exists. With `cacheComponents`, a page the player leaves stays mounted inside a hidden
 * `<Activity>`: its state is kept, its DOM stays in the document, but every effect is cleaned up and
 * is set up again when the page is shown. The sandbox iframe survives that (it is just DOM), yet
 * the `SandboxFrame` controller that talked to it is disposed on hide, and its replacement waits for
 * a `ready` message the iframe sent only once, long ago. The animation would end in `failed:timeout`
 * after 8 s. The owner of the iframe can fix that by mounting a fresh scene when it is revealed, so
 * it needs a signal for "hidden, then shown". React has no such API, so this hook derives it.
 *
 * How. An effect with no dependencies is set up on mount and after every reveal, and cleaned up on
 * unmount and on every hide. That alone cannot tell a hide from the extra clean-up and set-up that
 * Strict Mode (and Fast Refresh) runs in the same synchronous commit when a component first mounts.
 * The difference is time: a Strict Mode re-run sets the effect up again before the current task
 * yields, a real hide does not. So the clean-up only queues a microtask, and the microtask marks the
 * component as hidden if no set-up has happened by then. The next set-up that finds the mark is a
 * reveal: it clears the mark and calls `onReveal`.
 *
 * Consequences worth knowing:
 * - `onReveal` never runs on first mount, in Strict Mode, or on unmount.
 * - It runs once per hide-and-show, after the commit that shows the page.
 * - A hide and show that both happen before the microtask queue drains (no yield between them) is
 *   not seen. A router transition cannot do that, and nothing is lost: the callback is an optimisation
 *   of recovery, not a requirement for correctness.
 * - `onReveal` is read through an effect event, so it may close over the latest props and state
 *   without being a dependency.
 *
 * No game rules, no DOM access.
 */

"use client";

import { useEffect, useEffectEvent, useRef } from "react";

export function useOnReveal(onReveal: () => void): void {
  const reveal = useEffectEvent(onReveal);
  /** True between a set-up and the next clean-up. */
  const active = useRef(false);
  /** True once a clean-up was not followed by a set-up in the same task: the page was hidden. */
  const hidden = useRef(false);

  useEffect(() => {
    active.current = true;
    if (hidden.current) {
      hidden.current = false;
      reveal();
    }
    return () => {
      active.current = false;
      queueMicrotask(() => {
        if (!active.current) hidden.current = true;
      });
    };
  }, []);
}
