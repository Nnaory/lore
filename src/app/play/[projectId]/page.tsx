/**
 * /play/[projectId] — play a campaign saved in this browser
 *
 * Projects live in localStorage, so everything happens client-side in
 * PlayProject. The Suspense boundary is required because it reads the route
 * params with a dynamic hook (Next.js cacheComponents).
 */

import { Suspense } from "react";
import { PlayLoading, PlayProject } from "@/components/play/PlayProject";

export default function PlayPage() {
  return (
    <Suspense fallback={<PlayLoading />}>
      <PlayProject />
    </Suspense>
  );
}
