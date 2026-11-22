/**
 * Home i18n (Kit v2 task 01)
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeHero } from "@/components/home/HomeHero";
import { SavedStories } from "@/components/home/SavedStories";
import { createProject } from "@/lib/state/project-store";
import { MAX_FILE_BYTES } from "@/lib/ingest/limits";
import { takePendingMaterial } from "@/lib/setup/pending-material";
import { dummyCampaign } from "@/data/dummy-campaign";
import { UI, t, type UiLang } from "@/lib/i18n/ui";
import { linearStory } from "../fixtures/linear-story";
import { freshStore } from "../fixtures/fresh-store";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

function stubViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width") ? width >= 768 : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(async () => {
  await freshStore();
  takePendingMaterial();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-US");
  stubViewport(1440, 900);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const txt = (name = "notes.txt") => new File(["## Vectors"], name, { type: "text/plain" });
const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
const unquote = (s: string) => s.replace(/[“”]/g, "");

describe.each(["id", "en"] as UiLang[])("HomeHero in %s", (lang) => {
  const D = UI[lang];

  beforeEach(() => window.localStorage.setItem("lore.lang", lang));

  it("shows the idle copy from the dictionary", () => {
    render(<HomeHero />);
    expect(screen.getByTestId("home-hazel-line").textContent).toContain(unquote(D["home.greeting"]));
    expect(screen.getByTestId("home-hazel").getAttribute("aria-label")).toBe(D["home.hazelAlt.smile"]);
    expect(screen.getByTestId("home-input").getAttribute("placeholder")).toBe(D["home.placeholder"]);
    expect(screen.getByLabelText(D["home.inputLabel"])).toBe(screen.getByTestId("home-input"));
    expect(screen.getByLabelText(D["home.fileInputLabel"])).toBe(screen.getByTestId("home-file-input"));
    expect(screen.getByTestId("home-send").textContent).toContain(D["home.brew"]);
    expect(screen.getByTestId("home-attach").textContent).toContain(D["home.addFile"]);
    expect(screen.getByTestId("home-demo-link").textContent).toContain(D["common.playDemoLong"]);
    expect(screen.getByText(t(lang, "home.formats", { mb }))).toBeTruthy();
    expect(screen.getByText(D["common.tagline"])).toBeTruthy();
  });

  it("shows the file-required error in the language", async () => {
    const user = userEvent.setup();
    render(<HomeHero />);
    await user.type(screen.getByTestId("home-input"), "hello{Enter}");
    expect(screen.getByTestId("home-file-required").textContent).toContain(D["home.fileRequired"]);
  });

  it.each([
    ["empty_file", new File([], "empty.txt", { type: "text/plain" })],
    ["too_large", Object.defineProperty(txt("big.txt"), "size", { value: MAX_FILE_BYTES + 1 })],
    ["unsupported_format", new File(["x"], "pic.exe", { type: "application/octet-stream" })],
  ] as const)("shows the %s rejection in the language", async (reason, bad) => {
    const user = userEvent.setup({ applyAccept: false });
    render(<HomeHero />);
    await user.upload(screen.getByTestId("home-file-input"), bad as File);
    expect(screen.getByTestId("home-file-error").textContent).toContain(D[`home.file.${reason}`]);
  });

  it("attaching a file shows gotFile with the name, surprised alt, named remove label", async () => {
    const user = userEvent.setup();
    render(<HomeHero />);
    await user.upload(screen.getByTestId("home-file-input"), txt("week3.txt"));
    expect(screen.getByTestId("home-hazel-line").textContent).toContain(
      unquote(t(lang, "home.gotFile", { file: "week3.txt" })),
    );
    expect(screen.getByTestId("home-hazel").getAttribute("aria-label")).toBe(D["home.hazelAlt.surprised"]);
    expect(screen.getByTestId("home-attach").textContent).toContain(D["home.replace"]);
    expect(screen.getByTestId("home-file-remove").getAttribute("aria-label")).toBe(
      t(lang, "home.removeFileNamed", { file: "week3.txt" }),
    );
  });

  it("phone uses the short lines", async () => {
    stubViewport(390, 844);
    const user = userEvent.setup();
    render(<HomeHero />);
    expect(screen.getByTestId("home-hazel-line").textContent).toContain(unquote(D["home.greetingShort"]));
    expect(screen.getByTestId("home-input").getAttribute("placeholder")).toBe(D["home.placeholderShort"]);
    expect(screen.getByText(t(lang, "home.formatsShort", { mb }))).toBeTruthy();
    await user.upload(screen.getByTestId("home-file-input"), txt("week3.txt"));
    expect(screen.getByTestId("home-hazel-line").textContent).toContain(unquote(D["home.gotFileShort"]));
  });
});

describe("SavedStories in id", () => {
  beforeEach(() => window.localStorage.setItem("lore.lang", "id"));
  const D = UI.id;

  async function save() {
    const r = await createProject({
      source: { file_name: "catatan.pdf", file_type: "pdf" },
      campaign: dummyCampaign,
      stories: new Map([[linearStory.story_id, linearStory]]),
    });
    if (!r.ok) throw new Error(r.message);
    return r.value;
  }

  it("renders title, progress, genre and action labels in Indonesian, delete confirm too", async () => {
    const user = userEvent.setup();
    const p = await save();
    render(<SavedStories />);
    const section = await screen.findByTestId("saved-stories");
    expect(section.getAttribute("aria-label")).toBe(D["stories.label"]);
    expect(within(section).getByText(D["stories.title"], { exact: false })).toBeTruthy();

    const row = screen.getByTestId(`saved-story-${p.id}`);
    expect(row.textContent).toContain(D["stories.genre.fantasy"]);
    expect(row.textContent).toContain(t("id", "stories.progress", { done: 0, total: 2 }));
    expect(screen.getByTestId(`continue-${p.id}`).textContent).toBe(D["stories.continue"]);
    const del = screen.getByTestId(`delete-${p.id}`);
    expect(del.textContent).toBe(D["stories.delete"]);
    expect(del.getAttribute("aria-label")).toBe(t("id", "stories.deleteNamed", { title: "The Last Beacon" }));

    await user.click(del);
    expect(screen.getByTestId(`confirm-delete-${p.id}`).textContent).toBe(D["stories.delete"]);
    expect(screen.getByRole("button", { name: D["stories.keep"] })).toBeTruthy();
  });
});
