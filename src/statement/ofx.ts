/**
 * A reader for the subset of OFX/QFX that bank downloads actually contain.
 *
 * OFX is SGML, not XML: tags are frequently unclosed, so `<NAME>TESCO` runs to
 * the end of the line. A strict XML parser fails on nearly every real file.
 * This reads the aggregate structure directly, which is both simpler and more
 * tolerant, and it only understands the handful of tags a bank statement uses.
 *
 * Not supported, deliberately: investment transactions, bill-pay aggregates
 * and the OFX request/response envelope. Those are a different product.
 */

import { Money } from "../money/money.js";
import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency, isRegistered } from "../money/currency.js";
import { type CalendarDate, date as toCalendarDate } from "../ledger/date.js";
import type { RowError } from "./import.js";
import { type StatementLine, statementLine } from "./line.js";

export interface OfxAccount {
  readonly bankId: string | null;
  readonly accountId: string | null;
  readonly accountType: string | null;
  readonly currency: Currency;
}

export interface OfxImportResult {
  readonly lines: readonly StatementLine[];
  readonly errors: readonly RowError[];
  readonly warnings: readonly string[];
  readonly account: OfxAccount;
  readonly ledgerBalance: Money | null;
  readonly balanceAsOf: CalendarDate | null;
  readonly transactionCount: number;
}

/**
 * Read an OFX datetime: `YYYYMMDD`, optionally with a time and a bracketed
 * timezone, e.g. `20260814120000[-5:EST]`. Only the date survives — see the
 * note in `ledger/date.ts` on why postings do not carry an instant.
 */
export function parseOfxDate(raw: string): CalendarDate {
  const text = raw.trim();
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (match === null) throw new RangeError(`Not an OFX date: ${JSON.stringify(raw)}`);
  return toCalendarDate(`${match[1]}-${match[2]}-${match[3]}`);
}

/** Pull the value of an unclosed-or-closed SGML tag from one aggregate. */
function tagValue(block: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i");
  const match = pattern.exec(block);
  if (match === null) return null;
  const value = (match[1] ?? "").trim();
  return value === "" ? null : value;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

/** Split out every `<STMTTRN>` aggregate. */
export function extractTransactionBlocks(input: string): readonly string[] {
  const blocks: string[] = [];
  const pattern = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const body = match[1] ?? "";
    if (body.trim() !== "") blocks.push(body);
  }
  return blocks;
}

export interface OfxImportOptions {
  /** Fallback when the file does not declare one. */
  currency?: Currency | string;
  idPrefix?: string;
}

export function importOfx(input: string, options: OfxImportOptions = {}): OfxImportResult {
  const text = input.replace(/\r\n/g, "\n");
  const warnings: string[] = [];
  const errors: RowError[] = [];

  const declared = tagValue(text, "CURDEF");
  const fallback =
    typeof options.currency === "string"
      ? lookupCurrency(options.currency)
      : (options.currency ?? lookupCurrency("GBP"));

  let currency = fallback;
  if (declared !== null) {
    if (isRegistered(declared)) {
      currency = lookupCurrency(declared);
    } else {
      warnings.push(`File declares unknown currency ${declared}; using ${fallback.code}`);
    }
  } else {
    warnings.push(`File declares no currency; assuming ${fallback.code}`);
  }

  const account: OfxAccount = Object.freeze({
    bankId: tagValue(text, "BANKID"),
    accountId: tagValue(text, "ACCTID"),
    accountType: tagValue(text, "ACCTTYPE"),
    currency,
  });

  const blocks = extractTransactionBlocks(text);
  const prefix = options.idPrefix ?? "OFX";
  const lines: StatementLine[] = [];

  blocks.forEach((block, index) => {
    const rawDate = tagValue(block, "DTPOSTED");
    const rawAmount = tagValue(block, "TRNAMT");

    if (rawDate === null) {
      errors.push({ row: index, reason: "transaction has no DTPOSTED", cells: [block.trim()] });
      return;
    }
    if (rawAmount === null) {
      errors.push({ row: index, reason: "transaction has no TRNAMT", cells: [block.trim()] });
      return;
    }

    let when: CalendarDate;
    try {
      when = parseOfxDate(rawDate);
    } catch (error) {
      errors.push({
        row: index,
        reason: error instanceof Error ? error.message : String(error),
        cells: [block.trim()],
      });
      return;
    }

    let amount: Money;
    try {
      // OFX mandates a dot decimal and no grouping, and signs the amount
      // itself: negative is money out, which matches our convention already.
      amount = Money.parse(rawAmount.replace(/,/g, ""), currency);
    } catch (error) {
      errors.push({
        row: index,
        reason: error instanceof Error ? error.message : String(error),
        cells: [block.trim()],
      });
      return;
    }

    const name = tagValue(block, "NAME");
    const memo = tagValue(block, "MEMO");
    const payee = tagValue(block, "PAYEE");
    const description = decodeEntities([payee, name, memo].filter((v) => v !== null).join(" — "));

    const fitId = tagValue(block, "FITID");
    const checkNum = tagValue(block, "CHECKNUM");
    const type = tagValue(block, "TRNTYPE");

    let valueDate: CalendarDate | undefined;
    const rawValueDate = tagValue(block, "DTAVAIL");
    if (rawValueDate !== null) {
      try {
        valueDate = parseOfxDate(rawValueDate);
      } catch {
        warnings.push(`Transaction ${index}: could not read DTAVAIL`);
      }
    }

    const raw: Record<string, string> = {};
    for (const tag of ["FITID", "TRNTYPE", "DTPOSTED", "TRNAMT", "NAME", "MEMO", "CHECKNUM"]) {
      const value = tagValue(block, tag);
      if (value !== null) raw[tag] = value;
    }

    lines.push(
      statementLine({
        // FITID is the bank's own unique id and is the right thing to key on
        // when present, because it survives a re-download of the same period.
        id: fitId !== null ? `${prefix}-${fitId}` : `${prefix}-${String(index + 1).padStart(4, "0")}`,
        date: when,
        ...(valueDate === undefined ? {} : { valueDate }),
        description,
        amount,
        ...(checkNum === null ? {} : { reference: checkNum }),
        ...(type === null ? {} : { type }),
        sourceRow: index,
        raw,
      }),
    );
  });

  let ledgerBalance: Money | null = null;
  let balanceAsOf: CalendarDate | null = null;
  const ledgerBalanceBlock = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|$)/i.exec(text);
  if (ledgerBalanceBlock !== null) {
    const body = ledgerBalanceBlock[1] ?? "";
    const rawBalance = tagValue(body, "BALAMT");
    if (rawBalance !== null) {
      try {
        ledgerBalance = Money.parse(rawBalance.replace(/,/g, ""), currency);
      } catch {
        warnings.push(`Could not read LEDGERBAL BALAMT ${JSON.stringify(rawBalance)}`);
      }
    }
    const rawAsOf = tagValue(body, "DTASOF");
    if (rawAsOf !== null) {
      try {
        balanceAsOf = parseOfxDate(rawAsOf);
      } catch {
        warnings.push("Could not read LEDGERBAL DTASOF");
      }
    }
  }

  return Object.freeze({
    lines: Object.freeze(lines),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    account,
    ledgerBalance,
    balanceAsOf,
    transactionCount: blocks.length,
  });
}

/** True when the text looks like OFX rather than CSV. */
export function looksLikeOfx(input: string): boolean {
  const head = input.slice(0, 4096).toUpperCase();
  return head.includes("<OFX>") || head.includes("OFXHEADER") || head.includes("<STMTTRN>");
}
