/**
 * PlayProject — client side of /play/[projectId]
 *
 * Loads the project from IndexedDB (in the browser only, after mount, so
 * server and client render the same loading state) and saves campaign
 * progress back whenever it changes. A returning player starts at the
 * campaign lobby; a new campaign starts straight in its first story.
 */

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CampaignPlayer } from "@/components/campaign/CampaignPlayer";
import { loadProject, projectStories, saveCampaignState, type Project } from "@/lib/state/project-store";
import type { StoryBlueprint } from "@/lib/types/story";

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; project: Project; stories: ReadonlyMap<string, StoryBlueprint> };

export function PlayLoading() {
  return (
    <div className="lore-bg min-h-screen flex items-center justify-center" data-testid="play-loading">
      <p className="text-sm animate-pulse-gold" style={{ color: "var(--accent-gold-dim)" }}>
        Opening your story…
      </p>
    </div>
  );
}

export function PlayProject() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Browser storage is only readable after mount.
    let active = true;
    loadProject(projectId).then((project) => {
      if (!active) return;
      setLoaded(project ? { status: "ready", project, stories: projectStories(project) } : { status: "missing" });
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  if (loaded.status === "loading") return <PlayLoading />;

  if (loaded.status === "missing") {
    return (
      <div className="lore-bg min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center" data-testid="play-missing">
        <p className="text-sm" style={{ color: "var(--foreground)" }}>
          This story isn&apos;t saved in this browser.
        </p>
        <p className="text-xs max-w-sm" style={{ color: "var(--foreground-faint)" }}>
          Stories are stored on the device where they were created. It may have been deleted, or created in
          another browser.
        </p>
        <Link href="/" className="text-xs underline underline-offset-2" style={{ color: "var(--accent-gold)" }}>
          Back to your stories
        </Link>
      </div>
    );
  }

  const { project, stories } = loaded;
  return (
    <>
      {saveError && (
        <div
          role="alert"
          data-testid="play-save-error"
          className="fixed top-0 inset-x-0 z-[60] px-4 py-2 text-xs text-center"
          style={{ backgroundColor: "var(--danger-bg)", color: "var(--danger)" }}
        >
          {saveError}
        </div>
      )}
      <CampaignPlayer
        campaign={project.campaign}
        stories={stories}
        initialState={project.campaign_state}
        startAtLobby={project.campaign_state !== undefined}
        homeHref="/"
        materials={project.materials}
        onStateChange={(state) => {
          // Saves run in order (one IndexedDB transaction each).
          void saveCampaignState(project.id, state).then((result) => setSaveError(result.ok ? null : result.message));
        }}
      />
    </>
  );
}
