/**
 * The group as a file.
 *
 * A consolidation needs more than a pile of ledgers: it needs to know who
 * holds whom and on what terms, which balances face which company, what was
 * paid for each subsidiary and when, and what any that have left were sold
 * for. None of that is in any entity's own books, and none of it can be
 * inferred from them. So it is a document, and
 * like the ledger document it is validated on the way in and says what is
 * wrong with it rather than failing somewhere further down.
 *
 * Ledger paths are carried but not read here. Reading files is the caller's
 * business, which keeps this module usable in a browser and keeps the CLI in
 * charge of what it is allowed to open.
 */

import { Money } from "../money/money.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { type DateRange, dateRange, isValidDate } from "../ledger/date.js";
import type { AverageMethod } from "../fx/average.js";
import { type EntityDefinition, GroupStructure } from "./structure.js";
import type { AcquisitionInput, NciMeasurement } from "./acquisition.js";
import type { DisposalInput } from "./disposal.js";
import type { IntercompanyDeclaration } from "./intercompany.js";

export class GroupDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupDocumentError";
  }
}

export interface ParsedGroup {
  readonly structure: GroupStructure;
  /** Where each entity's books live, by entity code. */
  readonly ledgers: ReadonlyMap<string, string>;
  readonly intercompany: readonly IntercompanyDeclaration[];
  readonly acquisitions: readonly AcquisitionInput[];
  readonly disposals: readonly DisposalInput[];
  readonly asAt: string | null;
  readonly period: DateRange | null;
  readonly averageMethod: AverageMethod | null;
  readonly equityBasis: "historical" | "closing" | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GroupDocumentError(`${what} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, what);
}

function requireDate(value: unknown, what: string): string {
  const text = requireString(value, what);
  if (!isValidDate(text)) throw new GroupDocumentError(`${what} is not a date: ${text}`);
  return text;
}

function requireMoney(value: unknown, what: string): Money {
  if (!isObject(value)) {
    throw new GroupDocumentError(`${what} must be written as {"amount": "...", "currency": "..."}`);
  }
  const amount = requireString(value["amount"], `${what}'s amount`);
  const code = requireString(value["currency"], `${what}'s currency`);
  try {
    return Money.parse(amount, lookupCurrency(code));
  } catch (error) {
    throw new GroupDocumentError(`${what} is not an amount: ${(error as Error).message}`);
  }
}

function entityFrom(value: unknown, index: number): { definition: EntityDefinition; ledger: string | undefined } {
  if (!isObject(value)) throw new GroupDocumentError(`Entity ${index} is not an object`);
  const code = requireString(value["code"], `Entity ${index}'s code`);
  const definition: EntityDefinition = {
    code,
    name: optionalString(value["name"], `Entity ${code}'s name`) ?? code,
    currency: requireString(value["currency"], `Entity ${code}'s currency`),
  };
  const parent = optionalString(value["parent"], `Entity ${code}'s parent`);
  if (parent !== undefined) definition.parent = parent;
  const holding = value["holding"];
  if (holding !== undefined && holding !== null) {
    definition.holding = typeof holding === "number" ? holding : requireString(holding, `Entity ${code}'s holding`);
  }
  const heldBy = value["heldBy"];
  if (Array.isArray(heldBy)) {
    definition.heldBy = heldBy.map((entry, position) => {
      if (!isObject(entry)) {
        throw new GroupDocumentError(`Entity ${code}'s holder ${position} is not an object`);
      }
      const interest = entry["interest"];
      return {
        holder: requireString(entry["holder"], `Entity ${code}'s holder ${position}`),
        interest:
          typeof interest === "number"
            ? interest
            : requireString(interest, `Entity ${code}'s holder ${position}'s interest`),
      };
    });
  } else if (heldBy !== undefined && heldBy !== null) {
    throw new GroupDocumentError(`Entity ${code}'s heldBy must be a list of holders`);
  }
  const controlled = value["controlled"];
  if (typeof controlled === "boolean") definition.controlled = controlled;
  else if (controlled !== undefined && controlled !== null) {
    throw new GroupDocumentError(`Entity ${code}'s controlled must be true or false`);
  }
  const acquired = value["acquired"];
  if (acquired !== undefined && acquired !== null) {
    definition.acquired = requireDate(acquired, `Entity ${code}'s acquisition date`);
  }
  const disposed = value["disposed"];
  if (disposed !== undefined && disposed !== null) {
    definition.disposed = requireDate(disposed, `Entity ${code}'s disposal date`);
  }
  const description = optionalString(value["description"], `Entity ${code}'s description`);
  if (description !== undefined) definition.description = description;

  return { definition, ledger: optionalString(value["ledger"], `Entity ${code}'s ledger path`) };
}

export function groupFromDocument(document: unknown): ParsedGroup {
  if (!isObject(document)) throw new GroupDocumentError("A group document must be an object");

  const entitiesRaw = document["entities"];
  if (!Array.isArray(entitiesRaw) || entitiesRaw.length === 0) {
    throw new GroupDocumentError("A group document needs a non-empty list of entities");
  }
  const definitions: EntityDefinition[] = [];
  const ledgers = new Map<string, string>();
  entitiesRaw.forEach((value, index) => {
    const { definition, ledger } = entityFrom(value, index);
    definitions.push(definition);
    if (ledger !== undefined) ledgers.set(definition.code, ledger);
  });

  const presentation = optionalString(document["presentation"], "The presentation currency");
  const name = optionalString(document["name"], "The group's name");
  const structure = GroupStructure.build(definitions, {
    ...(presentation === undefined ? {} : { presentation }),
    ...(name === undefined ? {} : { name }),
  });

  const intercompanyRaw = document["intercompany"];
  const intercompany: IntercompanyDeclaration[] = [];
  if (Array.isArray(intercompanyRaw)) {
    intercompanyRaw.forEach((value, index) => {
      if (!isObject(value)) {
        throw new GroupDocumentError(`Intercompany declaration ${index} is not an object`);
      }
      const declaration: IntercompanyDeclaration = {
        entity: requireString(value["entity"], `Intercompany declaration ${index}'s entity`),
        account: requireString(value["account"], `Intercompany declaration ${index}'s account`),
        counterparty: requireString(
          value["counterparty"],
          `Intercompany declaration ${index}'s counterparty`,
        ),
      };
      const link = optionalString(value["link"], `Intercompany declaration ${index}'s link`);
      if (link !== undefined) declaration.link = link;
      const note = optionalString(value["note"], `Intercompany declaration ${index}'s note`);
      if (note !== undefined) declaration.note = note;
      intercompany.push(declaration);
    });
  } else if (intercompanyRaw !== undefined && intercompanyRaw !== null) {
    throw new GroupDocumentError("intercompany must be a list of declarations");
  }

  const acquisitionsRaw = document["acquisitions"];
  const acquisitions: AcquisitionInput[] = [];
  if (Array.isArray(acquisitionsRaw)) {
    acquisitionsRaw.forEach((value, index) => {
      if (!isObject(value)) throw new GroupDocumentError(`Acquisition ${index} is not an object`);
      const entity = requireString(value["entity"], `Acquisition ${index}'s entity`);
      const input: AcquisitionInput = {
        entity,
        consideration: requireMoney(value["consideration"], `The consideration for ${entity}`),
      };
      const acquired = value["acquired"];
      if (acquired !== undefined && acquired !== null) {
        input.acquired = requireDate(acquired, `The acquisition date for ${entity}`);
      }
      const measurement = optionalString(
        value["nciMeasurement"],
        `The measurement basis for ${entity}`,
      );
      if (measurement !== undefined) {
        if (measurement !== "proportionate" && measurement !== "fair-value") {
          throw new GroupDocumentError(
            `${entity} measures its non-controlling interest "${measurement}"; ` +
              `it must be "proportionate" or "fair-value"`,
          );
        }
        input.nciMeasurement = measurement as NciMeasurement;
      }
      if (value["nciFairValue"] !== undefined && value["nciFairValue"] !== null) {
        input.nciFairValue = requireMoney(
          value["nciFairValue"],
          `The fair value of the outside stake in ${entity}`,
        );
      }
      if (value["netAssetsAtAcquisition"] !== undefined && value["netAssetsAtAcquisition"] !== null) {
        input.netAssetsAtAcquisition = requireMoney(
          value["netAssetsAtAcquisition"],
          `The net assets acquired with ${entity}`,
        );
      }
      const account = optionalString(value["investmentAccount"], `${entity}'s investment account`);
      if (account !== undefined) input.investmentAccount = account;
      acquisitions.push(input);
    });
  } else if (acquisitionsRaw !== undefined && acquisitionsRaw !== null) {
    throw new GroupDocumentError("acquisitions must be a list");
  }

  const disposalsRaw = document["disposals"];
  const disposalInputs: DisposalInput[] = [];
  if (Array.isArray(disposalsRaw)) {
    disposalsRaw.forEach((value, index) => {
      if (!isObject(value)) throw new GroupDocumentError(`Disposal ${index} is not an object`);
      const entity = requireString(value["entity"], `Disposal ${index}'s entity`);
      const input: DisposalInput = {
        entity,
        proceeds: requireMoney(value["proceeds"], `The proceeds of ${entity}`),
      };
      const disposed = value["disposed"];
      if (disposed !== undefined && disposed !== null) {
        input.disposed = requireDate(disposed, `The disposal date for ${entity}`);
      }
      if (value["netAssetsAtDisposal"] !== undefined && value["netAssetsAtDisposal"] !== null) {
        input.netAssetsAtDisposal = requireMoney(
          value["netAssetsAtDisposal"],
          `The net assets going out with ${entity}`,
        );
      }
      const gainAccount = optionalString(value["gainAccount"], `${entity}'s gain account`);
      if (gainAccount !== undefined) input.gainAccount = gainAccount;
      const lossAccount = optionalString(value["lossAccount"], `${entity}'s loss account`);
      if (lossAccount !== undefined) input.lossAccount = lossAccount;
      disposalInputs.push(input);
    });
  } else if (disposalsRaw !== undefined && disposalsRaw !== null) {
    throw new GroupDocumentError("disposals must be a list");
  }

  // A disposal declared for a company the structure says is still held would
  // consolidate its balance sheet at the reporting date and then remove it,
  // which is neither treatment. The two have to agree, and saying so here is
  // cheaper than a set of accounts that balances and is wrong.
  for (const input of disposalInputs) {
    if (input.disposed !== undefined) continue;
    if (!structure.has(input.entity)) {
      throw new GroupDocumentError(
        `${input.entity} is disposed of but is not an entity in this group`,
      );
    }
    if (structure.get(input.entity).disposed === null) {
      throw new GroupDocumentError(
        `${input.entity} has a disposal but no "disposed" date on the entity, so nothing ` +
          `tells the consolidation which part of the period it was still the group's.`,
      );
    }
  }

  const asAtRaw = document["asAt"];
  const asAt = asAtRaw === undefined || asAtRaw === null ? null : requireDate(asAtRaw, "asAt");

  let period: DateRange | null = null;
  const periodRaw = document["period"];
  if (isObject(periodRaw)) {
    period = dateRange(
      requireDate(periodRaw["from"], "The period's start"),
      requireDate(periodRaw["to"], "The period's end"),
    );
  } else if (periodRaw !== undefined && periodRaw !== null) {
    throw new GroupDocumentError('period must be written as {"from": "...", "to": "..."}');
  }

  const method = optionalString(document["averageMethod"], "averageMethod");
  if (method !== undefined && method !== "daily" && method !== "quoted") {
    throw new GroupDocumentError(`averageMethod must be "daily" or "quoted", not "${method}"`);
  }
  const basis = optionalString(document["equityBasis"], "equityBasis");
  if (basis !== undefined && basis !== "historical" && basis !== "closing") {
    throw new GroupDocumentError(`equityBasis must be "historical" or "closing", not "${basis}"`);
  }

  return Object.freeze({
    structure,
    ledgers: Object.freeze(ledgers),
    intercompany: Object.freeze(intercompany),
    acquisitions: Object.freeze(acquisitions),
    disposals: Object.freeze(disposalInputs),
    asAt,
    period,
    averageMethod: (method ?? null) as AverageMethod | null,
    equityBasis: (basis ?? null) as "historical" | "closing" | null,
  });
}

export function groupFromJson(text: string): ParsedGroup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GroupDocumentError(`The group document is not valid JSON: ${(error as Error).message}`);
  }
  return groupFromDocument(parsed);
}
