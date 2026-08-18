/**
 * A ledger on disk.
 *
 * Everything up to now has taken its data from a hard-coded demo, which is
 * fine for developing reports and useless for running them against anything
 * real. This is the document format: a chart of accounts and a list of
 * entries, in JSON, with the same guarantees the in-memory types have.
 *
 * Two things it deliberately does not do. It does not accept amounts as
 * numbers — `7200.00` in a JSON file is a decimal string, because the moment
 * a float touches the accounting path the whole design is pointless. And it
 * does not trust the file: entries are rebuilt through `JournalEntry.create`,
 * so an unbalanced entry in a document is rejected on load rather than
 * silently becoming an unbalanced entry in memory.
 */

import { Money } from "../money/money.js";
import type { AccountDefinition } from "../accounts/chart.js";
import { ChartOfAccounts } from "../accounts/chart.js";
import { isAccountType } from "../accounts/types.js";
import { JournalEntry } from "./entry.js";
import { Ledger } from "./ledger.js";

export class LedgerDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerDocumentError";
  }
}

export interface PostingDocument {
  readonly account: string;
  /** Decimal string in major units, e.g. `"-1850.00"`. */
  readonly amount: string;
  readonly currency: string;
  readonly memo?: string;
  /**
   * The transaction-currency amount, when the posting recorded something that
   * happened in a currency other than the one the books are kept in.
   */
  readonly foreign?: { readonly amount: string; readonly currency: string };
}

export interface EntryDocument {
  readonly id: string;
  readonly date: string;
  readonly narration: string;
  readonly postings: readonly PostingDocument[];
  readonly reference?: string;
  readonly tags?: readonly string[];
  readonly reverses?: string;
}

export interface AccountDocument {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly parent?: string;
  readonly currency?: string;
  readonly placeholder?: boolean;
  readonly closed?: boolean;
  readonly description?: string;
}

export interface LedgerDocument {
  readonly version: 1;
  readonly currency: string;
  readonly accounts: readonly AccountDocument[];
  readonly entries: readonly EntryDocument[];
}

// --------------------------------------------------------------------- write

export function entryToDocument(entry: JournalEntry): EntryDocument {
  return {
    id: entry.id,
    date: entry.date,
    narration: entry.narration,
    postings: entry.postings.map((posting) => ({
      account: posting.account,
      amount: posting.amount.toDecimalString(),
      currency: posting.amount.currency.code,
      ...(posting.memo === "" ? {} : { memo: posting.memo }),
      ...(posting.foreign === null
        ? {}
        : {
            foreign: {
              amount: posting.foreign.toDecimalString(),
              currency: posting.foreign.currency.code,
            },
          }),
    })),
    ...(entry.reference === null ? {} : { reference: entry.reference }),
    ...(entry.tags.length === 0 ? {} : { tags: [...entry.tags] }),
    ...(entry.reverses === null ? {} : { reverses: entry.reverses }),
  };
}

export function ledgerToDocument(ledger: Ledger): LedgerDocument {
  const chart = ledger.chart;
  const accounts: AccountDocument[] =
    chart === undefined
      ? []
      : chart.list().map((account) => ({
          code: account.code,
          name: account.name,
          type: account.type,
          ...(account.parent === null ? {} : { parent: account.parent }),
          ...(account.currency.code === chart.defaultCurrency.code
            ? {}
            : { currency: account.currency.code }),
          ...(account.placeholder ? { placeholder: true } : {}),
          ...(account.closed ? { closed: true } : {}),
          ...(account.description === "" ? {} : { description: account.description }),
        }));

  return {
    version: 1,
    currency: chart?.defaultCurrency.code ?? (ledger.currenciesUsed()[0] ?? "GBP"),
    accounts,
    entries: ledger.chronological().map(entryToDocument),
  };
}

export function ledgerToJson(ledger: Ledger, indent = 2): string {
  return JSON.stringify(ledgerToDocument(ledger), null, indent);
}

// ---------------------------------------------------------------------- read

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new LedgerDocumentError(`${what} must be a string, got ${typeof value}`);
  }
  return value;
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new LedgerDocumentError(`${what} must be an array`);
  }
  return value;
}

function readAccount(raw: unknown, index: number): AccountDefinition {
  if (typeof raw !== "object" || raw === null) {
    throw new LedgerDocumentError(`accounts[${index}] must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const type = requireString(record["type"], `accounts[${index}].type`);
  if (!isAccountType(type)) {
    throw new LedgerDocumentError(`accounts[${index}].type is not an account type: ${type}`);
  }
  const definition: AccountDefinition = {
    code: requireString(record["code"], `accounts[${index}].code`),
    name: requireString(record["name"], `accounts[${index}].name`),
    type,
  };
  if (record["parent"] !== undefined) definition.parent = requireString(record["parent"], "parent");
  if (record["currency"] !== undefined) {
    definition.currency = requireString(record["currency"], "currency");
  }
  if (record["placeholder"] !== undefined) definition.placeholder = record["placeholder"] === true;
  if (record["closed"] !== undefined) definition.closed = record["closed"] === true;
  if (record["description"] !== undefined) {
    definition.description = requireString(record["description"], "description");
  }
  return definition;
}

function readEntry(raw: unknown, index: number, fallbackCurrency: string): JournalEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new LedgerDocumentError(`entries[${index}] must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const postings = requireArray(record["postings"], `entries[${index}].postings`).map(
    (rawPosting, postingIndex) => {
      if (typeof rawPosting !== "object" || rawPosting === null) {
        throw new LedgerDocumentError(`entries[${index}].postings[${postingIndex}] must be an object`);
      }
      const posting = rawPosting as Record<string, unknown>;
      const amount = posting["amount"];
      if (typeof amount === "number") {
        throw new LedgerDocumentError(
          `entries[${index}].postings[${postingIndex}].amount is a number; ` +
            `amounts must be decimal strings so no precision is lost in transit`,
        );
      }
      const rawForeign = posting["foreign"];
      let foreign: Money | undefined;
      if (rawForeign !== undefined && rawForeign !== null) {
        if (typeof rawForeign !== "object") {
          throw new LedgerDocumentError(
            `entries[${index}].postings[${postingIndex}].foreign must be an object`,
          );
        }
        const record = rawForeign as Record<string, unknown>;
        if (typeof record["amount"] === "number") {
          throw new LedgerDocumentError(
            `entries[${index}].postings[${postingIndex}].foreign.amount is a number; ` +
              `amounts must be decimal strings so no precision is lost in transit`,
          );
        }
        foreign = Money.parse(
          requireString(record["amount"], "posting.foreign.amount"),
          requireString(record["currency"], "posting.foreign.currency"),
        );
      }

      return {
        account: requireString(posting["account"], "posting.account"),
        amount: Money.parse(
          requireString(amount, "posting.amount"),
          posting["currency"] === undefined
            ? fallbackCurrency
            : requireString(posting["currency"], "posting.currency"),
        ),
        ...(posting["memo"] === undefined
          ? {}
          : { memo: requireString(posting["memo"], "posting.memo") }),
        ...(foreign === undefined ? {} : { foreign }),
      };
    },
  );

  return JournalEntry.create({
    id: requireString(record["id"], `entries[${index}].id`),
    date: requireString(record["date"], `entries[${index}].date`),
    narration: requireString(record["narration"], `entries[${index}].narration`),
    postings,
    ...(record["reference"] === undefined
      ? {}
      : { reference: requireString(record["reference"], "reference") }),
    ...(record["tags"] === undefined
      ? {}
      : { tags: requireArray(record["tags"], "tags").map((t) => requireString(t, "tag")) }),
    ...(record["reverses"] === undefined
      ? {}
      : { reverses: requireString(record["reverses"], "reverses") }),
  });
}

/** Rebuild a ledger from a parsed document, validating as it goes. */
export function ledgerFromDocument(document: unknown): Ledger {
  if (typeof document !== "object" || document === null) {
    throw new LedgerDocumentError("A ledger document must be an object");
  }
  const record = document as Record<string, unknown>;
  if (record["version"] !== 1) {
    throw new LedgerDocumentError(`Unsupported document version: ${String(record["version"])}`);
  }
  const currency = requireString(record["currency"], "currency");

  const rawAccounts = record["accounts"] === undefined ? [] : requireArray(record["accounts"], "accounts");
  const chart =
    rawAccounts.length === 0
      ? undefined
      : ChartOfAccounts.build(
          rawAccounts.map((raw, index) => readAccount(raw, index)),
          { currency },
        );

  const entries = requireArray(record["entries"], "entries").map((raw, index) =>
    readEntry(raw, index, currency),
  );

  return Ledger.from(entries, chart);
}

export function ledgerFromJson(text: string): Ledger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LedgerDocumentError(
      `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ledgerFromDocument(parsed);
}
