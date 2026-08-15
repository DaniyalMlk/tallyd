/**
 * Argument parsing, written rather than installed.
 *
 * A dependency would do this, and for a tool this size the dependency is the
 * larger risk: everything a ledger CLI needs — long flags, `--flag=value` and
 * `--flag value`, short aliases, repeated values, `--` to stop parsing — is a
 * page of code that can be tested against the awkward cases instead of
 * trusted.
 *
 * The awkward cases are the point. `--account -1100` should be a value, not a
 * missing flag followed by a stray negative number. `--as-at=2026-08-31` and
 * `--as-at 2026-08-31` must mean the same thing. An unknown flag must be an
 * error rather than silently ignored, because a typo in `--as-at` that reports
 * the wrong period without complaining is exactly the failure a report tool
 * cannot afford.
 */

export type FlagKind = "string" | "boolean" | "list";

export interface FlagSpec {
  readonly kind: FlagKind;
  /** Single-character alias, without the dash. */
  readonly short?: string;
  readonly describe: string;
  readonly placeholder?: string;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

export interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean | readonly string[]>>;
}

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

function specFor(specs: FlagSpecs, name: string): { key: string; spec: FlagSpec } {
  const direct = specs[name];
  if (direct !== undefined) return { key: name, spec: direct };

  if (name.length === 1) {
    for (const [key, spec] of Object.entries(specs)) {
      if (spec.short === name) return { key, spec };
    }
  }
  throw new ArgumentError(`Unknown option: ${name.length === 1 ? "-" : "--"}${name}`);
}

/**
 * Parse `argv` against a flag table.
 *
 * Everything after a bare `--` is positional, however it looks. Anything not
 * recognised is an error rather than a shrug.
 */
export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  let index = 0;
  let literal = false;

  const setValue = (key: string, spec: FlagSpec, value: string): void => {
    if (spec.kind === "list") {
      const existing = flags[key];
      if (Array.isArray(existing)) existing.push(value);
      else flags[key] = [value];
      return;
    }
    flags[key] = value;
  };

  while (index < argv.length) {
    const token = argv[index] as string;
    index++;

    if (literal) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }

    const isLong = token.startsWith("--") && token.length > 2;
    const isShort = !isLong && token.startsWith("-") && token.length > 1 && token !== "-";

    if (!isLong && !isShort) {
      positional.push(token);
      continue;
    }

    const body = isLong ? token.slice(2) : token.slice(1);
    const equals = body.indexOf("=");
    const name = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? null : body.slice(equals + 1);

    const { key, spec } = specFor(specs, name);

    if (spec.kind === "boolean") {
      if (inline !== null) {
        if (inline !== "true" && inline !== "false") {
          throw new ArgumentError(`--${key} is a switch and takes no value`);
        }
        flags[key] = inline === "true";
        continue;
      }
      flags[key] = true;
      continue;
    }

    if (inline !== null) {
      setValue(key, spec, inline);
      continue;
    }

    // A value is whatever comes next, even if it starts with a dash: an
    // account code or a negative amount is a legitimate value.
    const next = argv[index];
    if (next === undefined) {
      throw new ArgumentError(`--${key} needs a value`);
    }
    index++;
    setValue(key, spec, next);
  }

  return Object.freeze({ positional: Object.freeze(positional), flags: Object.freeze(flags) });
}

export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ArgumentError(`--${name} takes a single value`);
  }
  return value;
}

export function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (value === undefined) throw new ArgumentError(`--${name} is required`);
  return value;
}

export function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function listFlag(parsed: ParsedArgs, name: string): readonly string[] {
  const value = parsed.flags[name];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  throw new ArgumentError(`--${name} takes values`);
}

/** Render a flag table as aligned help text. */
export function renderFlags(specs: FlagSpecs, indent = "  "): string {
  const entries = Object.entries(specs);
  if (entries.length === 0) return "";

  const left = entries.map(([name, spec]) => {
    const short = spec.short === undefined ? "    " : `-${spec.short}, `;
    const placeholder =
      spec.kind === "boolean" ? "" : ` <${spec.placeholder ?? (spec.kind === "list" ? "value..." : "value")}>`;
    return `${short}--${name}${placeholder}`;
  });
  const width = Math.max(...left.map((text) => text.length));

  return entries
    .map(([, spec], i) => `${indent}${(left[i] as string).padEnd(width + 2)}${spec.describe}`)
    .join("\n");
}
