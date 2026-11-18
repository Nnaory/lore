/**
 * A clean browser storage for each test: a brand-new in-memory IndexedDB
 * (fake-indexeddb), an empty localStorage, and a project store that has
 * forgotten its old connection and migration state.
 */

import { IDBFactory } from "fake-indexeddb";
import { resetProjectStoreForTests } from "@/lib/state/project-store";

export async function freshStore(): Promise<void> {
  await resetProjectStoreForTests();
  Object.defineProperty(globalThis, "indexedDB", { value: new IDBFactory(), configurable: true, writable: true });
  window.localStorage.clear();
}
