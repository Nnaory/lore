/*
 * Button: the one button style of the Kit (primary, outline, disabled).
 * Renders <a> when `href` is given so link-buttons look identical. Every
 * variant keeps a 44px minimum touch target (AGENTS.md); primary is 52px on
 * phone and 48px on desktop. A disabled button uses smoke/muted fills and is
 * both natively disabled and aria-disabled.
 */

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "outline" | "disabled";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  variant?: ButtonVariant;
  /** When set, renders an anchor instead of a <button>. */
  href?: string;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

const BASE =
  "inline-flex items-center justify-center gap-2 font-mono text-[14px] font-bold min-h-[44px] px-5 select-none";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-ember text-ink min-h-[52px] md:min-h-[48px] cursor-pointer",
  outline: "border-2 border-cream bg-transparent text-cream cursor-pointer",
  disabled: "bg-smoke text-muted cursor-not-allowed",
};

export function Button({
  variant = "primary",
  href,
  children,
  className,
  disabled,
  type,
  "data-testid": testId,
  ...rest
}: ButtonProps) {
  const isDisabled = variant === "disabled" || Boolean(disabled);
  const effective: ButtonVariant = isDisabled ? "disabled" : variant;
  const classes = `${BASE} ${VARIANT_CLASS[effective]} ${className ?? ""}`;

  if (href !== undefined && !isDisabled) {
    // Internal paths use next/link for client-side navigation; the rendered
    // <a> is identical. External, protocol-relative and hash links stay plain.
    if (href.startsWith("/") && !href.startsWith("//")) {
      return (
        <Link href={href} className={classes} data-testid={testId} data-variant={effective}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} className={classes} data-testid={testId} data-variant={effective}>
        {children}
      </a>
    );
  }

  return (
    <button
      {...rest}
      type={type ?? "button"}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      className={classes}
      data-testid={testId}
      data-variant={effective}
    >
      {children}
    </button>
  );
}
