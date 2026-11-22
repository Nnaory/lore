/**
 * SavedStories
 *
 * Lists campaigns saved in this browser (IndexedDB) with progress, a
 * link to continue, and a two-step delete. Flat Kit layout (no card): rows
 * split by 1px smoke lines on a transparent surface so the backdrop shows. Renders nothing until mounted
 * (storage is browser-only) and nothing when there are no saved stories.
 * Labels come from lib/i18n/ui.ts (`stories.*`) in the `useUiLang()` language.
 */

"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { t, type UiKey } from "@/lib/i18n/ui";
import { useUiLang } from "@/lib/i18n/use-ui-lang";
import { deleteProject, listProjects, type ProjectSummary } from "@/lib/state/project-store";

const GENRE_KEY: Record<string, UiKey> = {
  fantasy: "stories.genre.fantasy",
  modern: "stories.genre.modern",
  science_fiction: "stories.genre.science_fiction",
};

export function SavedStories() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const lang = useUiLang();

  useEffect(() => {
    // Browser storage is only readable after mount.
    let active = true;
    listProjects().then((list) => {
      if (active) setProjects(list);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!projects || projects.length === 0) return null;

  async function remove(id: string) {
    setConfirming(null);
    await deleteProject(id);
    setProjects(await listProjects());
  }

  return (
    <section
      className="flex w-full flex-col gap-3 text-left"
      aria-label={t(lang, "stories.label")}
      data-testid="saved-stories"
    >
      <SectionLabel number="01" title={t(lang, "stories.title")} />
      <ul className="flex flex-col">
        {projects.map((p) => {
          const done = p.stories_completed >= p.stories_total;
          return (
            <li
              key={p.id}
              data-testid={`saved-story-${p.id}`}
              className="flex flex-col gap-3 border-b border-smoke py-4 md:flex-row md:items-center md:gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-bold text-cream">{p.title}</p>
                <p className="truncate font-mono text-[12px] text-muted">
                  {GENRE_KEY[p.genre] ? t(lang, GENRE_KEY[p.genre]) : p.genre} · {p.source_name} ·{" "}
                  {done
                    ? t(lang, "stories.completed")
                    : t(lang, "stories.progress", { done: p.stories_completed, total: p.stories_total })}
                </p>
              </div>
              {confirming === p.id ? (
                <div className="flex shrink-0 gap-2 [&>*]:flex-1 md:[&>*]:flex-none">
                  <Button variant="primary" data-testid={`confirm-delete-${p.id}`} onClick={() => remove(p.id)}>
                    {t(lang, "stories.delete")}
                  </Button>
                  <Button variant="outline" onClick={() => setConfirming(null)}>
                    {t(lang, "stories.keep")}
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 gap-2 [&>*]:flex-1 md:[&>*]:flex-none">
                  <Button variant="primary" href={`/play/${p.id}`} data-testid={`continue-${p.id}`}>
                    {t(lang, done ? "stories.replay" : "stories.continue")}
                  </Button>
                  <Button
                    variant="outline"
                    data-testid={`delete-${p.id}`}
                    onClick={() => setConfirming(p.id)}
                    aria-label={t(lang, "stories.deleteNamed", { title: p.title })}
                  >
                    {t(lang, "stories.delete")}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}