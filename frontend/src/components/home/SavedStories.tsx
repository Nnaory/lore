/**
 * SavedStories
 *
 * Lists campaigns saved in this browser (IndexedDB) with progress, a
 * link to continue, and a two-step delete. Renders nothing until mounted
 * (storage is browser-only) and nothing when there are no saved stories.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { deleteProject, listProjects, type ProjectSummary } from "@/lib/state/project-store";

const GENRE_LABEL: Record<string, string> = {
  fantasy: "Fantasy",
  modern: "Non-fiction",
  science_fiction: "Sci-fi",
};

export function SavedStories() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

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
      className="lore-glass lore-glass-panel rounded-panel w-full flex flex-col gap-3 p-4 text-left"
      aria-labelledby="saved-stories-heading"
      data-testid="saved-stories"
    >
      <h2 id="saved-stories-heading" className="lore-eyebrow">
        Your stories
      </h2>
      <ul className="flex flex-col gap-2">
        {projects.map((p) => {
          const done = p.stories_completed >= p.stories_total;
          return (
            <li key={p.id} data-testid={`saved-story-${p.id}`} className="lore-tile rounded-tip p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: "var(--foreground)" }}>
                  {p.title}
                </p>
                <p className="text-xs truncate" style={{ color: "var(--foreground-faint)" }}>
                  {GENRE_LABEL[p.genre] ?? p.genre} · {p.source_name} ·{" "}
                  {done ? "Completed" : `${p.stories_completed}/${p.stories_total} stories`}
                </p>
              </div>
              {confirming === p.id ? (
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    type="button"
                    data-testid={`confirm-delete-${p.id}`}
                    onClick={() => remove(p.id)}
                    className="lore-pill lore-pill-sm lore-pill-danger"
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirming(null)} className="lore-pill lore-pill-sm">
                    Keep
                  </button>
                </div>
              ) : (
                <div className="flex gap-2 flex-shrink-0">
                  <Link href={`/play/${p.id}`} data-testid={`continue-${p.id}`} className="lore-pill lore-pill-sm lore-pill-primary">
                    {done ? "Replay" : "Continue"}
                  </Link>
                  <button
                    type="button"
                    data-testid={`delete-${p.id}`}
                    onClick={() => setConfirming(p.id)}
                    aria-label={`Delete ${p.title}`}
                    className="lore-pill lore-pill-sm"
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
