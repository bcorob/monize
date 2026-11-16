import { PolishProduct } from "./series-code";
import coi from "../templates/coi.template.json";
import dor from "../templates/dor.template.json";
import edo from "../templates/edo.template.json";
import ots from "../templates/ots.template.json";
import rod from "../templates/rod.template.json";
import ror from "../templates/ror.template.json";
import ros from "../templates/ros.template.json";
import tos from "../templates/tos.template.json";

type Json = Record<string, unknown>;

/**
 * One product's structure with everything per-series left out, so a series
 * cannot inherit another series' rate by accident: the rates and the margin or
 * spread, the early redemption fee, the sale window, the series code and the
 * source (spec bond-program-securities.md 2.6).
 */
interface Structure {
  readonly instrument: Json;
  readonly rateRule: Json;
  readonly redemption: Json & { readonly penalties: readonly Json[] };
  readonly rest: Json;
}

export interface SeriesTemplate {
  readonly product: PolishProduct;
  /**
   * The earliest sale month (`YYYY-MM`) whose issue letter was checked to have this
   * structure; an older series is refused (`TEMPLATE_NOT_VALIDATED`).
   */
  readonly validFrom: string;
  /** Which per-series rate field follows the first period's, if any. */
  readonly addend: "margin" | "spread" | null;
  readonly hasFee: boolean;
  readonly structure: Structure;
}

/**
 * The templates are data (`../templates/<product>.template.json`), one per
 * product: the structure, `validFrom`, and which per-series fields the series
 * fetch and the manual entry fill. `validFrom` is 2024-01 for every product: the
 * letter of the series sold in January 2024 (OTS0424, ROR0125, DOR0126, TOS0127,
 * COI0128, ROS0130, EDO0134, ROD0136) was read against the October 2026 letter
 * of the same product, and the paragraphs that carry the terms (first-period
 * rate, the margin and its observation, the early redemption window, the fee and
 * its cap, the floor, the record day, the period length) are word for word the
 * same. Only the minister's title, the payout account wording and the annex
 * layout differ. Checked on 2026-10-11; an older month was not checked.
 */
export const SERIES_TEMPLATES: Readonly<Record<PolishProduct, SeriesTemplate>> =
  {
    OTS: ots as SeriesTemplate,
    ROR: ror as SeriesTemplate,
    DOR: dor as SeriesTemplate,
    TOS: tos as SeriesTemplate,
    COI: coi as SeriesTemplate,
    ROS: ros as SeriesTemplate,
    EDO: edo as SeriesTemplate,
    ROD: rod as SeriesTemplate,
  };

/** The template filled with a series' values: the terms document, before parsing. */
export function fillTemplate(
  t: SeriesTemplate,
  fill: {
    readonly seriesCode: string;
    readonly firstPeriodRate: string;
    readonly addend: string | null;
    readonly fee: string | null;
    readonly saleWindow: { readonly from: string; readonly to: string };
    readonly source: Json;
  },
): unknown {
  const s = t.structure;
  const rateRule: Json = { ...s.rateRule };
  if (rateRule.type === "FIXED") {
    rateRule.annualRate = fill.firstPeriodRate;
  } else {
    rateRule.firstPeriodRate = fill.firstPeriodRate;
    if (t.addend !== null) rateRule[t.addend] = fill.addend;
  }
  return {
    ...s.rest,
    instrument: { ...s.instrument, seriesCode: fill.seriesCode },
    saleWindow: { from: fill.saleWindow.from, to: fill.saleWindow.to },
    rateRule,
    redemption: {
      ...s.redemption,
      penalties: s.redemption.penalties.map((p) =>
        p.type === "FIXED_FEE_PER_UNIT" ? { ...p, amount: fill.fee } : p,
      ),
    },
    source: fill.source,
  };
}
