/**
 * Entry point of the Sandbox_Runtime: the script that runs inside the sandboxed iframe
 * (design 7.8, Requirements 27.15, 28 and 29). esbuild bundles it, with `react`, `react-dom`,
 * `remotion`, `@remotion/player` and the protocol schemas, into `public/sandbox/runtime.js`
 * (task 26.4). The last line of this file calls `startRuntime`; everything above is a function
 * that takes its environment as a parameter (`RuntimeDeps`), so the tests drive it with a fake
 * window, a fake clock and fake timers.
 *
 * What it does, in order:
 * 1. Stops completely unless `window.origin` is `"null"`, the origin of a document in an iframe
 *    sandboxed without `allow-same-origin`. Loaded as a top-level page it sets no listener, runs no
 *    bundle and sends nothing (Req 27.15).
 * 2. Installs the `message` listener (it believes only `event.source === window.parent` and only
 *    messages that pass the protocol schema), `window.onerror` and `unhandledrejection`.
 * 3. Sends exactly one `ready` with an empty `session`, then a `heartbeat` every 1000 ms.
 * 4. On the first `load` (later ones are ignored) it adopts the message's `session` for everything
 *    it sends from then on, and hands the bundle to `evaluateBundle` (contract version, shim,
 *    evaluation, `meta`, default export). Any refusal is one `error` of phase `load`.
 * 5. Mounts the `Player` (`controls`, `clickToPlay`, `loop`, `autoPlay` and
 *    `moveToBeginningWhenEnded` all off, `acknowledgeRemotionLicense`) around the animation's
 *    `Main`. When `Main` and the first frame have rendered it sends `loaded` and waits at frame 0.
 * 6. From `loaded` on it passes the parent's commands (`setMode`, `play`, `pause`, `seek`,
 *    `resume`) to the `RuntimeController`, and the Player's `frameupdate` and `ended` to it as
 *    well, once the parent has commanded anything. Commands before `loaded`, or with another
 *    `session`, are ignored.
 *
 * Errors. The first of these is sent as one `error` and ends everything: `window.onerror`
 * (`UNCAUGHT_ERROR`), `unhandledrejection` (`UNHANDLED_REJECTION`), a render exception in `Main`
 * or in the Player (`RENDER_THROW`), or an exception in this runtime's own logic
 * (`RUNTIME_INTERNAL`: every entry point below is wrapped, so nothing escapes). After it the
 * controller is halted, the heartbeat stops and no other message is sent (Req 29.16). Only the
 * first error is reported (Req 29.4).
 *
 * `Main` renders inside two error boundaries. The inner one is around `Main` itself, inside the
 * Player's composition, because the Player has its own boundary that would show a placeholder and
 * only emit an event: this one reports `RENDER_THROW` at once, even for a throw during the very
 * first render, before the Player's ref is attached. The outer one is around the Player.
 *
 * Network. This runtime never calls `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or
 * `navigator.sendBeacon` (Req 29.17). The page's CSP (`connect-src 'none'`) enforces it too.
 *
 * Pieces, one file each: `controller.ts` decides what every command and Player report means (pure
 * logic); `evaluate.ts` checks the contract and runs the bundle; `shim.ts` is the `require` the
 * bundle gets; `player-port.ts` joins the controller to the real Player (it holds calls until a
 * remounted Player exists); `page.ts` holds the shared constants. This file only wires them to
 * `window` and React.
 *
 * Imports from the repo use the `@/` alias, imports inside this folder are relative.
 */

import { Component, useEffect, type FunctionComponent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Player } from "@remotion/player";
import { CONTRACT_READ, type ReadContractResult } from "@/lib/animation/contract";
import {
  SANDBOX_SOURCE,
  SANDBOX_VERSION,
  decodeMessage,
  encodeMessage,
  isParentMessage,
  type FrameMessage,
  type ParentMessage,
} from "@/lib/animation/protocol";
import { createRuntimeController, type FrameMessageBody, type RuntimeController } from "./controller";
import { evaluateBundle, type AnimationMeta } from "./evaluate";
import {
  HEARTBEAT_INTERVAL_MS,
  OPAQUE_ORIGIN,
  ROOT_ELEMENT_ID,
  RUNTIME_ERROR_PHASE,
  type RuntimeErrorCode,
} from "./page";
import { createDeferredPort } from "./player-port";

/** The part of `window` the runtime uses; the real `window` fits this shape. */
export interface RuntimeWindow {
  readonly origin: string;
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  onerror: OnErrorEventHandler;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "unhandledrejection", listener: (event: PromiseRejectionEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(
    type: "unhandledrejection",
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
}

/** Everything `startRuntime` takes from its environment. */
export interface RuntimeDeps {
  win: RuntimeWindow;
  /** The element the Player is mounted in (`<div id="root">`); `null` when the page lacks it. */
  getRoot(): HTMLElement | null;
  /** Result of reading the contract copy that ships with the runtime. */
  contract: ReadContractResult;
  /** A monotonic clock in milliseconds. */
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export type StartResult = { ok: true; stop(): void } | { ok: false; reason: "origin" };

/** Catches what a child component throws while rendering and reports it once. */
class RenderBoundary extends Component<
  { onError(error: unknown): void; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Renders nothing; its effect runs once `Main` and its siblings have been committed. */
function FirstFrame({ onRendered }: { onRendered(): void }): null {
  useEffect(() => {
    onRendered();
  }, [onRendered]);
  return null;
}

export function startRuntime(deps: RuntimeDeps): StartResult {
  const { win } = deps;
  // 1. Not an opaque origin: this is not the sandboxed iframe. Do nothing at all.
  if (win.origin !== OPAQUE_ORIGIN) return { ok: false, reason: "origin" };

  /** `session` of the first `load`; empty until then (Req 28.13). */
  let session = "";
  let loadSeen = false;
  /** `loaded` was sent: commands are accepted from now on. */
  let loadedSent = false;
  /** The parent has sent a command: the Player's own reports are passed on. */
  let commanded = false;
  /** An `error` was sent (or the runtime was stopped): nothing more is sent or done. */
  let ended = false;
  let heartbeatId: unknown = null;
  let controller: RuntimeController | null = null;
  let root: Root | null = null;

  function post(body: FrameMessageBody): void {
    if (ended) return;
    postUnchecked(body);
  }

  function postUnchecked(body: FrameMessageBody): void {
    try {
      const message = {
        source: SANDBOX_SOURCE,
        version: SANDBOX_VERSION,
        session,
        ...body,
      } as FrameMessage;
      win.parent.postMessage(encodeMessage(message), "*");
    } catch {
      // The parent is gone or refused the message; there is nobody to tell.
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatId === null) return;
    deps.clearInterval(heartbeatId);
    heartbeatId = null;
  }

  /** Sends the one `error`, then stops playback and the heartbeat for good (Req 29.16). */
  function fail(code: RuntimeErrorCode): void {
    if (ended) return;
    postUnchecked({ type: "error", phase: RUNTIME_ERROR_PHASE[code], code });
    ended = true;
    stopHeartbeat();
    try {
      controller?.halt();
    } catch {
      // The Player may be the thing that broke; the error is already out.
    }
  }

  /** Runs `fn`; an exception becomes `RUNTIME_INTERNAL` instead of escaping (Req 29.13). */
  function guard(fn: () => void): void {
    try {
      fn();
    } catch {
      fail("RUNTIME_INTERNAL");
    }
  }

  function onMessage(event: MessageEvent): void {
    guard(() => {
      if (ended || event.source !== win.parent) return;
      const decoded = decodeMessage(event.data);
      if (!decoded.ok || !isParentMessage(decoded.message)) return;
      const message = decoded.message;
      if (message.type === "load") {
        if (!loadSeen) handleLoad(message);
        return;
      }
      if (!loadedSent || message.session !== session) return;
      commanded = true;
      controller?.command(message);
    });
  }

  function handleLoad(message: Extract<ParentMessage, { type: "load" }>): void {
    loadSeen = true;
    session = message.session;
    const evaluated = evaluateBundle(
      { bundle: message.bundle, meta: message.meta, contractVersion: message.contract_version },
      deps.contract,
    );
    if (!evaluated.ok) {
      fail(evaluated.code);
      return;
    }
    const element = deps.getRoot();
    if (element === null) {
      fail("RUNTIME_INTERNAL");
      return;
    }
    mount(element, evaluated.meta, evaluated.Main);
  }

  function mount(element: HTMLElement, meta: AnimationMeta, Main: FunctionComponent): void {
    let mountKey = 0;

    const deferred = createDeferredPort({
      requestRemount() {
        mountKey += 1;
        root?.render(view());
      },
      onFrame(frame) {
        guard(() => {
          if (!ended && loadedSent && commanded) controller?.onPlayerFrame(frame);
        });
      },
      onEnded() {
        guard(() => {
          if (!ended && loadedSent && commanded) controller?.onPlayerEnded();
        });
      },
      onFault: () => fail("RUNTIME_INTERNAL"),
    });
    controller = createRuntimeController({
      meta: { durationInFrames: meta.durationInFrames, pauseAtFrame: meta.pauseAtFrame },
      port: deferred.port,
      post,
      now: deps.now,
    });

    /** `Main` and the first frame rendered: tell the parent, once. */
    function onFirstFrame(): void {
      guard(() => {
        if (ended || loadedSent) return;
        loadedSent = true;
        post({ type: "loaded", duration_in_frames: meta.durationInFrames });
      });
    }

    const onRenderError = () => fail("RENDER_THROW");

    const Composition = () => (
      <RenderBoundary onError={onRenderError}>
        <Main />
        <FirstFrame onRendered={onFirstFrame} />
      </RenderBoundary>
    );

    function view(): ReactNode {
      return (
        <RenderBoundary onError={onRenderError}>
          <Player
            key={mountKey}
            ref={deferred.attach}
            component={Composition}
            compositionWidth={meta.width}
            compositionHeight={meta.height}
            fps={meta.fps}
            durationInFrames={meta.durationInFrames}
            controls={false}
            clickToPlay={false}
            doubleClickToFullscreen={false}
            spaceKeyToPlayOrPause={false}
            allowFullscreen={false}
            loop={false}
            moveToBeginningWhenEnded={false}
            autoPlay={false}
            acknowledgeRemotionLicense
            errorFallback={() => null}
            style={{ width: "100%", height: "100%" }}
          />
        </RenderBoundary>
      );
    }

    root = createRoot(element);
    root.render(view());
  }

  function onError(): boolean {
    fail("UNCAUGHT_ERROR");
    return false;
  }

  function onUnhandledRejection(): void {
    fail("UNHANDLED_REJECTION");
  }

  // 2. Listeners first, so nothing that happens from here on is missed.
  win.addEventListener("message", onMessage);
  win.onerror = onError;
  win.addEventListener("unhandledrejection", onUnhandledRejection);

  // 3. One `ready` (empty session), then the heartbeat.
  post({ type: "ready" });
  heartbeatId = deps.setInterval(() => guard(() => post({ type: "heartbeat" })), HEARTBEAT_INTERVAL_MS);

  return {
    ok: true,
    stop() {
      ended = true;
      stopHeartbeat();
      win.removeEventListener("message", onMessage);
      win.removeEventListener("unhandledrejection", onUnhandledRejection);
      if (win.onerror === onError) win.onerror = null;
      const mounted = root;
      root = null;
      try {
        mounted?.unmount();
      } catch {
        // Tearing down after a failure; nothing depends on the unmount succeeding.
      }
    },
  };
}

/** The environment of the real iframe. */
export function browserDeps(): RuntimeDeps {
  return {
    win: window,
    getRoot: () => document.getElementById(ROOT_ELEMENT_ID),
    contract: CONTRACT_READ,
    now: () => performance.now(),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (id) => window.clearInterval(id as number),
  };
}

if (typeof window !== "undefined") startRuntime(browserDeps());
