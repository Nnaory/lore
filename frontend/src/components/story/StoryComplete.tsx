/**
 * StoryComplete — story / campaign completion screen on the Stage
 *
 * Why: shown when a story reaches its good ending. It is a full-height report
 * column (badge, title, the cast, HP / accuracy / concepts / time, one row per
 * concept, then the actions) rather than a small card, so the player sees how
 * the run went before moving on. Phone stacks the stats in one row under the
 * cast; desktop puts the concept list on the left and the stats on the right.
 * Every figure comes from `CompletionReport` (judged answers only) and the HP
 * the game engine tracks; this component computes no game rules. The report
 * props are optional: without them the screen still shows the title and the
 * actions. The ending narration is handed in as `endingSlot` and revealed with
 * "Replay ending". Built from Kit tokens only: no glass, radius or shadow.
 */

"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AsciiArt } from "@/components/ascii/AsciiArt";
import { useBoardPixelRatio } from "@/components/stage/ScaledBoard";
import { Button } from "@/components/ui/Button";
import { CELL_ASPECT, FIGURE_COLS, renderCharacter, type CastId } from "@/lib/ascii";
import { formatElapsed, type CompletionConcept, type CompletionReport } from "@/lib/story/completion-report";
import type { StageLayout } from "@/lib/stage/board-scale";

export type CompletionCastMember = { castId: CastId; name: string };

type StoryCompleteProps = {
  storyTitle: string;
  /** Called when the player wants to record completion and advance the campaign. */
  onContinue: () => void;
  /** Called when the player wants to exit without recording completion. */
  onExit: () => void;
  /** True when this was the final story in the campaign. */
  isCampaignComplete: boolean;
  /** Opens the epilogue and learning evaluation (shown once the campaign is complete). */
  onViewResults?: () => void;
  /** Gold line under the title, e.g. "3 chapters". */
  subtitle?: string;
  /** Characters of the story, drawn as a row of ASCII figures. */
  cast?: CompletionCastMember[];
  report?: CompletionReport;
  hp?: number;
  maxHp?: number;
  /** `Date.now()` when this run started; the elapsed time is read once when the screen appears. */
  startedAt?: number;
  /** Replays the story from the start (HP resets, knowledge stays). */
  onReplay?: () => void;
  /** Opens the chat log of this run. */
  onOpenLog?: () => void;
  /** The ending narration; hidden until "Replay ending" is pressed. */
  endingSlot?: ReactNode;
  layout?: StageLayout;
};

const NAME_CLASS: Record<CastId, string> = {
  eldric: "text-cloth-eldric",
  mira: "text-cloth-mira",
  hazel: "text-cloth-hazel",
  varr: "text-cloth-varr",
  nyx: "text-cloth-nyx",
};

const RESULT_LABEL: Record<CompletionConcept["result"], string> = {
  direct: "first try",
  retried: "retried",
  repeat: "replay",
  taught: "taught",
};

/** Inner width of the report column in design px (column minus padding). */
const CAST_WIDTH: Record<StageLayout, number> = { desktop: 624, phone: 334 };
/** Largest cell size per layout, so a story with only two characters does not push the report off the board. */
const CAST_MAX_FONT_PX: Record<StageLayout, number> = { desktop: 5, phone: 3.4 };

function CastFigure({ member, fontPx }: { member: CompletionCastMember; fontPx: number }) {
  const layers = useMemo(() => renderCharacter(member.castId, "calm"), [member.castId]);
  const pixelRatio = useBoardPixelRatio();
  return (
    <figure data-testid={`complete-cast-${member.castId}`} className="m-0 flex flex-col items-center gap-1.5">
      <AsciiArt layers={layers} fontPx={fontPx} pixelRatio={pixelRatio} label={member.name} />
      <figcaption className={`font-mono text-[11px] font-bold uppercase tracking-[0.12em] ${NAME_CLASS[member.castId]}`}>
        {member.name}
      </figcaption>
    </figure>
  );
}

function Stat({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted">{label}</span>
      {children}
    </div>
  );
}

function ConceptMarker({ result }: { result: CompletionConcept["result"] }) {
  const cls =
    result === "direct"
      ? "bg-ember"
      : result === "retried"
        ? "bg-gold"
        : result === "repeat"
          ? "border-2 border-cream"
          : "border border-muted";
  return <span aria-hidden="true" className={`inline-block size-[11px] shrink-0 ${cls}`} />;
}

export function StoryComplete({
  storyTitle,
  onContinue,
  onExit,
  isCampaignComplete,
  onViewResults,
  subtitle,
  cast,
  report,
  hp,
  maxHp,
  startedAt,
  onReplay,
  onOpenLog,
  endingSlot,
  layout = "desktop",
}: StoryCompleteProps) {
  const phone = layout === "phone";
  const [endingOpen, setEndingOpen] = useState(false);
  // Read once when the screen appears, so the time does not keep growing while it is open.
  const [shownAt] = useState(() => Date.now());

  const members = cast ?? [];
  const castFontPx =
    members.length > 0
      ? Math.min(CAST_MAX_FONT_PX[layout], CAST_WIDTH[layout] / members.length / (FIGURE_COLS * CELL_ASPECT))
      : 0;

  const hasHp = hp !== undefined && maxHp !== undefined;
  const stats = (
    <div className={phone ? "grid grid-cols-4 gap-2" : "grid grid-cols-2 gap-x-6 gap-y-6"} data-testid="complete-stats">
      {hasHp && (
        <Stat label="HP" testId="complete-stat-hp">
          {phone ? (
            <span className="font-mono text-[18px] font-bold text-ember">
              {hp}/{maxHp}
            </span>
          ) : (
            <span className="flex gap-1" role="img" aria-label={`HP ${hp} of ${maxHp}`}>
              {Array.from({ length: maxHp }, (_, i) => (
                <span key={i} className={`size-3 ${i < hp ? "bg-ember" : "border border-smoke"}`} />
              ))}
            </span>
          )}
        </Stat>
      )}
      {report && (
        <>
          <Stat label="Accuracy" testId="complete-stat-accuracy">
            <span className="font-mono text-[18px] font-bold text-cream">
              {report.answersTotal > 0 ? `${report.answersCorrect}/${report.answersTotal}` : "–"}
            </span>
          </Stat>
          <Stat label="Concepts" testId="complete-stat-concepts">
            <span className="font-mono text-[18px] font-bold text-cream">
              {report.understood}/{report.concepts.length}
            </span>
          </Stat>
        </>
      )}
      {startedAt !== undefined && (
        <Stat label="Time" testId="complete-stat-time">
          <span className="font-mono text-[18px] font-bold text-cream">{formatElapsed(shownAt - startedAt)}</span>
        </Stat>
      )}
    </div>
  );

  const conceptList = report && report.concepts.length > 0 && (
    <section aria-label="Concepts" className="flex min-w-0 flex-1 flex-col gap-3">
      {!phone && (
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted">Concepts</h3>
      )}
      <ul data-testid="complete-concepts" className="m-0 flex list-none flex-col gap-3 p-0">
        {report.concepts.map((c) => (
          <li
            key={c.concept_id}
            data-testid={`complete-concept-${c.concept_id}`}
            data-result={c.result}
            className="flex items-center gap-3"
          >
            <ConceptMarker result={c.result} />
            <span className="min-w-0 flex-1 truncate font-mono text-[14px] text-cream">{c.name}</span>
            <span
              className={`shrink-0 font-mono text-[12px] ${c.result === "repeat" ? "font-bold text-ember" : "text-muted"}`}
            >
              {RESULT_LABEL[c.result]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );

  const primary = isCampaignComplete ? (
    onViewResults && (
      <Button
        variant="primary"
        data-testid="view-results-button"
        onClick={onViewResults}
        className={phone ? "w-full" : "flex-1"}
      >
        See your results →
      </Button>
    )
  ) : (
    <Button
      variant="primary"
      data-testid="continue-campaign-button"
      onClick={onContinue}
      className={phone ? "w-full" : "flex-1"}
    >
      Continue Campaign →
    </Button>
  );

  return (
    <div
      data-testid="story-complete-screen"
      className={`flex h-full w-full flex-col overflow-y-auto border-smoke bg-ink text-center ${
        phone ? "border px-4 py-6" : "border-x px-12 py-10"
      }`}
      role="region"
      aria-label={`${isCampaignComplete ? "Campaign complete" : "Story complete"}: ${storyTitle}`}
    >
      <header className="flex flex-col items-center gap-3">
        <span
          data-testid="story-complete-badge"
          className="bg-ember px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-ink"
        >
          {isCampaignComplete ? "Campaign Complete" : "Story Complete"}
        </span>
        <h2
          className={`font-display font-bold leading-[1.1] text-cream ${phone ? "text-[26px]" : "text-[40px]"}`}
          data-testid="story-complete-title"
        >
          {storyTitle}
        </h2>
        {subtitle && <p className="m-0 font-mono text-[12px] text-gold">{subtitle}</p>}
      </header>

      {members.length > 0 && (
        <div data-testid="complete-cast" className="mt-6 flex items-end justify-around">
          {members.map((m) => (
            <CastFigure key={m.castId} member={m} fontPx={castFontPx} />
          ))}
        </div>
      )}

      <div aria-hidden="true" className="my-5 h-px w-full shrink-0 bg-smoke" />

      {phone ? (
        <>
          {(hasHp || report || startedAt !== undefined) && stats}
          {conceptList && <div aria-hidden="true" className="my-5 h-px w-full shrink-0 bg-smoke" />}
          {conceptList && <div className="text-left">{conceptList}</div>}
        </>
      ) : (
        (conceptList || hasHp || report || startedAt !== undefined) && (
          <div className="flex items-start justify-between gap-10 text-left">
            {conceptList}
            <div className="w-[220px] shrink-0">{stats}</div>
          </div>
        )
      )}

      {endingSlot && (
        <div data-testid="complete-ending" className={`mt-6 ${endingOpen ? "block" : "hidden"}`}>
          {endingSlot}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-4 pt-8">
        {isCampaignComplete ? (
          <p
            data-testid="campaign-complete-message"
            className="m-0 text-[14px] leading-[1.5] text-muted"
          >
            You have completed the full campaign.
          </p>
        ) : (
          <p className="m-0 text-[14px] leading-[1.5] text-muted">
            The story has ended. Your progress has been recorded.
          </p>
        )}

        <div className={phone ? "flex flex-col gap-3" : "flex items-stretch gap-3"}>
          {primary}
          <div className={phone ? "grid grid-cols-2 gap-3" : "flex gap-3"}>
            <Button variant="outline" data-testid="exit-button" onClick={onExit} className="w-full">
              {isCampaignComplete ? "Return to Lobby" : "Exit Story"}
            </Button>
            {onReplay && (
              <button
                type="button"
                data-testid="replay-story-button"
                onClick={onReplay}
                className="inline-flex min-h-[44px] max-w-[260px] shrink-0 cursor-pointer items-center justify-center gap-2 border-2 border-smoke px-4 font-mono text-[13px] font-bold text-muted"
              >
                <span className="truncate">
                  {report?.weakest ? `↺ Replay: ${report.weakest.name}` : "↺ Replay story"}
                </span>
              </button>
            )}
          </div>
        </div>

        {(endingSlot || onOpenLog) && (
          <div className="flex items-center justify-between font-mono text-[12px] text-muted">
            {endingSlot ? (
              <button
                type="button"
                data-testid="replay-ending-button"
                aria-expanded={endingOpen}
                onClick={() => setEndingOpen((open) => !open)}
                className="inline-flex min-h-[44px] cursor-pointer items-center"
              >
                {endingOpen ? "↺ Hide ending" : "↺ Replay ending"}
              </button>
            ) : (
              <span />
            )}
            {onOpenLog && (
              <button
                type="button"
                data-testid="complete-log-button"
                onClick={onOpenLog}
                className="inline-flex min-h-[44px] cursor-pointer items-center"
              >
                View chat log
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
