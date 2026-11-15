/**
 * SavedStories
 *
 * Lists campaigns saved in this browser (localStorage) with progress, a
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
    // localStorage is only readable after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjects(listProjects());
  }, []);

  if (!projects || projects.length === 0) return null;

  function remove(id: string) {
    deleteProject(id);
    setProjects(listProjects());
    setConfirming(null);
  }

  return (
    <section className="w-full flex flex-col gap-3 text-left" aria-labelledby="saved-stories-heading" data-testid="saved-stories">
      <h2 id="saved-stories-heading" className="text-xs tracking-widest uppercase" style={{ color: "var(--foreground-faint)" }}>
        Your stories
      </h2>
      <ul className="flex flex-col gap-2">
        {projects.map((p) => {
          const done = p.stories_completed >= p.stories_total;
          return (
            <li
              key={p.id}
              data-testid={`saved-story-${p.id}`}
              className="rounded-lg p-3 flex items-center gap-3"
              style={{ backgroundColor: "var(--background-panel)", border: "1px solid var(--border-dim)" }}
            >
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
                    className="px-2.5 py-1.5 rounded text-xs"
                    style={{ color: "var(--danger)", border: "1px solid var(--danger)", backgroundColor: "var(--danger-bg)" }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="px-2.5 py-1.5 rounded text-xs"
                    style={{ color: "var(--foreground-muted)", border: "1px solid var(--border-dim)" }}
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <div className="flex gap-2 flex-shrink-0">
                  <Link
                    href={`/play/${p.id}`}
                    data-testid={`continue-${p.id}`}
                    className="px-3 py-1.5 rounded text-xs font-medium"
                    style={{ backgroundColor: "var(--accent-gold)", color: "var(--background)" }}
                  >
                    {done ? "Replay" : "Continue"}
                  </Link>
                  <button
                    type="button"
                    data-testid={`delete-${p.id}`}
                    onClick={() => setConfirming(p.id)}
                    aria-label={`Delete ${p.title}`}
                    className="px-2.5 py-1.5 rounded text-xs"
                    style={{ color: "var(--foreground-faint)", border: "1px solid var(--border-dim)" }}
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
