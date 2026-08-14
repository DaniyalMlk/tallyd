/**
 * Currency metadata.
 *
 * The only thing the accounting core needs from a currency is how many minor
 * units make up one major unit — that is what governs parsing, formatting and
 * rounding. Everything else (symbol, name) is presentation.
 */

export interface Currency {
  /** ISO 4217 alphabetic code, e.g. "GBP". */
  readonly code: string;
  /** Number of decimal digits in the minor unit. GBP=2, JPY=0, KWD=3. */
  readonly exponent: number;
  /** Display symbol, e.g. "£". Falls back to the code when unknown. */
  readonly symbol: string;
  readonly name: string;
}

const REGISTRY = new Map<string, Currency>();

function define(code: string, exponent: number, symbol: string, name: string): Currency {
  const currency: Currency = Object.freeze({ code, exponent, symbol, name });
  REGISTRY.set(code, currency);
  return currency;
}

// A deliberately small set. Adding a currency is one line; guessing at an
// exponent we have not verified is how you end up dividing yen by 100.
export const GBP = define("GBP", 2, "£", "Pound Sterling");
export const USD = define("USD", 2, "$", "US Dollar");
export const EUR = define("EUR", 2, "€", "Euro");
export const JPY = define("JPY", 0, "¥", "Yen");
export const KWD = define("KWD", 3, "KD", "Kuwaiti Dinar");
export const CHF = define("CHF", 2, "CHF", "Swiss Franc");
export const CAD = define("CAD", 2, "CA$", "Canadian Dollar");
export const AUD = define("AUD", 2, "A$", "Australian Dollar");

export class UnknownCurrencyError extends Error {
  constructor(readonly code: string) {
    super(`Unknown currency code: ${code}`);
    this.name = "UnknownCurrencyError";
  }
}

/** Look up a registered currency by ISO code. Case-insensitive. */
export function currency(code: string): Currency {
  const found = REGISTRY.get(code.toUpperCase());
  if (found === undefined) throw new UnknownCurrencyError(code);
  return found;
}

/** Register a currency not in the built-in set. Returns the frozen record. */
export function registerCurrency(
  code: string,
  exponent: number,
  symbol = code,
  name = code,
): Currency {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new RangeError(`Currency code must be three letters, got: ${code}`);
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new RangeError(`Currency exponent must be an integer in 0..6, got: ${exponent}`);
  }
  const existing = REGISTRY.get(upper);
  if (existing !== undefined) {
    if (existing.exponent !== exponent) {
      throw new RangeError(
        `Currency ${upper} is already registered with exponent ${existing.exponent}`,
      );
    }
    return existing;
  }
  return define(upper, exponent, symbol, name);
}

export function isRegistered(code: string): boolean {
  return REGISTRY.has(code.toUpperCase());
}

/** All registered currencies, sorted by code. Useful for CLI help output. */
export function allCurrencies(): readonly Currency[] {
  return [...REGISTRY.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** 10 ** exponent as a bigint, used to convert between major and minor units. */
export function minorUnitScale(c: Currency): bigint {
  return 10n ** BigInt(c.exponent);
}
