/**
 * SandboxFrame: the iframe that runs an AI-written animation, and the parent side of its
 * message channel (design 7.7, Requirements 27.1, 27.8, 27.14, 28.3, 28.5, 28.9).
 *
 * The animation bundle is code written by a model, so it never runs in the app's own page. It runs
 * in `/sandbox/runtime.html` inside an iframe with `sandbox="allow-scripts"` and nothing else (no
 * `allow-same-origin`), which gives the document an opaque origin: it cannot read the app's
 * cookies, storage or DOM. The two sides talk only through `postMessage`.
 *
 * What this component does, and nothing more:
 * - renders the iframe with the attributes of `sandbox-policy.json` (`src`, `sandbox`), no
 *   referrer, no tab stop and `pointer-events: none` (the Stage keeps all the controls);
 * - makes a new Session_Id per mount and a `SandboxController` for it, with the real clock
 *   (`window.setTimeout`, and `performance.now` for the monotonic time the rate limit needs);
 * - listens for `message` on `window` and hands `{source, origin, data}` to the controller, which
 *   decides what to believe. `frameWindow` is the iframe's own `contentWindow`, which must not be
 *   null; if the browser gives none, the frame fails with phase `load` at once;
 * - posts to the iframe with target origin `*`, because the origin of a sandboxed document is
 *   opaque and cannot be named. Only the bundle, its metadata and playback commands are sent, none
 *   of them secret (Requirement 28.5);
 * - builds the `SandboxPlayerRef` with `createSandboxPlayerRef(controller)` and gives every message
 *   the controller forwards (`loaded`, `frame`, `paused`, `ended`) to `ref.onFrameMessage` first,
 *   then to `onMessage`, so the PlayerBar's listeners are told before the owner reacts.
 *
 * Failure and unmount. When the controller fails (or a `postMessage` throws, which the watchdogs
 * then turn into a timeout), the frame disposes the ref, stops listening, removes the iframe from
 * the DOM and calls `onFail(phase)` exactly once. Unmounting does the same teardown but calls
 * nothing: no owner callback and no `postMessage` happens after it, and the next mount makes
 * a new Session_Id, so a message from the old iframe cannot be mistaken for the new one.
 *
 * The bundle, meta and contract version are read once, at mount. A frame is for one animation: a
 * new animation is a new mount (the Stage keys the scene), never a changed prop. `hidden` is the
 * only prop that may change; it toggles `visibility`, not `display`, so the browser keeps laying
 * the iframe out and rendering it while it is out of sight (Requirement 30.5).
 *
 * No game rules and no Remotion import: it only moves messages.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import type { FrameMessage, LoadMeta } from "@/lib/animation/protocol";
import {
  createSandboxController,
  type SandboxFailPhase,
} from "@/lib/animation/sandbox-controller";
import {
  createSandboxPlayerRef,
  type SandboxPlayerRefHandle,
} from "@/lib/animation/sandbox-player-ref";
import policy from "@/lib/animation/sandbox-policy.json";
import { newSessionId } from "@/lib/animation/session";

export type SandboxFrameProps = {
  /** Text of the verified `main.js`. Read once, at mount. */
  bundle: string;
  /** `load.meta` of the protocol (snake_case). Read once, at mount. */
  meta: LoadMeta;
  /** Contract version the bundle was built for. Read once, at mount. */
  contractVersion: number;
  /** `visibility: hidden` instead of visible; the iframe stays in the layout either way. */
  hidden: boolean;
  /** Called once, when the frame is mounted, with the player the Stage can drive. */
  onPlayerRef: (ref: SandboxPlayerRefHandle) => void;
  /** Receives `loaded`, `frame`, `paused` and `ended` after the status and the ref have seen them. */
  onMessage: (message: FrameMessage) => void;
  /** Called once if the frame fails (never after an unmount). */
  onFail: (phase: SandboxFailPhase) => void;
};

export function SandboxFrame({
  bundle,
  meta,
  contractVersion,
  hidden,
  onPlayerRef,
  onMessage,
  onFail,
}: SandboxFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Fixed for the life of this mount: a new animation is a new mount, not a changed prop.
  const [init] = useState(() => ({ session: newSessionId(), bundle, meta, contractVersion }));
  const [removed, setRemoved] = useState(false);

  // The callbacks may change between renders; the effect below must not restart because of that.
  const callbacks = useRef({ onPlayerRef, onMessage, onFail });
  useEffect(() => {
    callbacks.current = { onPlayerRef, onMessage, onFail };
  });

  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow ?? null;
    if (frameWindow === null) {
      setRemoved(true);
      callbacks.current.onFail("load");
      return;
    }

    let live = true;
    let player: SandboxPlayerRefHandle | null = null;
    // The same listener function must be passed to `removeEventListener`.
    const onWindowMessage = (event: MessageEvent): void => {
      if (live) controller.handleEvent({ source: event.source, origin: event.origin, data: event.data });
    };
    /** Stops everything. Safe to call twice. */
    const teardown = (): void => {
      live = false;
      window.removeEventListener("message", onWindowMessage);
      controller.dispose();
      player?.dispose();
    };

    const controller = createSandboxController({
      session: init.session,
      frameWindow,
      postToFrame: (message) => {
        if (!live) return;
        try {
          frameWindow.postMessage(message, "*");
        } catch {
          // Nothing arrives; the controller's `loaded` or heartbeat timer fails the frame.
        }
      },
      timers: {
        set: (fn, ms) => window.setTimeout(fn, ms),
        clear: (id) => window.clearTimeout(id),
        now: () => performance.now(),
      },
      onMessage: (message) => {
        if (!live) return;
        player?.onFrameMessage(message);
        callbacks.current.onMessage(message);
      },
      onFail: (phase) => {
        if (!live) return;
        teardown();
        setRemoved(true);
        callbacks.current.onFail(phase);
      },
      bundle: init.bundle,
      meta: init.meta,
      contractVersion: init.contractVersion,
    });
    player = createSandboxPlayerRef(controller);
    window.addEventListener("message", onWindowMessage);
    callbacks.current.onPlayerRef(player);

    return teardown;
  }, [init]);

  if (removed) return null;
  return (
    <iframe
      ref={iframeRef}
      data-testid="sandbox-frame"
      title="Lesson animation"
      sandbox={policy.sandbox_attribute}
      src={policy.src}
      referrerPolicy="no-referrer"
      tabIndex={-1}
      style={{
        width: "100%",
        height: "100%",
        border: 0,
        pointerEvents: "none",
        visibility: hidden ? "hidden" : "visible",
      }}
    />
  );
}
