/**
 * Global test setup.
 * Imported by vitest before every test file via vitest.config.ts setupFiles.
 */
import "@testing-library/jest-dom";

// jsdom does not implement scrollIntoView — polyfill it for component tests.
if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
