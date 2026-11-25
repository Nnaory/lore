/**
 * StoryFailure — story failure panel on the Stage (Pola P, design 6.9)
 *
 * Why: displayed when HP reaches 0 and the story enters the failed state.
 * Uses Kit StatusBadge (`locked` with `text-cream`), Button (`primary`), and
 * token classes only — no danger colour, no glass, no rounded corners.
 * Desktop panel is max-w-[560px]; phone is max-w-[366px].
 */

import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";

type StoryFailureProps = {
  storyTitle: string;
  /** Retry callback — provided by useStoryPlayer. Resets StoryState only. */
  onRetry: () => void;
};

export function StoryFailure({ storyTitle, onRetry }: StoryFailureProps) {
  return (
    <div
      data-testid="story-failure"
      className="mx-auto flex w-full max-w-[366px] flex-col items-center gap-4 border-2 border-smoke bg-ink p-5 text-center md:max-w-[560px] md:p-6"
      role="alert"
      aria-live="assertive"
    >
      <StatusBadge variant="locked" className="text-cream">
        Story Failed
      </StatusBadge>

      <h2
        className="font-display text-[17px] font-bold leading-snug text-cream"
        data-testid="story-failure-title"
      >
        {storyTitle}
      </h2>

      <div className="flex flex-col gap-1 text-[14px] leading-[1.5] text-muted md:text-[15px]">
        <p>You have run out of HP.</p>
        <p className="font-mono text-[13px] font-bold text-cream" data-testid="story-failure-hp">
          HP: 0 / 5
        </p>
      </div>

      <div aria-hidden="true" className="h-px w-full bg-smoke" />

      <p className="font-mono text-[12px] leading-[1.5] text-muted">
        You can retry from the beginning. Your HP will be restored to 5. Progress from earlier
        stories is preserved.
      </p>

      <Button variant="primary" data-testid="retry-button" onClick={onRetry} className="w-full">
        Retry Story
      </Button>
    </div>
  );
}
