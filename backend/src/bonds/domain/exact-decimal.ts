import { assertNever } from "./assert-never";

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/** How a value is brought to a number of decimals: ties away from zero, ties to even, or toward zero. */
export type RoundingMode = "HALF_UP" | "HALF_EVEN" | "DOWN";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * An exact rational over BigInt, normalised (gcd 1, denominator > 0).
 *
 * The bond engine (INV-BOND-003) never touches a JavaScript number on a money
 * or rate path: a value enters as a decimal string or an integer, is combined
 * exactly, and is rounded only where the issue letter rounds.
 */
export class ExactDecimal {
  static readonly ZERO = new ExactDecimal(0n, 1n);
  static readonly ONE = new ExactDecimal(1n, 1n);

  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}

  static of(numerator: bigint, denominator: bigint = 1n): ExactDecimal {
    if (denominator === 0n) {
      throw new RangeError("ExactDecimal: zero denominator");
    }
    const sign = denominator < 0n ? -1n : 1n;
    const g = gcd(numerator, denominator) || 1n;
    return new ExactDecimal((sign * numerator) / g, (sign * denominator) / g);
  }

  /** Accepts a plain decimal string only: no exponent, no spaces, no number. */
  static parse(text: string): ExactDecimal {
    if (typeof text !== "string" || !DECIMAL_PATTERN.test(text)) {
      throw new TypeError(
        `ExactDecimal: not a decimal string: ${String(text)}`,
      );
    }
    const negative = text.startsWith("-");
    const body = negative ? text.slice(1) : text;
    const [whole, fraction = ""] = body.split(".");
    const numerator = BigInt(whole + fraction);
    return ExactDecimal.of(
      negative ? -numerator : numerator,
      10n ** BigInt(fraction.length),
    );
  }

  static fromInt(value: number): ExactDecimal {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`ExactDecimal: not a safe integer: ${value}`);
    }
    return ExactDecimal.of(BigInt(value));
  }

  /** A ratio of two day counts (integers only), e.g. a / ACT. */
  static ratio(numerator: number, denominator: number): ExactDecimal {
    return ExactDecimal.fromInt(numerator).div(
      ExactDecimal.fromInt(denominator),
    );
  }

  static max(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
    return a.cmp(b) >= 0 ? a : b;
  }

  add(other: ExactDecimal): ExactDecimal {
    return ExactDecimal.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  sub(other: ExactDecimal): ExactDecimal {
    return this.add(other.negate());
  }

  mul(other: ExactDecimal): ExactDecimal {
    return ExactDecimal.of(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    );
  }

  div(other: ExactDecimal): ExactDecimal {
    if (other.numerator === 0n) {
      throw new RangeError("ExactDecimal: division by zero");
    }
    return ExactDecimal.of(
      this.numerator * other.denominator,
      this.denominator * other.numerator,
    );
  }

  negate(): ExactDecimal {
    return new ExactDecimal(-this.numerator, this.denominator);
  }

  cmp(other: ExactDecimal): -1 | 0 | 1 {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  isNegative(): boolean {
    return this.numerator < 0n;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  /**
   * Round to `places` decimals, ties away from zero (so -0.005 -> -0.01).
   * The issue letters say "rounded to two decimal places" and name no mode;
   * half-up is assumption 1 of the spec.
   */
  roundHalfUp(places: number): ExactDecimal {
    return this.round(places, "HALF_UP");
  }

  /**
   * Round to `decimals` places by `mode`, on the exact value: HALF_UP ties away
   * from zero, HALF_EVEN ties to the even last digit (banker's rounding), DOWN
   * toward zero (truncation).
   */
  round(decimals: number, mode: RoundingMode): ExactDecimal {
    return ExactDecimal.of(
      this.scaledBy(decimals, mode),
      10n ** BigInt(decimals),
    );
  }

  /** Round half-up, then format with exactly `places` decimals. */
  toFixed(places: number): string {
    const scaled = this.scaledBy(places, "HALF_UP");
    const digits = abs(scaled)
      .toString()
      .padStart(places + 1, "0");
    const whole = digits.slice(0, digits.length - places);
    const fraction = digits.slice(digits.length - places);
    const sign = scaled < 0n ? "-" : "";
    return places === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
  }

  /** The value times 10^places as a signed integer, rounded by `mode`. */
  private scaledBy(places: number, mode: RoundingMode): bigint {
    if (!Number.isInteger(places) || places < 0) {
      throw new RangeError(`ExactDecimal: invalid places: ${places}`);
    }
    const scaled = abs(this.numerator) * 10n ** BigInt(places);
    const quotient = scaled / this.denominator;
    const twiceRemainder = 2n * (scaled % this.denominator);
    let magnitude: bigint;
    switch (mode) {
      case "DOWN":
        magnitude = quotient;
        break;
      case "HALF_UP":
        magnitude =
          twiceRemainder >= this.denominator ? quotient + 1n : quotient;
        break;
      case "HALF_EVEN":
        magnitude =
          twiceRemainder > this.denominator ||
          (twiceRemainder === this.denominator && quotient % 2n === 1n)
            ? quotient + 1n
            : quotient;
        break;
      default:
        return assertNever(mode);
    }
    return this.isNegative() ? -magnitude : magnitude;
  }

  /** `toFixed(maxPlaces)` with trailing zeros dropped down to `minPlaces`. */
  toTrimmedString(maxPlaces: number, minPlaces: number): string {
    const text = this.toFixed(maxPlaces);
    if (maxPlaces === 0) return text;
    const [whole, fraction] = text.split(".");
    let end = fraction.length;
    while (end > minPlaces && fraction[end - 1] === "0") end -= 1;
    return end === 0 ? whole : `${whole}.${fraction.slice(0, end)}`;
  }
}
