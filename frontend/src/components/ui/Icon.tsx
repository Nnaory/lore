/*
 * Icon: inline SVG icon set for the Black Cat Gold Kit.
 * Replaces every lucide-react import (Requirement 3.4). All glyphs share one
 * 24x24 viewBox, stroke="currentColor", strokeWidth 2 and square caps so they
 * inherit colour from the surrounding token class and match the Kit's hard edges.
 */

export type IconName =
  | "back"
  | "exit"
  | "file-up"
  | "paperclip"
  | "arrow-up"
  | "file"
  | "close"
  | "check"
  | "play"
  | "alert";

/** Path data per icon (24x24 grid). Kept as data so the set is easy to audit. */
const PATHS: Record<IconName, readonly string[]> = {
  back: ["M19 12H5", "M12 5l-7 7 7 7"],
  exit: ["M9 21H4V3h5", "M16 7l5 5-5 5", "M21 12H9"],
  "file-up": ["M14 2H6v20h12V8z", "M14 2v6h6", "M12 18v-6", "M9 15l3-3 3 3"],
  paperclip: ["M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"],
  "arrow-up": ["M12 20V4", "M5 11l7-7 7 7"],
  file: ["M14 2H6v20h12V8z", "M14 2v6h6"],
  close: ["M5 5l14 14", "M19 5L5 19"],
  check: ["M4 12l5 5L20 6"],
  play: ["M6 4l14 8-14 8z"],
  alert: ["M12 3L2 21h20z", "M12 10v5", "M12 18v.01"],
};

export interface IconProps {
  name: IconName;
  /** Rendered size in px (square). Default 24. */
  size?: number;
  className?: string;
  /** Accessible label. Without it the icon is decorative and hidden from AT. */
  label?: string;
  "data-testid"?: string;
}

export function Icon({ name, size = 24, className, label, "data-testid": testId }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className}
      data-testid={testId}
      data-icon={name}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
