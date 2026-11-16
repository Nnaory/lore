/**
 * usePlayerAvatar — the saved avatar, kept in sync with localStorage
 * (saves in this tab and in other tabs). Renders the default avatar on the
 * server and during hydration.
 */

"use client";

import { useMemo, useSyncExternalStore } from "react";
import { AVATAR_EVENT, AVATAR_KEY, parseAvatar, readStoredAvatar, type PlayerAvatar } from "./avatar";

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === AVATAR_KEY) onChange();
  };
  window.addEventListener(AVATAR_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(AVATAR_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePlayerAvatar(): PlayerAvatar {
  const raw = useSyncExternalStore(subscribe, readStoredAvatar, () => null);
  return useMemo(() => parseAvatar(raw), [raw]);
}
