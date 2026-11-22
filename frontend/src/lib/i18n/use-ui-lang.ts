'use client';

/**
 * UI language before a story exists (DESIGN-SYSTEM §9): the saved setting
 * (`localStorage['lore.lang']`), then the browser language, then English —
 * via `detectUiLang`. Server render and the first client render use English
 * (no hydration mismatch); the detected language applies right after.
 * Re-reads when another tab changes the setting or the browser language changes.
 */
import { useSyncExternalStore } from 'react';
import { detectUiLang, type UiLang } from './ui';

export const UI_LANG_STORAGE_KEY = 'lore.lang';

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(UI_LANG_STORAGE_KEY);
  } catch {
    return null; // storage blocked (privacy mode): fall back to the browser language
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener('languagechange', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener('languagechange', onChange);
  };
}

const getSnapshot = (): UiLang => detectUiLang(readSaved(), window.navigator.language);
const getServerSnapshot = (): UiLang => 'en';

export function useUiLang(): UiLang {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
