/**
 * sandbox-harness.ts: a fake iframe window and message helpers for the Sandbox_Frame and
 * Animation_Scene tests (task 27.1).
 *
 * jsdom does not run `/sandbox/runtime.html`, and the tests must not depend on a real browser. So
 * `HTMLIFrameElement.prototype.contentWindow` is replaced with one plain object that has a
 * `postMessage` spy: what the Sandbox_Frame posts lands in `posted()`, and `deliver` dispatches a
 * `message` event on the real `window` whose `source` is that object, the way a browser reports a
 * message from the iframe. The event is a plain `Event` with `data`, `origin` and `source` defined
 * on it, because jsdom's `MessageEvent` refuses a `source` that is not a real window.
 *
 * The helpers build the messages the runtime sends (`ready`, `loaded`, `frame`, `paused`,
 * `ended`, `error`, `heartbeat`) with the Session_Id the Sandbox_Frame chose, which the harness
 * learns from the `load` message it posted. Every dispatch is wrapped in `act` so React state
 * updates caused by a message are flushed before the test reads the DOM.
 *
 * Not a test file (Vitest only collects `*.test.ts(x)`). Needs the `jsdom` environment.
 */

import { act } from "@testing-library/react";
import { vi } from "vitest";

const ENVELOPE = { source: "lore-sandbox", version: 1 } as const;

export interface PostedMessage {
  type: string;
  session: string;
  [key: string]: unknown;
}

export interface DeliverOptions {
  /** Defaults to the fake iframe window. */
  source?: unknown;
  /** Defaults to `"null"`, the origin of a sandboxed iframe. */
  origin?: string;
}

export function createSandboxHarness() {
  const fakeWindow = { postMessage: vi.fn() };
  const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  let frameWindow: unknown = fakeWindow;
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get: () => frameWindow,
  });

  /** Every message posted to the iframe, in order. */
  const posted = (): PostedMessage[] =>
    fakeWindow.postMessage.mock.calls.map((call) => call[0] as PostedMessage);

  /** The target origin of every `postMessage` call. */
  const targets = (): unknown[] => fakeWindow.postMessage.mock.calls.map((call) => call[1]);

  const postedOfType = (type: string): PostedMessage[] =>
    posted().filter((message) => message.type === type);

  /** The Session_Id the frame chose; known once the `load` message has been posted. */
  const session = (): string => {
    const load = postedOfType("load")[0];
    if (!load) throw new Error("the frame has not posted `load` yet");
    return load.session;
  };

  const dispatch = (data: unknown, options: DeliverOptions = {}): void => {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: { value: data },
      origin: { value: options.origin ?? "null" },
      source: { value: "source" in options ? options.source : fakeWindow },
    });
    act(() => {
      window.dispatchEvent(event);
    });
  };

  const message = (type: string, fields: Record<string, unknown> = {}, sessionId?: string) => ({
    ...ENVELOPE,
    type,
    session: sessionId ?? session(),
    ...fields,
  });

  return {
    fakeWindow,
    posted,
    postedOfType,
    targets,
    session,
    /** Dispatches `data` as a message event from the iframe (or from `options.source`). */
    deliver: dispatch,
    /** The messages of the runtime, with the live Session_Id (`ready` has the empty one). */
    ready: () => dispatch(message("ready", {}, "")),
    loaded: (durationInFrames: number) =>
      dispatch(message("loaded", { duration_in_frames: durationInFrames })),
    frame: (frame: number, playing: boolean) => dispatch(message("frame", { frame, playing })),
    paused: (reason: "interaction" | "end", frame: number) =>
      dispatch(message("paused", { reason, frame })),
    ended: () => dispatch(message("ended")),
    heartbeat: () => dispatch(message("heartbeat")),
    error: (phase: "load" | "runtime", code = "RENDER_THROW") =>
      dispatch(message("error", { phase, code })),
    /** A message built with the live Session_Id, to dispatch it with other options. */
    build: message,
    /** Makes `contentWindow` return `value` (for example `null`) from now on. */
    setFrameWindow(value: unknown): void {
      frameWindow = value;
    },
    restore(): void {
      if (original) Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", original);
      else Reflect.deleteProperty(HTMLIFrameElement.prototype, "contentWindow");
    },
  };
}

export type SandboxHarness = ReturnType<typeof createSandboxHarness>;
