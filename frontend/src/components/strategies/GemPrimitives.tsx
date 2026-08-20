"use client";

import Link from "next/link";
import { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import type { TourAnchorId } from "@/lib/tours/anchors";
import { chartColors } from "@/lib/chart-colors";
import { cn } from "@/lib/utils";
import { isKnown } from "@/lib/gem-strategy-view";
import { CARD_CLASS } from "@/components/ui/Card";

/**
 * Small building blocks shared by the GEM report cards. They compose the
 * existing Monize card/typography conventions -- no new component library --
 * and centralize two rules the report leans on everywhere: an unknown value
 * renders as an explicit marker (never a zero), and any figure carrying a
 * positive/negative meaning also carries a sign, so colour is never the only
 * cue.
 */

const CARD_BASE = CARD_CLASS;

interface GemCardProps {
  /** Card heading. Rendered as the section label in small caps. */
  title?: string;
  /** Help text shown through the shared InfoTooltip next to the heading. */
  hint?: string;
  /** Right-aligned content on the heading row (badges, toggles). */
  headerRight?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  /** Renders the card as a <section> with an accessible name. */
  ariaLabel?: string;
  /**
   * Guided-tour anchor for the card itself, spread from
   * `tourAnchor(TOUR_ANCHORS.x)`. Forwarded onto the existing `<section>` so a
   * tour can point at a whole card without a wrapper element -- an extra div
   * around a card in a grid changes its sizing and height.
   */
  "data-tour-id"?: TourAnchorId;
}

export function GemCard({
  title,
  hint,
  headerRight,
  className,
  bodyClassName,
  children,
  ariaLabel,
  "data-tour-id": dataTourId,
}: GemCardProps) {
  return (
    <section
      aria-label={ariaLabel ?? title}
      className={cn(CARD_BASE, "flex flex-col", className)}
      data-tour-id={dataTourId}
    >
      {(title || headerRight) && (
        <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-2">
          {title && (
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center">
              {title}
              {hint && <InfoTooltip text={hint} usePortal />}
            </h2>
          )}
          {headerRight}
        </div>
      )}
      <div className={cn("px-4 pb-4 flex-1", !title && "pt-4", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

/**
 * Explicit "not known" marker. The report never shows 0 for a value the server
 * could not supply; screen readers get the spelled-out reason.
 */
export function GemUnknown({ label }: { label?: string }) {
  const t = useTranslations("strategies");
  return (
    <span className="text-gray-400 dark:text-gray-500">
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{label ?? t("gem.common.unknown")}</span>
    </span>
  );
}

/** Renders `children` when the value is known, otherwise the unknown marker. */
export function GemValue({
  value,
  children,
  unknownLabel,
}: {
  value: number | null | undefined;
  children: (value: number) => ReactNode;
  unknownLabel?: string;
}) {
  if (!isKnown(value)) return <GemUnknown label={unknownLabel} />;
  return <>{children(value)}</>;
}

/**
 * A signed percentage or percentage-point figure. The leading +/- is part of the
 * text (via `formatSignedPercent`), so the green/red tint only reinforces it.
 */
export function GemSigned({
  value,
  format,
  className,
  neutral = false,
}: {
  value: number | null | undefined;
  format: (value: number) => string;
  className?: string;
  neutral?: boolean;
}) {
  if (!isKnown(value)) return <GemUnknown />;
  const tone = neutral
    ? "text-gray-900 dark:text-gray-100"
    : value >= 0
      ? "text-green-600 dark:text-green-400"
      : "text-red-600 dark:text-red-400";
  return <span className={cn(tone, className)}>{format(value)}</span>;
}

/**
 * House style for a name that navigates: normal text colour, blue on hover.
 *
 * The report names accounts and instruments in a dozen places, and every one of
 * them is a way into that account or instrument -- the security detail page and
 * its "Held in accounts" card set the pattern, and a permanently blue anchor is
 * not it. Both wrappers degrade to plain text when there is no id to link to,
 * so a caller never has to branch.
 */
const GEM_LINK_CLASS =
  "rounded hover:text-blue-600 focus:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-blue-500 dark:hover:text-blue-400";

export function GemSecurityLink({
  securityId,
  children,
  className,
}: {
  securityId: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  if (!securityId) return <span className={className}>{children}</span>;
  return (
    <Link
      href={`/securities/${securityId}`}
      className={cn(GEM_LINK_CLASS, className)}
    >
      {children}
    </Link>
  );
}

export function GemAccountLink({
  accountId,
  children,
  className,
}: {
  accountId: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  if (!accountId) return <span className={className}>{children}</span>;
  return (
    <Link
      href={`/accounts/${accountId}`}
      className={cn(GEM_LINK_CLASS, className)}
    >
      {children}
    </Link>
  );
}

/**
 * The strategy's accounts as links, for the rows that name them. Null when
 * there are none, so the caller renders its own unknown marker.
 */
export function GemAccountLinks({
  accounts,
}: {
  accounts: ReadonlyArray<{ id: string; name: string }>;
}) {
  if (accounts.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap justify-end gap-x-2 gap-y-0.5">
      {accounts.map((account) => (
        <GemAccountLink key={account.id} accountId={account.id}>
          {account.name}
        </GemAccountLink>
      ))}
    </span>
  );
}

/** Label/value row used by the summary and recommendation cards. */
export function GemStatRow({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 text-sm",
        className,
      )}
    >
      <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
      {/* Fund names run long ("iShares MSCI ACWI UCITS ETF USD Acc (IUSQ)") and
          a card is narrow. Wrapping keeps the whole name readable; truncating
          hid the part that distinguishes one share class from another. */}
      <dd className="min-w-0 break-words text-right font-medium text-gray-900 dark:text-gray-100">
        {value}
      </dd>
    </div>
  );
}

/**
 * RISK-ON / RISK-OFF and status pills. The text always carries the meaning, so
 * only two tones exist beyond neutral: the report reserves colour for the chart
 * series and for gains and losses.
 */
export function GemBadge({
  tone,
  children,
  className,
}: {
  tone: "green" | "gray" | "red";
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    green:
      "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 ring-green-600/20",
    red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 ring-red-600/20",
    gray: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200 ring-gray-500/20",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Colour swatch tying a row or legend entry to its chart series. */
export function GemSwatch({
  colour,
  dashed = false,
  className,
}: {
  colour: string;
  /**
   * Draw the swatch as a dashed rule rather than a dot, for a series the chart
   * draws dashed. A legend entry that does not look like its line is a second
   * thing to work out rather than a key to the first.
   */
  dashed?: boolean;
  className?: string;
}) {
  if (dashed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-block w-3.5 shrink-0 border-t-2 border-dashed",
          className,
        )}
        style={{ borderColor: colour }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
        className,
      )}
      style={{ backgroundColor: colour }}
    />
  );
}

/**
 * Compact donut drawn as plain SVG (no chart library needed for a single ring).
 * `segments` are weights in percent; `centre` is the text stacked in the middle.
 * The whole graphic is exposed as one labelled image.
 */
export function GemDonut({
  segments,
  centreValue,
  centreLabel,
  ariaLabel,
  size = 96,
  thickness = 12,
}: {
  segments: Array<{ key: string; percent: number; colour: string }>;
  centreValue: ReactNode;
  centreLabel?: string;
  ariaLabel: string;
  size?: number;
  thickness?: number;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce(
    (sum, segment) => sum + Math.max(segment.percent, 0),
    0,
  );
  let offset = 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-gray-200 dark:stroke-gray-700"
        />
        {total > 0 &&
          segments.map((segment) => {
            const share = Math.max(segment.percent, 0) / total;
            const dash = share * circumference;
            const element = (
              <circle
                key={segment.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={segment.colour}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
            offset += dash;
            return element;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center leading-tight">
        <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {centreValue}
        </span>
        {centreLabel && (
          <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {centreLabel}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Horizontal comparison bar. `width` is a 0-100 share produced by
 * `momentumBarWidth`; negative values are drawn in the loss tone and the
 * accompanying figure always shows its sign.
 */
export function GemBar({
  width,
  negative = false,
  className,
}: {
  width: number;
  /** A negative result keeps the loss tone, matching the signed figure. */
  negative?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700",
        className,
      )}
    >
      {/* Bars are neutral: the signed percentage beside a bar is what carries
          the comparison, so a colour per asset would only add noise. */}
      {/* Through the chart tokens, not Tailwind classes: a hand-rolled CSS bar
          is a chart, and hardcoded red/grey stay literal on every non-default
          colour theme. `SecurityWeightingBars` is the worked example. */}
      <div
        className="h-full rounded-full"
        style={{
          width: `${width}%`,
          backgroundColor: negative ? chartColors.expense : chartColors.neutral,
        }}
      />
    </div>
  );
}

/**
 * Empty/placeholder body for a card whose data the server could not supply
 * (unmapped role, no account, no position, first run). Keeps the card in the
 * layout with an explanation instead of showing zeroes.
 */
export function GemEmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("py-4 text-center", className)}>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
        {title}
      </p>
      {description && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}
