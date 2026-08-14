/**
 * Integer division with an explicit rounding policy.
 *
 * Every rounding decision in the accounting path routes through here, so there
 * is exactly one place where the tie-breaking rules live. All arithmetic is on
 * bigints: nothing in this file can lose precision, only choose a direction.
 */

export type RoundingMode =
  /** Toward +infinity. */
  | "ceil"
  /** Toward -infinity. */
  | "floor"
  /** Toward zero (truncate). */
  | "down"
  /** Away from zero. */
  | "up"
  /** Nearest; ties away from zero. The intuitive schoolbook rule. */
  | "half-up"
  /** Nearest; ties toward zero. */
  | "half-down"
  /** Nearest; ties to the even neighbour. Banker's rounding. */
  | "half-even";

export const ROUNDING_MODES: readonly RoundingMode[] = [
  "ceil",
  "floor",
  "down",
  "up",
  "half-up",
  "half-down",
  "half-even",
];

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * Divide `numerator` by `denominator`, returning an exact integer under the
 * given rounding mode. Throws on a zero denominator.
 */
export function divideRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = "half-even",
): bigint {
  if (denominator === 0n) throw new RangeError("Division by zero");

  // Normalise so the denominator is positive; the sign lives in the numerator.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const negative = n < 0n;
  const magnitude = abs(n);
  const quotient = magnitude / d;
  const remainder = magnitude - quotient * d;

  if (remainder === 0n) return negative ? -quotient : quotient;

  // `roundAway` decides whether to move the magnitude up to the next integer.
  let roundAway: boolean;
  switch (mode) {
    case "down":
      roundAway = false;
      break;
    case "up":
      roundAway = true;
      break;
    case "ceil":
      roundAway = !negative;
      break;
    case "floor":
      roundAway = negative;
      break;
    case "half-up":
    case "half-down":
    case "half-even": {
      const twice = remainder * 2n;
      if (twice > d) {
        roundAway = true;
      } else if (twice < d) {
        roundAway = false;
      } else if (mode === "half-up") {
        roundAway = true;
      } else if (mode === "half-down") {
        roundAway = false;
      } else {
        roundAway = quotient % 2n !== 0n;
      }
      break;
    }
  }

  const rounded = roundAway ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parse a decimal literal into an exact rational. Accepts optional sign,
 * digits, a fractional part and scientific notation: "-1.25", "3", "2.5e-3".
 */
export function decimalToRational(input: string): { numerator: bigint; denominator: bigint } {
  const text = input.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) throw new RangeError(`Not a decimal number: ${JSON.stringify(input)}`);

  const [, sign = "", whole = "", fraction = "", exponent] = match;
  if (whole === "" && fraction === "") {
    throw new RangeError(`Not a decimal number: ${JSON.stringify(input)}`);
  }

  let numerator = BigInt((whole === "" ? "0" : whole) + fraction);
  let denominator = 10n ** BigInt(fraction.length);

  if (exponent !== undefined) {
    const e = BigInt(exponent);
    if (e > 0n) numerator *= 10n ** e;
    else if (e < 0n) denominator *= 10n ** -e;
  }

  if (sign === "-") numerator = -numerator;
  return { numerator, denominator };
}

/** Convert a finite JS number to an exact rational via its shortest decimal form. */
export function numberToRational(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value)) throw new RangeError(`Factor must be finite, got: ${value}`);
  return decimalToRational(value.toString());
}
