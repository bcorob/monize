import { completeness } from "../parsing/parse-receipt";
import type {
  ParsedReceipt,
  ParsedReceiptItem,
  ReceiptLinkOutcome,
  ReceiptLinkReport,
} from "../parsing/receipt-parser.types";

export { RECEIPT_LINK_OUTCOMES } from "../parsing/receipt-parser.types";
export type { ReceiptLinkOutcome } from "../parsing/receipt-parser.types";

/**
 * The join of a settlement receipt with its components (linked receipts spec
 * section 4). Pure: no database, no clock. The caller finds the component of
 * each part and the amount other settlements already took from it; this file
 * decides what each part becomes. Amounts are integer 1/10000 units; a scaled
 * line is whole cents (a multiple of 100 units) because it becomes a split.
 */

const UNITS_PER_CENT = 100;

/** The component a part's link found: its id, its reading and its profile's tag. */
export interface JoinComponent {
  receiptId: string;
  parsed: ParsedReceipt;
  tagName: string | null;
  /**
   * What a person needs to recognise the component (the dry run shows it);
   * `joinSettlement` does not read them. Absent when the caller did not look.
   */
  subject?: string;
  /** `YYYY-MM-DD` (UTC). */
  effectiveDate?: string;
  /** The name of the component's profile; null when it has none. */
  profileName?: string | null;
}

/** What the caller found for one settlement item (one part), by index. */
export interface JoinPart {
  /** The component the link found (the first of several); null when none. */
  component: JoinComponent | null;
  /** How many components the link found: 0, 1 or more. */
  several: number;
  /** Units other settlements already took from this component. */
  taken: number;
}

export interface JoinedSettlement {
  /** The settlement with its items replaced by the joined lines and `links` set. */
  parsed: ParsedReceipt;
  reports: ReceiptLinkReport[];
  /** The reason each used component now holds: `settled` or `instalment` (spec 4.3). */
  componentReasons: { receiptId: string; reason: "settled" | "instalment" }[];
  /** The tags of the joined components' profiles, without duplicates (case-insensitive), in part order. */
  tagNames: string[];
}

/** True when some part of the receipt was joined or scaled. */
export function hasJoinedPart(parsed: ParsedReceipt): boolean {
  return (parsed.links ?? []).some(
    (report) => report.outcome === "joined" || report.outcome === "scaled",
  );
}

/** A component's lines (spec 4.1): items, shipping, each fee, then the discount. */
function componentLines(component: ParsedReceipt): ParsedReceiptItem[] {
  const lines: ParsedReceiptItem[] = component.items.map((item) => {
    // `link` and `instalment` belong to a settlement's part, never to a component's line.
    const { link: _link, instalment: _instalment, ...rest } = item;
    return { ...rest, kind: item.kind ?? "item" };
  });
  if ((component.shipping ?? 0) > 0) {
    lines.push({
      name: "shipping",
      qty: 1,
      amount: component.shipping as number,
      categoryId: component.shippingCategoryId,
      kind: "shipping",
    });
  }
  for (const fee of component.fees ?? []) {
    if (fee > 0) {
      lines.push({
        name: "fee",
        qty: 1,
        amount: fee,
        categoryId: component.feesCategoryId ?? null,
        kind: "fee",
      });
    }
  }
  if ((component.discount ?? 0) > 0) {
    lines.push({
      name: "discount",
      qty: 1,
      amount: component.discount as number,
      categoryId: component.discountCategoryId,
      kind: "discount",
    });
  }
  return lines;
}

/** A line's amount with the sign it counts with: a discount is negative. */
const signed = (line: ParsedReceiptItem): number =>
  line.kind === "discount" ? -line.amount : line.amount;

/** A component's net `N` (spec 4.1): the signed sum of its lines, in 1/10000 units. */
export function componentNet(component: ParsedReceipt): number {
  return componentLines(component).reduce((sum, line) => sum + signed(line), 0);
}

/** Round half away from zero of `numerator / denominator` (denominator > 0). */
function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = (2n * abs + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

/**
 * The lines scaled to the part's amount `a` (spec 4.3): `s(l) = round(l * a /
 * (N * 100)) * 100` per line with `BigInt`, the rest to the line with the
 * largest positive `s` (ties: the first), lines scaled to 0 dropped. The
 * returned lines sum exactly to `a` (a discount counted negative).
 */
function scaleLines(
  lines: readonly ParsedReceiptItem[],
  net: number,
  amount: number,
  instalment: string | undefined,
): ParsedReceiptItem[] {
  const divisor = BigInt(net) * BigInt(UNITS_PER_CENT);
  const scaled = lines.map((line) =>
    Number(
      roundDivide(BigInt(signed(line)) * BigInt(amount), divisor) *
        BigInt(UNITS_PER_CENT),
    ),
  );
  const rest = amount - scaled.reduce((sum, units) => sum + units, 0);
  if (rest !== 0) {
    // The largest positive scaled line; when every line scaled to 0 (a part of
    // a few cents), the largest positive line itself, so the sum stays exact.
    const largest = (values: readonly number[]): number => {
      let target = -1;
      values.forEach((units, index) => {
        if (units > 0 && (target === -1 || units > values[target])) {
          target = index;
        }
      });
      return target;
    };
    let target = largest(scaled);
    if (target === -1) target = largest(lines.map(signed));
    if (target !== -1) scaled[target] += rest;
  }
  const out: ParsedReceiptItem[] = [];
  lines.forEach((line, index) => {
    if (scaled[index] === 0) return;
    out.push({
      ...line,
      amount: Math.abs(scaled[index]),
      ...(instalment === undefined ? {} : { instalment }),
    });
  });
  return out;
}

/** The part as the settlement read it, as one line, without its link and instalment. */
function keptPart(item: ParsedReceiptItem): ParsedReceiptItem {
  const { link: _link, instalment: _instalment, ...rest } = item;
  return rest;
}

/**
 * Join a settlement's parts with their components (spec 4.2, one row per part):
 * a part with no usable component stays one line; a component whose net equals
 * the part and was never used replaces it with its own lines; a component with
 * more left than the part gives its lines scaled to the part's amount; a part
 * above what is left stays one line (`amount_exceeds`). `parts` has one entry
 * per `settlement.items` index.
 */
export function joinSettlement(
  settlement: ParsedReceipt,
  parts: readonly JoinPart[],
): JoinedSettlement {
  const items: ParsedReceiptItem[] = [];
  const reports: ReceiptLinkReport[] = [];
  const componentReasons: JoinedSettlement["componentReasons"] = [];
  const tagNames: string[] = [];
  const seenTags = new Set<string>();

  settlement.items.forEach((item, partIndex) => {
    const part: JoinPart = parts[partIndex] ?? {
      component: null,
      several: 0,
      taken: 0,
    };
    const link = item.link ?? null;
    const partAmount = item.amount;
    const report = (
      outcome: ReceiptLinkOutcome,
      extra: Partial<ReceiptLinkReport> = {},
    ): void => {
      reports.push({
        partIndex,
        link,
        partAmount,
        outcome,
        componentReceiptId: part.component?.receiptId ?? null,
        ...(part.several > 1 ? { several: part.several } : {}),
        ...extra,
      });
    };
    const keep = (outcome: ReceiptLinkOutcome, extra = {}): void => {
      items.push(keptPart(item));
      report(outcome, extra);
    };

    if (link === null) return keep("no_link");
    const found = part.component;
    if (found === null) return keep("not_found");
    const component = found.parsed;
    if (!component.complete) {
      return keep("component_incomplete", {
        componentReason: component.reason,
      });
    }

    const lines = componentLines(component);
    const net = lines.reduce((sum, line) => sum + signed(line), 0);
    const remaining = net - part.taken;
    const figures = { componentNet: net, taken: part.taken };
    if (remaining <= 0) return keep("component_used", figures);
    if (partAmount > remaining) return keep("amount_exceeds", figures);

    const exact = partAmount === net && part.taken === 0;
    if (exact) {
      items.push(...lines);
    } else {
      items.push(...scaleLines(lines, net, partAmount, item.instalment));
    }
    report(exact ? "joined" : "scaled", figures);
    componentReasons.push({
      receiptId: found.receiptId,
      reason: part.taken + partAmount >= net ? "settled" : "instalment",
    });
    const tag = found.tagName;
    if (tag !== null && !seenTags.has(tag.toLowerCase())) {
      seenTags.add(tag.toLowerCase());
      tagNames.push(tag);
    }
  });

  const base = { ...settlement, items, links: reports };
  const { complete: _complete, reason: _reason, ...rest } = base;
  const reason = completeness(rest);
  return {
    parsed: { ...base, complete: reason === null, reason },
    reports,
    componentReasons,
    tagNames,
  };
}
