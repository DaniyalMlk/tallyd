/**
 * Who owns whom, and what that means.
 *
 * Two questions get conflated and they have different answers. *Control* is
 * what decides whether a company's books are added line by line into the
 * group's; *ownership* is what decides how much of the resulting profit
 * belongs to the group's own shareholders. A parent holding 80% of a company
 * that holds 75% of a third controls the third completely — it can direct it
 * through the company it directs — but it owns 60% of it. The remaining 40% is
 * a non-controlling interest even though no outside shareholder holds 40% of
 * anything: 20% of it sits outside the first company and 25% outside the
 * second, and the two do not add.
 *
 * So the structure is a directed acyclic graph and not a tree. A company can
 * be held from more than one place — a parent with a direct 20% and an 80%
 * subsidiary holding another 60% owns 68% of it — and the effective interest
 * is the sum over every path, which is what a topological pass computes and
 * what repeated multiplication down one chain does not.
 *
 * What this deliberately does not do is decide control by anything other than
 * arithmetic. Control is a question about the ability to direct, and a holding
 * of half or less can still confer it through an agreement this file knows
 * nothing about. A definition can therefore say so outright, and the majority
 * test is only the default.
 */

import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { type CalendarDate, date as parseDate } from "../ledger/date.js";
import { Interest } from "./interest.js";

export class GroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupError";
  }
}

export class UnknownEntityError extends GroupError {
  constructor(readonly code: string) {
    super(`No entity ${code} in this group`);
    this.name = "UnknownEntityError";
  }
}

/** One shareholding, from the inside of the group. */
export interface HoldingDefinition {
  /** The entity that holds the shares. Must itself be in the group. */
  holder: string;
  /** Its direct interest, as a percentage string, a ratio, or an `Interest`. */
  interest: string | number | Interest;
}

export interface EntityDefinition {
  code: string;
  name: string;
  /** The currency the entity keeps its own books in. */
  currency: Currency | string;
  /** Shorthand for a single holder. Mutually exclusive with `heldBy`. */
  parent?: string;
  /** The parent's direct interest. Defaults to the whole. Needs `parent`. */
  holding?: string | number | Interest;
  /** The general form: any number of holders inside the group. */
  heldBy?: readonly HoldingDefinition[];
  /**
   * Override the majority test. Set false for a company the group holds a
   * majority of but does not direct, or true for one it directs by agreement.
   */
  controlled?: boolean;
  /** The day control was obtained. Needed to split pre- from post-acquisition. */
  acquired?: string;
  description?: string;
}

export interface Holding {
  readonly holder: string;
  readonly interest: Interest;
}

export interface Entity {
  readonly code: string;
  readonly name: string;
  readonly currency: Currency;
  readonly holders: readonly Holding[];
  /** The group's interest, summed over every path from the parent company. */
  readonly effective: Interest;
  /** What is held outside the group. The complement of `effective`. */
  readonly nonControlling: Interest;
  /** Whether the books are consolidated line by line. */
  readonly controlled: boolean;
  /** True when a definition said so rather than the arithmetic. */
  readonly controlAsserted: boolean;
  /** Steps from the parent company along the shortest chain. Zero at the root. */
  readonly depth: number;
  /** The largest-interest chain from the parent company, for rendering. */
  readonly chain: readonly string[];
  readonly acquired: CalendarDate | null;
  readonly description: string;
  readonly heldEntities: readonly string[];
}

export interface GroupStructureOptions {
  /** The currency the consolidated statements are read in. */
  presentation?: Currency | string;
  /** The group's name, for headings. */
  name?: string;
}

function resolveInterest(value: string | number | Interest): Interest {
  if (value instanceof Interest) return value;
  if (typeof value === "number") return Interest.ofPercent(value);
  return Interest.parse(value);
}

export class GroupStructure {
  private readonly entities: ReadonlyMap<string, Entity>;
  readonly order: readonly string[];
  /** The company at the top: the only one nobody in the group holds. */
  readonly parent: string;
  readonly presentation: Currency;
  readonly name: string;

  private constructor(
    entities: ReadonlyMap<string, Entity>,
    order: readonly string[],
    parent: string,
    presentation: Currency,
    name: string,
  ) {
    this.entities = entities;
    this.order = order;
    this.parent = parent;
    this.presentation = presentation;
    this.name = name;
    Object.freeze(this);
  }

  static build(
    definitions: readonly EntityDefinition[],
    options: GroupStructureOptions = {},
  ): GroupStructure {
    if (definitions.length === 0) throw new GroupError("A group needs at least one entity");

    // ------------------------------------------------ codes and their holdings
    const raw = new Map<string, { definition: EntityDefinition; holders: Holding[] }>();
    for (const definition of definitions) {
      const code = definition.code.trim();
      if (code === "") throw new GroupError("An entity needs a code");
      if (raw.has(code)) throw new GroupError(`Duplicate entity ${code}`);
      if (definition.parent !== undefined && definition.heldBy !== undefined) {
        throw new GroupError(
          `Entity ${code} declares both a parent and a list of holders; use one or the other`,
        );
      }
      if (definition.parent === undefined && definition.holding !== undefined) {
        throw new GroupError(`Entity ${code} declares a holding but says nothing about who holds it`);
      }

      const declared: HoldingDefinition[] =
        definition.parent !== undefined
          ? [{ holder: definition.parent, interest: definition.holding ?? Interest.whole }]
          : [...(definition.heldBy ?? [])];

      const holders: Holding[] = [];
      const seen = new Set<string>();
      let total = Interest.none;
      for (const entry of declared) {
        const holder = entry.holder.trim();
        if (holder === code) throw new GroupError(`Entity ${code} cannot hold itself`);
        if (seen.has(holder)) {
          throw new GroupError(`Entity ${code} lists ${holder} as a holder twice`);
        }
        seen.add(holder);
        const interest = resolveInterest(entry.interest);
        if (interest.isZero) {
          throw new GroupError(
            `${holder} is listed as holding nothing of ${code}; leave it out instead`,
          );
        }
        try {
          total = total.plus(interest);
        } catch {
          throw new GroupError(
            `The declared holdings in ${code} come to more than the whole company`,
          );
        }
        holders.push({ holder, interest });
      }
      raw.set(code, { definition, holders });
    }

    for (const [code, { holders }] of raw) {
      for (const holding of holders) {
        if (!raw.has(holding.holder)) {
          throw new GroupError(`Entity ${code} is held by ${holding.holder}, which is not in the group`);
        }
      }
    }

    // ------------------------------------------------------------ the top
    const roots = [...raw.entries()].filter(([, v]) => v.holders.length === 0).map(([k]) => k);
    if (roots.length === 0) {
      throw new GroupError(
        "Every entity is held by another, so there is no parent company: the holdings form a cycle",
      );
    }
    if (roots.length > 1) {
      throw new GroupError(
        `A group has one parent company, and ${roots.length} entities are held by nobody: ${roots.join(", ")}`,
      );
    }
    const parent = roots[0] as string;

    // ------------------------------------------- topological order, or a cycle
    const dependents = new Map<string, string[]>();
    const remaining = new Map<string, number>();
    for (const [code, { holders }] of raw) {
      remaining.set(code, holders.length);
      for (const holding of holders) {
        const list = dependents.get(holding.holder);
        if (list === undefined) dependents.set(holding.holder, [code]);
        else list.push(code);
      }
    }
    const order: string[] = [];
    const queue = [parent];
    while (queue.length > 0) {
      const code = queue.shift() as string;
      order.push(code);
      for (const child of dependents.get(code) ?? []) {
        const left = (remaining.get(child) as number) - 1;
        remaining.set(child, left);
        if (left === 0) queue.push(child);
      }
    }
    if (order.length !== raw.size) {
      const stuck = [...raw.keys()].filter((c) => !order.includes(c));
      throw new GroupError(
        `These entities hold each other in a cycle, directly or through others: ${stuck.sort().join(", ")}`,
      );
    }

    // -------------------------------- effective interest, control, depth, chain
    const effective = new Map<string, Interest>([[parent, Interest.whole]]);
    const controlled = new Map<string, boolean>([[parent, true]]);
    const depth = new Map<string, number>([[parent, 0]]);
    const chain = new Map<string, readonly string[]>([[parent, Object.freeze([parent])]]);

    for (const code of order) {
      if (code === parent) continue;
      const { definition, holders } = raw.get(code) as {
        definition: EntityDefinition;
        holders: Holding[];
      };

      // Summing over every path is what makes a diamond come out right: a
      // direct 20% alongside 60% held through an 80% subsidiary is 68%, and
      // walking one chain would report either 20% or 48%.
      let sum = Interest.none;
      let controlling = Interest.none;
      for (const holding of holders) {
        sum = sum.plus(holding.interest.times(effective.get(holding.holder) as Interest));
        if (controlled.get(holding.holder) === true) controlling = controlling.plus(holding.interest);
      }
      effective.set(code, sum);
      const asserted = definition.controlled !== undefined;
      controlled.set(code, asserted ? (definition.controlled as boolean) : controlling.isControlling);

      const reachable = holders.filter((h) => depth.has(h.holder));
      const shortest = Math.min(...reachable.map((h) => (depth.get(h.holder) as number) + 1));
      depth.set(code, shortest);
      const principal = [...holders].sort((a, b) => {
        const byInterest = b.interest.compare(a.interest);
        return byInterest !== 0 ? byInterest : a.holder.localeCompare(b.holder);
      })[0] as Holding;
      chain.set(
        code,
        Object.freeze([...(chain.get(principal.holder) as readonly string[]), code]),
      );
    }

    const held = new Map<string, string[]>();
    for (const [code, { holders }] of raw) {
      for (const holding of holders) {
        const list = held.get(holding.holder);
        if (list === undefined) held.set(holding.holder, [code]);
        else list.push(code);
      }
    }

    const entities = new Map<string, Entity>();
    for (const code of order) {
      const { definition, holders } = raw.get(code) as {
        definition: EntityDefinition;
        holders: Holding[];
      };
      const share = effective.get(code) as Interest;
      entities.set(
        code,
        Object.freeze({
          code,
          name: definition.name,
          currency:
            typeof definition.currency === "string"
              ? lookupCurrency(definition.currency)
              : definition.currency,
          holders: Object.freeze([...holders]),
          effective: share,
          nonControlling: share.complement(),
          controlled: controlled.get(code) as boolean,
          controlAsserted: definition.controlled !== undefined,
          depth: depth.get(code) as number,
          chain: chain.get(code) as readonly string[],
          acquired: definition.acquired === undefined ? null : parseDate(definition.acquired),
          description: definition.description ?? "",
          heldEntities: Object.freeze((held.get(code) ?? []).sort()),
        }),
      );
    }

    const presentation =
      options.presentation === undefined
        ? (entities.get(parent) as Entity).currency
        : typeof options.presentation === "string"
          ? lookupCurrency(options.presentation)
          : options.presentation;

    return new GroupStructure(
      entities,
      Object.freeze(order),
      parent,
      presentation,
      options.name ?? (entities.get(parent) as Entity).name,
    );
  }

  // ------------------------------------------------------------------ lookup

  get size(): number {
    return this.entities.size;
  }

  has(code: string): boolean {
    return this.entities.has(code);
  }

  get(code: string): Entity {
    const entity = this.entities.get(code);
    if (entity === undefined) throw new UnknownEntityError(code);
    return entity;
  }

  find(code: string): Entity | undefined {
    return this.entities.get(code);
  }

  /** Every entity, in an order where a holder always precedes what it holds. */
  list(): readonly Entity[] {
    return this.order.map((code) => this.get(code));
  }

  /** The parent company. */
  parentEntity(): Entity {
    return this.get(this.parent);
  }

  /** Everything below the parent, controlled or not. */
  subsidiaries(): readonly Entity[] {
    return this.list().filter((e) => e.code !== this.parent);
  }

  /**
   * The entities whose books go into the consolidation line by line: the
   * parent and everything it controls.
   */
  consolidated(): readonly Entity[] {
    return this.list().filter((e) => e.controlled);
  }

  /**
   * Held but not controlled. These do not consolidate; a real set of accounts
   * would carry them at cost plus the group's share of post-acquisition
   * reserves, which is a separate piece of machinery.
   */
  associates(): readonly Entity[] {
    return this.list().filter((e) => !e.controlled);
  }

  /** Entities with a non-controlling interest in them. */
  withNonControllingInterest(): readonly Entity[] {
    return this.consolidated().filter((e) => !e.nonControlling.isZero);
  }

  effectiveInterest(code: string): Interest {
    return this.get(code).effective;
  }

  nonControllingInterest(code: string): Interest {
    return this.get(code).nonControlling;
  }

  isControlled(code: string): boolean {
    return this.get(code).controlled;
  }

  /** The currencies the group's books are kept in, deduplicated. */
  currencies(): readonly string[] {
    return [...new Set(this.list().map((e) => e.currency.code))].sort();
  }

  /** True when every entity keeps its books in the presentation currency. */
  get isSingleCurrency(): boolean {
    return this.list().every((e) => e.currency.code === this.presentation.code);
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`${this.name} — consolidated in ${this.presentation.code}`);
    const width = Math.max(...this.list().map((e) => e.name.length + e.depth * 2)) + 2;
    for (const entity of this.list()) {
      const label = `${"  ".repeat(entity.depth)}${entity.name}`;
      const share =
        entity.code === this.parent ? "" : `${entity.effective.toPercentString(4)} owned`;
      const flag = entity.controlled
        ? entity.nonControlling.isZero
          ? ""
          : `, ${entity.nonControlling.toPercentString(4)} outside`
        : ", not controlled";
      lines.push(
        `${entity.code.padEnd(8)}${label.padEnd(width)}${entity.currency.code.padEnd(5)}${share}${flag}`,
      );
    }
    return lines.join("\n");
  }
}
