/**
 * StepMarker: the 12px status square of the generation screen.
 *
 * Why it is its own file: `GenerationScreen` draws one per pipeline step, and `AnimationProgress`
 * (components/animation) draws one per animation job in the same style. Two copies would drift;
 * `AnimationProgress` cannot import from `GenerationScreen` (that file imports it).
 *
 * Done is gold, active ember, failed an ember outline with "!", pending smoke, skipped a muted
 * outline with "-". Token classes only: no radius, shadow or emoji. Decorative (`aria-hidden`):
 * the row that holds it carries the status as text and as `data-status`.
 */

export type StepMarkerStatus = "done" | "active" | "failed" | "pending" | "skipped";

export function StepMarker({ status }: { status: StepMarkerStatus }) {
  if (status === "failed") {
    return (
      <span
        aria-hidden="true"
        className="flex h-3 w-3 shrink-0 items-center justify-center border border-ember font-mono text-[9px] font-bold leading-none text-ember"
      >
        !
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span
        aria-hidden="true"
        className="flex h-3 w-3 shrink-0 items-center justify-center border border-muted font-mono text-[9px] font-bold leading-none text-muted"
      >
        -
      </span>
    );
  }
  const fill = status === "done" ? "bg-gold" : status === "active" ? "bg-ember" : "bg-smoke";
  return <span aria-hidden="true" className={`h-3 w-3 shrink-0 ${fill}`} />;
}
