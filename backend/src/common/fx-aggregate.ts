/**
 * Accumulate amounts that each need converting into one reporting currency,
 * keeping "could not convert" distinguishable from "converted to zero".
 *
 * Why this is a class rather than a `reduce`: the defect it replaces was a
 * single `?? amount` at the end of a conversion helper (audit P5-009). Each
 * call site read `total += convert(...)` and looked correct; the lie was one
 * level down, where a missing rate became a rate of 1. Handing the sites an
 * accumulator that *cannot* silently absorb a missing rate removes the place
 * that mistake can live.
 *
 * Read `docs/specs/fx-conversion-completeness.md` for the invariants and the
 * numerical examples, and `docs/financial-calculation-contract.md` section 1 for
 * the total/subtotal rule this implements.
 */
export class FxAggregate {
  /**
   * Accumulated in integer ten-thousandths (the resolution of `decimal(20,4)`),
   * per the Financial Math rule in CLAUDE.md: `subtotal += converted` in floats
   * accumulates drift, and this class is the one accumulator every total folds
   * through, which is exactly where that drift would multiply.
   */
  private subtotalMinorUnits = 0;
  private readonly missing = new Set<string>();

  /**
   * Add one component. `converted` is what the conversion returned: `null`
   * means no rate was available for `from -> to`, which makes the total
   * unknowable rather than smaller.
   */
  add(converted: number | null, from: string, to: string): void {
    if (converted === null) {
      this.missing.add(`${from}->${to}`);
      return;
    }
    this.subtotalMinorUnits += Math.round(converted * 10000);
  }

  /** Add a value that needed no conversion (already in the reporting currency). */
  addConverted(amount: number): void {
    this.subtotalMinorUnits += Math.round(amount * 10000);
  }

  /** Fold in another aggregate, carrying its gaps with its subtotal. */
  merge(other: FxAggregate): void {
    this.subtotalMinorUnits += other.subtotalMinorUnits;
    for (const pair of other.missing) this.missing.add(pair);
  }

  /**
   * The complete total, or `null` when any component could not be converted.
   *
   * Note that this is `0` -- not `null` -- for an aggregate nothing was ever
   * added to: an empty account holds zero, and reporting that as unknown tells
   * the user a settled question could not be worked out.
   */
  get total(): number | null {
    return this.missing.size > 0 ? null : this.subtotalMinorUnits / 10000;
  }

  /**
   * The sum of the components that did convert. Safe to display beside the
   * missing pairs, never under a field whose name says "total".
   */
  get knownSubtotal(): number {
    return this.subtotalMinorUnits / 10000;
  }

  /** `"USD->EUR"` for each unresolvable pair; empty when the total is complete. */
  get missingPairs(): string[] {
    return [...this.missing].sort();
  }

  get isComplete(): boolean {
    return this.missing.size === 0;
  }
}
