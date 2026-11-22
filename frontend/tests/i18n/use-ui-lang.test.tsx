/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useUiLang, UI_LANG_STORAGE_KEY } from "@/lib/i18n/use-ui-lang";

function Probe() {
  return <span data-testid="lang">{useUiLang()}</span>;
}
const navLang = (v: string) => vi.spyOn(window.navigator, "language", "get").mockReturnValue(v);
const shown = () => screen.getByTestId("lang").textContent;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("useUiLang", () => {
  it("uses the storage key lore.lang", () => {
    expect(UI_LANG_STORAGE_KEY).toBe("lore.lang");
  });

  it("saved id wins over navigator en-US", () => {
    navLang("en-US");
    window.localStorage.setItem("lore.lang", "id");
    render(<Probe />);
    expect(shown()).toBe("id");
  });

  it("an invalid saved value falls back to the navigator", () => {
    navLang("id-ID");
    window.localStorage.setItem("lore.lang", "klingon");
    render(<Probe />);
    expect(shown()).toBe("id");
  });

  it("navigator id-ID gives id", () => {
    navLang("id-ID");
    render(<Probe />);
    expect(shown()).toBe("id");
  });

  it("defaults to en", () => {
    navLang("fr-FR");
    render(<Probe />);
    expect(shown()).toBe("en");
  });

  it("re-reads on a storage event", () => {
    navLang("en-US");
    render(<Probe />);
    expect(shown()).toBe("en");
    act(() => {
      window.localStorage.setItem("lore.lang", "id");
      window.dispatchEvent(new Event("storage"));
    });
    expect(shown()).toBe("id");
  });

  it("re-reads on languagechange", () => {
    const spy = navLang("en-US");
    render(<Probe />);
    expect(shown()).toBe("en");
    act(() => {
      spy.mockReturnValue("id-ID");
      window.dispatchEvent(new Event("languagechange"));
    });
    expect(shown()).toBe("id");
  });

  it("falls back to the navigator when localStorage.getItem throws", () => {
    navLang("id-ID");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Probe />);
    expect(shown()).toBe("id");
  });
});
