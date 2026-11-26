/**
 * PlayProject — client side of /play/[projectId] (Pola K ringkas, design 6.11)
 *
 * Why: loads the project (from IndexedDB, or from the API in http mode; in the
 * browser only, after mount, so server and client render the same loading
 * state) and saves campaign progress back whenever it changes. A local save
 * failure comes back from saveCampaignState; in http mode a later server
 * save failure arrives through setupSaveErrorHandler. Both feed the same 44px
 * ember/ink alert banner. A returning player starts at the campaign lobby; a
 * new campaign starts straight in its first story.
 */

"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CampaignPlayer } from "@/components/campaign/CampaignPlayer";
import { Button } from "@/components/ui/Button";
import {
  loadProject,
  projectStories,
  saveCampaignState,
  setupSaveErrorHandler,
  type Project,
} from "@/lib/state/project-store";
import type { StoryBlueprint } from "@/lib/types/story";

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; project: Project; stories: ReadonlyMap<string, StoryBlueprint> };

export function PlayLoading() {
  return (
    <div
      className="lore-grid-lines flex min-h-dvh items-center justify-center px-5"
      data-testid="play-loading"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 bg-ember" />
        <p className="font-mono text-[14px] text-cream">Opening your story…</p>
      </div>
    </div>
  );
}

export function PlayProject() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Server save problems arrive later than the local save (http mode only).
    return setupSaveErrorHandler(setSaveError);
  }, []);

  useEffect(() => {
    // Browser storage is only readable after mount.
    let active = true;
    loadProject(projectId).then((project) => {
      if (!active) return;
      setLoaded(
        project
          ? { status: "ready", project, stories: projectStories(project) }
          : { status: "missing" }
      );
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  if (loaded.status === "loading") return <PlayLoading />;

  if (loaded.status === "missing") {
    return (
      <div className="lore-grid-lines min-h-dvh" data-testid="play-missing">
        <main className="mx-auto flex min-h-dvh w-full max-w-[680px] flex-col px-5 pb-12 md:px-0">
          <div className="flex min-h-[56px] items-center justify-between md:min-h-[44px]">
            <span aria-hidden="true" />
            <span className="bg-ink px-2 py-0.5 font-mono text-[13px] font-bold tracking-[0.4em] text-gold">LORE</span>
          </div>
          <div className="my-auto flex flex-col items-start gap-3 border border-smoke bg-ink p-6 md:p-8">
            <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-ember md:text-[12px]">
              Not found
            </p>
            <h2 className="font-display text-[17px] font-bold leading-snug text-cream">
              This story isn&apos;t saved in this browser.
            </h2>
            <p className="max-w-[560px] text-[14px] leading-[1.5] text-muted md:text-[15px]">
              Stories are stored on the device where they were created. It may have been deleted, or
              created in another browser.
            </p>
            <Button variant="primary" href="/" className="mt-2 w-full md:w-auto">
              Back to your stories
            </Button>
          </div>
        </main>
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
          className="fixed inset-x-0 top-0 z-[60] flex min-h-[44px] items-center justify-center bg-ember px-4 py-2 text-center font-mono text-[12px] font-bold text-ink"
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
          void saveCampaignState(project.id, state).then((result) =>
            setSaveError(result.ok ? null : result.message)
          );
        }}
      />
    </>
  );
}
