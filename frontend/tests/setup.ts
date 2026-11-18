/**
 * Global test setup.
 * Imported by vitest before every test file via vitest.config.ts setupFiles.
 */
import "@testing-library/jest-dom";
// In-memory IndexedDB (the project store) for node and jsdom tests.
import "fake-indexeddb/auto";

// jsdom does not implement scrollIntoView — polyfill it for component tests.
if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView = function () {};

  // jsdom's Blob/File lack text() and arrayBuffer(), which every current
  // browser supports. Implement them with jsdom's FileReader.
  const BlobProto = window.Blob.prototype as Blob;
  const read = <T,>(blob: Blob, method: "readAsText" | "readAsArrayBuffer") =>
    new Promise<T>((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result as T);
      reader.onerror = () => reject(reader.error);
      reader[method](blob);
    });
  if (typeof BlobProto.text !== "function") {
    BlobProto.text = function (this: Blob) {
      return read<string>(this, "readAsText");
    };
  }
  if (typeof BlobProto.arrayBuffer !== "function") {
    BlobProto.arrayBuffer = function (this: Blob) {
      return read<ArrayBuffer>(this, "readAsArrayBuffer");
    };
  }

  // Node 25+ defines its own global `localStorage` (undefined unless Node is
  // started with --localstorage-file), which shadows jsdom's. Install the
  // jsdom instance's real Storage so browser code sees a working one.
  const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
  if (!globalThis.localStorage && dom) {
    for (const key of ["localStorage", "sessionStorage"] as const) {
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
    }
  }
}
