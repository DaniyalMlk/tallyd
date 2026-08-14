/**
 * The chart of accounts: an immutable, validated account tree.
 *
 * Validation happens once, at construction. Downstream code that holds a
 * `ChartOfAccounts` can assume every parent exists, no cycle is present, child
 * types agree with their parent, and any account it is handed is postable —
 * because the alternative would have thrown before the object existed.
 */

import type { Currency } from "../money/currency.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { type AccountType, type NormalBalance, isAccountType, normalBalanceOf } from "./types.js";

export interface AccountDefinition {
  /** Stable identifier, conventionally numeric ("1000") but any string works. */
  code: string;
  name: string;
  type: AccountType;
  /** Code of the parent account. Omit for a root. */
  parent?: string;
  /** Currency for this account. Defaults to the chart's currency. */
  currency?: Currency | string;
  /**
   * A placeholder groups children but cannot itself be posted to — the usual
   * treatment for "Current Assets" as opposed to "Barclays Current Account".
   */
  placeholder?: boolean;
  /** A closed account keeps its history but rejects new postings. */
  closed?: boolean;
  description?: string;
}

export interface Account {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parent: string | null;
  readonly currency: Currency;
  readonly placeholder: boolean;
  readonly closed: boolean;
  readonly description: string;
  readonly normalBalance: NormalBalance;
  /** Depth from the root; roots are 0. */
  readonly depth: number;
  /** Colon-joined names from the root, e.g. "Assets:Current:Barclays". */
  readonly path: string;
  readonly children: readonly string[];
}

export class ChartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartError";
  }
}

export class UnknownAccountError extends ChartError {
  constructor(readonly code: string) {
    super(`No such account: ${code}`);
    this.name = "UnknownAccountError";
  }
}

export class AccountNotPostableError extends ChartError {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(`Account ${code} is not postable: ${reason}`);
    this.name = "AccountNotPostableError";
  }
}

export class ChartOfAccounts {
  private readonly accounts: ReadonlyMap<string, Account>;
  readonly defaultCurrency: Currency;
  readonly roots: readonly string[];

  private constructor(
    accounts: ReadonlyMap<string, Account>,
    defaultCurrency: Currency,
    roots: readonly string[],
  ) {
    this.accounts = accounts;
    this.defaultCurrency = defaultCurrency;
    this.roots = Object.freeze([...roots]);
    Object.freeze(this);
  }

  static build(
    definitions: readonly AccountDefinition[],
    options: { currency?: Currency | string } = {},
  ): ChartOfAccounts {
    const defaultCurrency =
      typeof options.currency === "string"
        ? lookupCurrency(options.currency)
        : (options.currency ?? lookupCurrency("GBP"));

    // Pass 1 — shape and uniqueness.
    const byCode = new Map<string, AccountDefinition>();
    for (const def of definitions) {
      if (def.code.trim() === "") throw new ChartError("Account code must not be blank");
      if (def.name.trim() === "") {
        throw new ChartError(`Account ${def.code} must have a name`);
      }
      if (!isAccountType(def.type)) {
        throw new ChartError(`Account ${def.code} has unknown type: ${String(def.type)}`);
      }
      if (byCode.has(def.code)) throw new ChartError(`Duplicate account code: ${def.code}`);
      byCode.set(def.code, def);
    }

    // Pass 2 — parent links, cycles and type agreement.
    const childrenOf = new Map<string, string[]>();
    for (const def of definitions) childrenOf.set(def.code, []);

    for (const def of definitions) {
      if (def.parent === undefined) continue;
      const parent = byCode.get(def.parent);
      if (parent === undefined) {
        throw new ChartError(`Account ${def.code} names a missing parent: ${def.parent}`);
      }
      if (parent.type !== def.type) {
        throw new ChartError(
          `Account ${def.code} is ${def.type} but its parent ${parent.code} is ${parent.type}`,
        );
      }
      (childrenOf.get(def.parent) as string[]).push(def.code);
    }

    for (const def of definitions) {
      const seen = new Set<string>([def.code]);
      let cursor = def.parent;
      while (cursor !== undefined) {
        if (seen.has(cursor)) {
          throw new ChartError(`Account hierarchy contains a cycle at ${cursor}`);
        }
        seen.add(cursor);
        cursor = byCode.get(cursor)?.parent;
      }
    }

    // Pass 3 — materialise, computing depth and path top-down.
    const accounts = new Map<string, Account>();
    const roots = definitions.filter((d) => d.parent === undefined).map((d) => d.code);

    const visit = (code: string, depth: number, prefix: string): void => {
      const def = byCode.get(code) as AccountDefinition;
      const children = (childrenOf.get(code) as string[]).slice().sort();
      const path = prefix === "" ? def.name : `${prefix}:${def.name}`;
      const accountCurrency =
        def.currency === undefined
          ? defaultCurrency
          : typeof def.currency === "string"
            ? lookupCurrency(def.currency)
            : def.currency;

      accounts.set(
        code,
        Object.freeze({
          code,
          name: def.name,
          type: def.type,
          parent: def.parent ?? null,
          currency: accountCurrency,
          placeholder: def.placeholder ?? children.length > 0,
          closed: def.closed ?? false,
          description: def.description ?? "",
          normalBalance: normalBalanceOf(def.type),
          depth,
          path,
          children: Object.freeze(children),
        }),
      );

      for (const child of children) visit(child, depth + 1, path);
    };

    for (const root of roots) visit(root, 0, "");

    return new ChartOfAccounts(accounts, defaultCurrency, roots.slice().sort());
  }

  // ------------------------------------------------------------------ lookups

  has(code: string): boolean {
    return this.accounts.has(code);
  }

  /** Look up an account, throwing if it does not exist. */
  get(code: string): Account {
    const account = this.accounts.get(code);
    if (account === undefined) throw new UnknownAccountError(code);
    return account;
  }

  find(code: string): Account | undefined {
    return this.accounts.get(code);
  }

  get size(): number {
    return this.accounts.size;
  }

  /** Every account, in depth-first order from each sorted root. */
  list(): readonly Account[] {
    const out: Account[] = [];
    const walk = (code: string): void => {
      const account = this.get(code);
      out.push(account);
      for (const child of account.children) walk(child);
    };
    for (const root of this.roots) walk(root);
    return out;
  }

  ofType(type: AccountType): readonly Account[] {
    return this.list().filter((a) => a.type === type);
  }

  /** Accounts with no children — the ones that normally receive postings. */
  leaves(): readonly Account[] {
    return this.list().filter((a) => a.children.length === 0);
  }

  children(code: string): readonly Account[] {
    return this.get(code).children.map((c) => this.get(c));
  }

  /** All descendants of `code`, excluding `code` itself. */
  descendants(code: string): readonly Account[] {
    const out: Account[] = [];
    const walk = (current: string): void => {
      for (const child of this.get(current).children) {
        out.push(this.get(child));
        walk(child);
      }
    };
    walk(code);
    return out;
  }

  /** `code` and all its descendants — the set a rolled-up balance covers. */
  subtree(code: string): readonly Account[] {
    return [this.get(code), ...this.descendants(code)];
  }

  /** Ancestors from the immediate parent up to the root. */
  ancestors(code: string): readonly Account[] {
    const out: Account[] = [];
    let cursor = this.get(code).parent;
    while (cursor !== null) {
      const account = this.get(cursor);
      out.push(account);
      cursor = account.parent;
    }
    return out;
  }

  isDescendantOf(code: string, ancestor: string): boolean {
    return this.ancestors(code).some((a) => a.code === ancestor);
  }

  /** Resolve by colon-delimited path, e.g. "Assets:Current:Barclays". */
  findByPath(path: string): Account | undefined {
    return this.list().find((a) => a.path === path);
  }

  // ----------------------------------------------------------------- postings

  /**
   * Assert that an account can receive a posting, returning it. Placeholders
   * and closed accounts are rejected here rather than at posting time so the
   * error names the account and the reason.
   */
  assertPostable(code: string): Account {
    const account = this.get(code);
    if (account.placeholder) {
      throw new AccountNotPostableError(code, "it is a placeholder for its children");
    }
    if (account.closed) throw new AccountNotPostableError(code, "it is closed");
    return account;
  }

  isPostable(code: string): boolean {
    const account = this.find(code);
    return account !== undefined && !account.placeholder && !account.closed;
  }

  // ------------------------------------------------------------------ derived

  /** A new chart with extra accounts, re-validated from scratch. */
  extend(definitions: readonly AccountDefinition[]): ChartOfAccounts {
    return ChartOfAccounts.build([...this.toDefinitions(), ...definitions], {
      currency: this.defaultCurrency,
    });
  }

  toDefinitions(): AccountDefinition[] {
    return this.list().map((a) => {
      const def: AccountDefinition = {
        code: a.code,
        name: a.name,
        type: a.type,
        currency: a.currency,
        placeholder: a.placeholder,
        closed: a.closed,
        description: a.description,
      };
      if (a.parent !== null) def.parent = a.parent;
      return def;
    });
  }

  /** Indented text rendering, handy in the CLI and in test failure output. */
  render(): string {
    return this.list()
      .map((a) => `${"  ".repeat(a.depth)}${a.code}  ${a.name}${a.placeholder ? " ·" : ""}`)
      .join("\n");
  }
}
