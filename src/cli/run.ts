/**
 * The commands.
 *
 * `run` is a pure function of its arguments and an environment: it takes the
 * argv, a filesystem reader and a clock, and returns text plus an exit code.
 * Nothing here touches `process` or `console`, which is what makes the whole
 * CLI testable end to end without spawning anything.
 *
 * Exit codes carry meaning. Zero is success; 1 is a usage or input problem;
 * and 2 is reserved for work that ran to completion and came out wrong — a
 * reconciliation that does not balance, a trial balance that does not agree.
 * A CI job that treats an unbalanced reconciliation as a pass is worse than no
 * CI job at all.
 */

import { Money } from "../money/money.js";
import { currency as lookupCurrency } from "../money/currency.js";
import { date, dateRange } from "../ledger/date.js";
import type { CalendarDate } from "../ledger/date.js";
import type { Ledger } from "../ledger/ledger.js";
import { ledgerFromJson, ledgerToJson } from "../ledger/serialise.js";
import { renderTrialBalance, trialBalance } from "../ledger/trialBalance.js";
import { importStatement } from "../statement/index.js";
import { incomeStatement, renderIncomeStatement } from "../reports/incomeStatement.js";
import { balanceSheet, renderBalanceSheet } from "../reports/balanceSheet.js";
import { ageing, renderAgeing } from "../reports/ageing.js";
import { bankView } from "../reconcile/bankView.js";
import { reconcile, significantReasons } from "../reconcile/matcher.js";
import {
  reconciliationBridge,
  renderReconciliationBridge,
  statementClosingBalance,
} from "../reconcile/bridge.js";
import { measureAccuracy } from "../reconcile/accuracy.js";
import { MatchMemory, MemoryDocumentError, renderMemory } from "../reconcile/memory.js";
import { DecisionDocumentError, decisionsFor } from "../reconcile/decisions.js";
import {
  generateBooks,
  statementCsv,
  type GeneratorOptions,
} from "../demo/generator.js";
import { dashboardData } from "../dashboard/model.js";
import { renderDashboard } from "../dashboard/render.js";
import {
  applyProposals,
  parseRules,
  PostingRuleError,
  proposeEntries,
  renderProposals,
  linesNeedingEntries,
  standardRules,
  summariseProposals,
  type ProposalOptions,
} from "../reconcile/posting.js";
import type { BookLine } from "../reconcile/bankView.js";
import type { ReconciliationResult } from "../reconcile/matcher.js";
import {
  ArgumentError,
  booleanFlag,
  parseArgs,
  renderFlags,
  requiredFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "./args.js";

export interface CliEnvironment {
  /** Read a file as UTF-8, or throw. */
  readonly readFile: (path: string) => string;
  /** Today, for commands that default their as-at date. */
  readonly today: () => CalendarDate;
  /**
   * Write a file, for the commands that produce an artefact. Absent in
   * read-only environments, in which case those commands say so rather than
   * failing halfway through.
   */
  readonly writeFile?: (path: string, contents: string) => void;
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const COMMON: FlagSpecs = {
  ledger: { kind: "string", short: "l", describe: "Ledger document (JSON)", placeholder: "file" },
  json: { kind: "boolean", describe: "Emit JSON instead of text" },
};

const COMMANDS: Record<string, { describe: string; flags: FlagSpecs }> = {
  report: {
    describe: "Trial balance, income statement and balance sheet",
    flags: {
      ...COMMON,
      "as-at": { kind: "string", describe: "Balance sheet date (default: today)", placeholder: "date" },
      from: { kind: "string", describe: "Start of the income statement period", placeholder: "date" },
      to: { kind: "string", describe: "End of the income statement period", placeholder: "date" },
      compare: { kind: "string", describe: "Comparative period, as from:to", placeholder: "a:b" },
    },
  },
  ageing: {
    describe: "Outstanding items on a control account, bucketed by age",
    flags: {
      ...COMMON,
      account: { kind: "string", short: "a", describe: "Control account code", placeholder: "code" },
      "as-at": { kind: "string", describe: "Ageing date (default: today)", placeholder: "date" },
      buckets: { kind: "string", describe: "Bucket boundaries in days (default 30,60,90)", placeholder: "n,n,n" },
    },
  },
  reconcile: {
    describe: "Match a bank statement against the ledger and print the review queue",
    flags: {
      ...COMMON,
      statement: { kind: "string", short: "s", describe: "Bank statement (CSV or OFX)", placeholder: "file" },
      account: { kind: "string", short: "a", describe: "Bank account code", placeholder: "code" },
      currency: { kind: "string", describe: "Statement currency (default: the chart's)", placeholder: "code" },
      "date-window": { kind: "string", describe: "Days either side a pair may differ", placeholder: "days" },
      "no-groups": { kind: "boolean", describe: "Disable one-to-many matching" },
      memory: { kind: "string", short: "m", describe: "Confirmed counterparties (JSON)", placeholder: "file" },
    },
  },
  import: {
    describe: "Show what the statement reader made of a file, without matching",
    flags: {
      statement: { kind: "string", short: "s", describe: "Bank statement (CSV or OFX)", placeholder: "file" },
      currency: { kind: "string", describe: "Statement currency (default GBP)", placeholder: "code" },
      json: { kind: "boolean", describe: "Emit JSON instead of text" },
    },
  },
  accounts: {
    describe: "Render the chart of accounts",
    flags: { ...COMMON },
  },
  generate: {
    describe: "Write a synthetic ledger and the bank statement that goes with it",
    flags: {
      out: { kind: "string", short: "o", describe: "Directory to write into", placeholder: "dir" },
      seed: { kind: "string", describe: "Same seed, same books (default 1)", placeholder: "n" },
      months: { kind: "string", describe: "Months to generate (default 3)", placeholder: "n" },
      invoices: { kind: "string", describe: "Invoices a month (default 12)", placeholder: "n" },
      start: { kind: "string", describe: "First day (default 2026-01-01)", placeholder: "date" },
      currency: { kind: "string", describe: "Currency (default GBP)", placeholder: "code" },
      truth: { kind: "boolean", describe: "Also write the ground-truth links as JSON" },
      json: { kind: "boolean", describe: "Emit JSON instead of text" },
    },
  },
  bench: {
    describe: "Time the matcher over generated books of increasing size",
    flags: {
      seed: { kind: "string", describe: "Same seed, same books (default 1)", placeholder: "n" },
      sizes: {
        kind: "string",
        describe: "Sizes as months:invoices (default 1:10,3:12,6:15,12:15)",
        placeholder: "m:i,...",
      },
      repeat: { kind: "string", describe: "Runs per size, fastest wins (default 1)", placeholder: "n" },
      json: { kind: "boolean", describe: "Emit JSON instead of text" },
    },
  },
  dashboard: {
    describe: "Write a self-contained HTML reconciliation dashboard",
    flags: {
      ledger: { kind: "string", short: "l", describe: "Ledger document (JSON)", placeholder: "file" },
      statement: { kind: "string", short: "s", describe: "Bank statement (CSV or OFX)", placeholder: "file" },
      account: { kind: "string", short: "a", describe: "Bank account code", placeholder: "code" },
      out: { kind: "string", short: "o", describe: "Where to write the HTML", placeholder: "file" },
      currency: { kind: "string", describe: "Statement currency (default: the chart's)", placeholder: "code" },
      "date-window": { kind: "string", describe: "Days either side a pair may differ", placeholder: "days" },
      "no-groups": { kind: "boolean", describe: "Disable one-to-many matching" },
      memory: { kind: "string", short: "m", describe: "Confirmed counterparties (JSON)", placeholder: "file" },
    },
  },
  post: {
    describe: "Propose the journal entries a reconciled statement implies",
    flags: {
      ledger: { kind: "string", short: "l", describe: "Ledger document (JSON)", placeholder: "file" },
      statement: { kind: "string", short: "s", describe: "Bank statement (CSV or OFX)", placeholder: "file" },
      account: { kind: "string", short: "a", describe: "Bank account code", placeholder: "code" },
      decisions: { kind: "string", short: "d", describe: "Reviewed decisions from the dashboard (JSON)", placeholder: "file" },
      rules: { kind: "string", short: "r", describe: "Classification rules (JSON); the built-in set is used otherwise", placeholder: "file" },
      suspense: { kind: "string", describe: "Existing account for lines no rule matched", placeholder: "code" },
      out: { kind: "string", short: "o", describe: "Write the ledger with the entries applied", placeholder: "file" },
      currency: { kind: "string", describe: "Statement currency (default: the chart's)", placeholder: "code" },
      "date-window": { kind: "string", describe: "Days either side a pair may differ", placeholder: "days" },
      "no-groups": { kind: "boolean", describe: "Disable one-to-many matching" },
      memory: { kind: "string", short: "m", describe: "Confirmed counterparties (JSON)", placeholder: "file" },
      strict: { kind: "boolean", describe: "Exit 2 when any line could not be classified" },
      json: { kind: "boolean", describe: "Emit JSON instead of text" },
    },
  },
  learn: {
    describe: "Fold reviewed decisions into the counterparty memory",
    flags: {
      memory: { kind: "string", short: "m", describe: "Memory file, created if absent", placeholder: "file" },
      decisions: { kind: "string", short: "d", describe: "Reviewed decisions (JSON)", placeholder: "file" },
      show: { kind: "boolean", describe: "Print what is remembered and write nothing" },
      json: { kind: "boolean", describe: "Emit JSON instead of text" },
    },
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = [
    "tallyd — double-entry ledger and bank reconciliation",
    "",
    "Usage: tallyd <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width + 2)}${command.describe}`),
    "",
    "Run 'tallyd <command> --help' for the options of a command.",
    "",
    "Exit codes: 0 success, 1 bad input, 2 the books do not agree.",
  ];
  return lines.join("\n");
}

function commandHelp(name: string): string {
  const command = COMMANDS[name] as { describe: string; flags: FlagSpecs };
  return [`tallyd ${name} — ${command.describe}`, "", "Options:", renderFlags(command.flags)].join("\n");
}

function loadLedger(environment: CliEnvironment, path: string): Ledger {
  return ledgerFromJson(environment.readFile(path));
}

function parseBoundaries(text: string | undefined): readonly number[] | undefined {
  if (text === undefined) return undefined;
  const values = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const value = Number(part);
      if (!Number.isInteger(value) || value <= 0) {
        throw new ArgumentError(`--buckets wants positive whole numbers, got "${part}"`);
      }
      return value;
    });
  if (values.length === 0) throw new ArgumentError("--buckets needs at least one boundary");
  return values;
}

/**
 * The memory named by `--memory`, or an empty one.
 *
 * A missing file is not an error the first time round: a reviewer who has not
 * confirmed anything yet has an empty memory, and asking them to create a file
 * full of nothing before they can reconcile would be silly.
 */
function loadMemory(environment: CliEnvironment, path: string | undefined): MatchMemory {
  if (path === undefined) return MatchMemory.empty();
  try {
    return MatchMemory.fromJson(environment.readFile(path));
  } catch (error) {
    if (error instanceof MemoryDocumentError) throw error;
    return MatchMemory.empty();
  }
}

/**
 * Resolve the account to reconcile against.
 *
 * A grouping account is refused rather than reconciled. It exists in the chart
 * and nothing has ever been posted to it, so reconciling it "succeeds": no
 * ledger movements, no matches, and a bridge that is out by the entire
 * statement while reporting nothing wrong. That is the worst kind of wrong
 * answer, because it looks like an answer.
 */
function bankAccountFor(ledger: Ledger, requested: string | undefined): string {
  if (requested !== undefined) {
    const chart = ledger.chart;
    if (chart !== undefined) {
      if (!chart.has(requested)) {
        throw new ArgumentError(`No account ${requested} in the chart`);
      }
      if (!chart.isPostable(requested)) {
        const account = chart.get(requested);
        const children = chart.children(requested).map((child) => child.code);
        const advice =
          children.length > 0 ? `; reconcile one of ${children.join(", ")}` : "";
        throw new ArgumentError(
          `Account ${requested} (${account.name}) cannot be posted to, so there is nothing to ` +
            `reconcile against it${advice}`,
        );
      }
    }
    return requested;
  }
  // "1110" is the bank account in the standard chart; fall back to the first
  // posted asset account so an unusual chart still works without a flag.
  if (ledger.chart?.has("1110") === true) return "1110";
  const asset = ledger.activeAccounts().find((code) => ledger.chart?.find(code)?.type === "asset");
  if (asset === undefined) {
    throw new ArgumentError("Could not guess the bank account; pass --account");
  }
  return asset;
}

// ------------------------------------------------------------------ commands

function reportCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["report"] as { flags: FlagSpecs }).flags);
  const ledger = loadLedger(environment, requiredFlag(parsed, "ledger"));

  const asAtText = stringFlag(parsed, "as-at");
  const asAt = asAtText === undefined ? environment.today() : date(asAtText);
  const from = stringFlag(parsed, "from");
  const to = stringFlag(parsed, "to");
  const period = dateRange(from ?? "0001-01-01", to ?? asAt);

  const compare = stringFlag(parsed, "compare");
  let comparative: ReturnType<typeof dateRange> | undefined;
  if (compare !== undefined) {
    const parts = compare.split(":");
    if (parts.length !== 2) throw new ArgumentError("--compare wants from:to");
    comparative = dateRange(parts[0] as string, parts[1] as string);
  }

  const balances = trialBalance(ledger, { asAt });
  const profit = incomeStatement(
    ledger,
    period,
    comparative === undefined ? {} : { comparative },
  );
  const sheet = balanceSheet(ledger, asAt);
  const agrees = balances.balanced && sheet.balanced;

  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify(
        {
          asAt,
          period: { from: period.from, to: period.to },
          trialBalance: {
            balanced: balances.balanced,
            totalDebit: balances.totalDebit.toDecimalString(),
            totalCredit: balances.totalCredit.toDecimalString(),
          },
          incomeStatement: {
            income: profit.income.total.toDecimalString(),
            expenses: profit.expenses.total.toDecimalString(),
            netResult: profit.netResult.toDecimalString(),
          },
          balanceSheet: {
            assets: sheet.assets.total.toDecimalString(),
            liabilities: sheet.liabilities.total.toDecimalString(),
            equity: sheet.equity.total.toDecimalString(),
            balanced: sheet.balanced,
          },
        },
        null,
        2,
      ),
      stderr: "",
      code: agrees ? 0 : 2,
    };
  }

  return {
    stdout: [
      renderTrialBalance(balances),
      "",
      renderIncomeStatement(profit),
      "",
      renderBalanceSheet(sheet),
    ].join("\n"),
    stderr: agrees ? "" : "The books do not agree; see the differences above.\n",
    code: agrees ? 0 : 2,
  };
}

function ageingCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["ageing"] as { flags: FlagSpecs }).flags);
  const ledger = loadLedger(environment, requiredFlag(parsed, "ledger"));
  const account = requiredFlag(parsed, "account");
  const asAtText = stringFlag(parsed, "as-at");
  const asAt = asAtText === undefined ? environment.today() : date(asAtText);
  const boundaries = parseBoundaries(stringFlag(parsed, "buckets"));

  const report = ageing(ledger, account, asAt, boundaries === undefined ? {} : { boundaries });

  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify(
        {
          account: report.account,
          asAt: report.asAt,
          total: report.total.toDecimalString(),
          buckets: report.buckets.map((bucket) => ({
            label: bucket.label,
            total: bucket.total.toDecimalString(),
            count: bucket.items.length,
          })),
          items: report.items.map((item) => ({
            reference: item.reference,
            raised: item.raised,
            days: item.daysOutstanding,
            outstanding: item.outstanding.toDecimalString(),
          })),
        },
        null,
        2,
      ),
      stderr: "",
      code: 0,
    };
  }

  return { stdout: renderAgeing(report), stderr: "", code: 0 };
}

/**
 * Everything three commands need: the ledger, the statement, and the match
 * between them.
 *
 * `reconcile`, `dashboard` and `post` all start the same way — load, import,
 * project the account into bank direction, match — and differ only in what
 * they do with the answer. Written once, so a flag added to one is a flag the
 * others honour rather than a flag the others silently ignore.
 */
interface ReconciliationRun {
  readonly ledger: Ledger;
  readonly account: string;
  readonly currencyCode: string;
  readonly imported: ReturnType<typeof importStatement>;
  readonly books: readonly BookLine[];
  readonly result: ReconciliationResult;
  readonly bankClosingBalance: Money;
  readonly bookClosingBalance: Money;
  /** What the matcher was told to remember, decisions folded in. */
  readonly memory: MatchMemory;
}

function reconciliationFor(
  environment: CliEnvironment,
  parsed: ParsedArgs,
  extraDecisions: readonly { statementDescription: string; bookDescription: string; accepted: boolean; on: CalendarDate }[] = [],
): ReconciliationRun {
  const ledger = loadLedger(environment, requiredFlag(parsed, "ledger"));
  const account = bankAccountFor(ledger, stringFlag(parsed, "account"));
  const raw = environment.readFile(requiredFlag(parsed, "statement"));

  const currencyCode =
    stringFlag(parsed, "currency") ??
    ledger.chart?.find(account)?.currency.code ??
    ledger.currenciesUsed()[0] ??
    "GBP";
  const imported = importStatement(raw, { currency: lookupCurrency(currencyCode), idPrefix: "BANK" });

  const options: Parameters<typeof reconcile>[2] = {};
  const windowText = stringFlag(parsed, "date-window");
  if (windowText !== undefined) {
    const days = Number(windowText);
    if (!Number.isInteger(days) || days < 0) {
      throw new ArgumentError(`--date-window wants a whole number of days, got "${windowText}"`);
    }
    options.dateWindowDays = days;
  }
  if (booleanFlag(parsed, "no-groups")) options.groupMatching = false;

  const memory = loadMemory(environment, stringFlag(parsed, "memory")).learnAll(extraDecisions);
  if (memory.size > 0) options.memory = memory;

  const books = bankView(ledger, account, { currency: currencyCode });
  const result = reconcile(books, imported.lines, options);

  return {
    ledger,
    account,
    currencyCode,
    imported,
    books,
    result,
    memory,
    bankClosingBalance: statementClosingBalance(imported.lines, Money.zero(currencyCode)),
    bookClosingBalance: books.reduce(
      (total, line) => total.plus(line.amount),
      Money.zero(currencyCode),
    ),
  };
}

function reconcileCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["reconcile"] as { flags: FlagSpecs }).flags);
  const run = reconciliationFor(environment, parsed);
  const { account, imported, result, memory } = run;

  const bridge = reconciliationBridge(result, {
    bankClosingBalance: run.bankClosingBalance,
    bookClosingBalance: run.bookClosingBalance,
  });

  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify(
        {
          account,
          format: imported.format,
          statementLines: result.stats.statementLines,
          bookLines: result.stats.bookLines,
          matched: result.matched.map((match) => ({
            kind: match.kind,
            score: Number(match.scored.score.toFixed(4)),
            confidence: match.scored.confidence,
            book: match.book.map((line) => line.id),
            statement: match.statement.map((line) => line.id),
          })),
          suggested: result.suggested.map((match) => ({
            kind: match.kind,
            score: Number(match.scored.score.toFixed(4)),
            reasons: significantReasons(match),
            book: match.book.map((line) => line.id),
            statement: match.statement.map((line) => line.id),
          })),
          unmatchedBook: result.unmatchedBook.map((line) => line.id),
          unmatchedStatement: result.unmatchedStatement.map((line) => line.id),
          bridge: {
            bankClosingBalance: bridge.bankClosingBalance.toDecimalString(),
            bookClosingBalance: bridge.bookClosingBalance.toDecimalString(),
            adjustedBankBalance: bridge.adjustedBankBalance.toDecimalString(),
            adjustedBookBalance: bridge.adjustedBookBalance.toDecimalString(),
            difference: bridge.difference.toDecimalString(),
            reconciled: bridge.reconciled,
          },
        },
        null,
        2,
      ),
      stderr: "",
      code: bridge.reconciled ? 0 : 2,
    };
  }

  const out: string[] = [];
  out.push(`Reconciling ${account} against ${result.stats.statementLines} statement lines`);
  if (memory.size > 0) {
    out.push(`  ${memory.size} remembered ${memory.size === 1 ? "counterparty" : "counterparties"} in play`);
  }
  out.push(
    `  ${result.matched.length} matched, ${result.suggested.length} to review, ` +
      `${result.unmatchedBook.length} + ${result.unmatchedStatement.length} unmatched`,
  );
  out.push("");

  if (result.matched.length > 0) {
    out.push("Matched");
    for (const match of result.matched) {
      out.push(
        `  ${match.scored.confidence.padEnd(7)}${match.scored.score.toFixed(3)}  ` +
          `${match.statement.map((line) => `${line.date} ${line.description}`).join(" + ")}`,
      );
    }
    out.push("");
  }

  if (result.suggested.length > 0) {
    out.push("Review queue");
    for (const match of result.suggested) {
      out.push(
        `  ${match.scored.confidence.padEnd(7)}${match.scored.score.toFixed(3)}  ` +
          `${match.statement.map((line) => `${line.date} ${line.description}`).join(" + ")}`,
      );
      for (const reason of significantReasons(match)) out.push(`      · ${reason}`);
    }
    out.push("");
  }

  out.push(renderReconciliationBridge(bridge));

  return {
    stdout: out.join("\n"),
    stderr: bridge.reconciled ? "" : "The reconciliation does not balance.\n",
    code: bridge.reconciled ? 0 : 2,
  };
}

function importCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["import"] as { flags: FlagSpecs }).flags);
  const raw = environment.readFile(requiredFlag(parsed, "statement"));
  const currencyCode = stringFlag(parsed, "currency") ?? "GBP";
  const imported = importStatement(raw, { currency: lookupCurrency(currencyCode), idPrefix: "BANK" });

  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify(
        {
          format: imported.format,
          warnings: imported.warnings,
          errors: imported.errors.map((error) => ({ row: error.row, reason: error.reason })),
          lines: imported.lines.map((line) => ({
            id: line.id,
            date: line.date,
            description: line.description,
            amount: line.amount.toDecimalString(),
          })),
        },
        null,
        2,
      ),
      stderr: "",
      code: 0,
    };
  }

  const out: string[] = [];
  out.push(`Bank statement — ${imported.format.toUpperCase()}`);
  out.push(`  ${imported.lines.length} lines, ${imported.errors.length} errors`);
  for (const warning of imported.warnings) out.push(`  warning: ${warning}`);
  out.push("");
  for (const line of imported.lines) {
    out.push(
      `  ${line.date}  ${line.amount.toDecimalString().padStart(12)}  ${line.description}`,
    );
  }
  return { stdout: out.join("\n"), stderr: "", code: imported.errors.length === 0 ? 0 : 2 };
}

function accountsCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["accounts"] as { flags: FlagSpecs }).flags);
  const ledger = loadLedger(environment, requiredFlag(parsed, "ledger"));
  if (ledger.chart === undefined) {
    return { stdout: "", stderr: "This ledger has no chart of accounts.\n", code: 1 };
  }
  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify(ledger.chart.toDefinitions(), null, 2),
      stderr: "",
      code: 0,
    };
  }
  return { stdout: ledger.chart.render(), stderr: "", code: 0 };
}

function dashboardCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["dashboard"] as { flags: FlagSpecs }).flags);
  const out = requiredFlag(parsed, "out");
  if (environment.writeFile === undefined) {
    throw new ArgumentError("This environment cannot write files");
  }

  const run = reconciliationFor(environment, parsed);
  const { ledger, account, imported, books, result, bankClosingBalance, bookClosingBalance } = run;

  const html = renderDashboard(
    dashboardData({
      ledger,
      account,
      books,
      statement: imported.lines,
      result,
      bankClosingBalance,
      bookClosingBalance,
      statementFormat: imported.format,
    }),
  );

  environment.writeFile(out, html);

  const bridge = reconciliationBridge(result, { bankClosingBalance, bookClosingBalance });
  return {
    stdout: `Wrote ${out} — ${result.matched.length} matched, ${result.suggested.length} to review, ${Math.round(html.length / 1024)} KB, no network needed.`,
    stderr: bridge.reconciled ? "" : "The reconciliation does not balance.\n",
    code: bridge.reconciled ? 0 : 2,
  };
}

// ------------------------------------------------------ generate and bench

/** A positive whole number from a flag, or the default. */
function countFlag(parsed: ReturnType<typeof parseArgs>, name: string, fallback: number): number {
  const text = stringFlag(parsed, name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArgumentError(`--${name} wants a positive whole number, got "${text}"`);
  }
  return value;
}

function generatorOptionsFrom(parsed: ReturnType<typeof parseArgs>): GeneratorOptions {
  const options: GeneratorOptions = {
    seed: countFlag(parsed, "seed", 1),
    months: countFlag(parsed, "months", 3),
    invoicesPerMonth: countFlag(parsed, "invoices", 12),
  };
  const start = stringFlag(parsed, "start");
  const code = stringFlag(parsed, "currency");
  return {
    ...options,
    ...(start === undefined ? {} : { start: date(start) }),
    ...(code === undefined ? {} : { currency: lookupCurrency(code) }),
  };
}

function generateCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["generate"] as { flags: FlagSpecs }).flags);
  if (environment.writeFile === undefined) {
    return { stdout: "", stderr: "This environment cannot write files.\n", code: 1 };
  }

  const directory = stringFlag(parsed, "out") ?? ".";
  const generated = generateBooks(generatorOptionsFrom(parsed));

  const ledgerPath = `${directory}/books.json`;
  const statementPath = `${directory}/statement.csv`;
  environment.writeFile(ledgerPath, ledgerToJson(generated.ledger));
  environment.writeFile(statementPath, statementCsv(generated));

  const written = [ledgerPath, statementPath];
  if (booleanFlag(parsed, "truth")) {
    const truthPath = `${directory}/truth.json`;
    environment.writeFile(truthPath, `${JSON.stringify(generated.truth, null, 2)}\n`);
    written.push(truthPath);
  }

  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify({ written, summary: generated.summary }, null, 2),
      stderr: "",
      code: 0,
    };
  }

  const summary = generated.summary;
  return {
    stdout: [
      `Wrote ${written.join(", ")}`,
      `  ${summary.entries} journal entries, ${summary.statementLines} statement lines`,
      `  ${summary.explainable} lines a matcher could explain, of which ${summary.grouped} are batches`,
      `  ${summary.bankOnly} bank-only, ${summary.ledgerOnly} still outstanding`,
    ].join("\n"),
    stderr: "",
    code: 0,
  };
}

interface BenchSize {
  readonly months: number;
  readonly invoices: number;
}

function parseSizes(text: string | undefined): readonly BenchSize[] {
  if (text === undefined) {
    return [
      { months: 1, invoices: 10 },
      { months: 3, invoices: 12 },
      { months: 6, invoices: 15 },
      { months: 12, invoices: 15 },
    ];
  }
  const sizes = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const [months, invoices] = part.split(":");
      const m = Number(months);
      const i = Number(invoices);
      if (!Number.isInteger(m) || m <= 0 || !Number.isInteger(i) || i <= 0) {
        throw new ArgumentError(`--sizes wants months:invoices pairs, got "${part}"`);
      }
      return { months: m, invoices: i };
    });
  if (sizes.length === 0) throw new ArgumentError("--sizes needs at least one size");
  return sizes;
}

/**
 * Time the matcher, and check it is still right while doing so.
 *
 * A benchmark that only reports wall time is a benchmark that will eventually
 * celebrate a matcher that stopped matching. The generator knows which lines
 * really belong together, so every timed run is scored against that too, and
 * the accuracy columns sit next to the milliseconds.
 */
function benchCommand(_environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["bench"] as { flags: FlagSpecs }).flags);
  const seed = countFlag(parsed, "seed", 1);
  const repeat = countFlag(parsed, "repeat", 1);
  const sizes = parseSizes(stringFlag(parsed, "sizes"));

  const rows = sizes.map((size) => {
    const generated = generateBooks({
      seed,
      months: size.months,
      invoicesPerMonth: size.invoices,
    });
    const books = bankView(generated.ledger, generated.bankAccount);

    let best = Number.POSITIVE_INFINITY;
    let result = reconcile(books, generated.statement);
    for (let run = 0; run < repeat; run++) {
      const started = performance.now();
      result = reconcile(books, generated.statement);
      best = Math.min(best, performance.now() - started);
    }

    const accuracy = measureAccuracy(result, generated.truth);
    const cross = books.length * generated.statement.length;
    return {
      months: size.months,
      invoices: size.invoices,
      bookLines: books.length,
      statementLines: generated.statement.length,
      milliseconds: Number(best.toFixed(1)),
      pairsScored: result.stats.pairsScored,
      /** Share of the full cross product that reached the scorer. */
      scoredShare: cross === 0 ? 0 : Number((result.stats.pairsScored / cross).toFixed(5)),
      precision: Number(accuracy.precision.toFixed(4)),
      recall: Number(accuracy.recall.toFixed(4)),
      recallWithSuggestions: Number(accuracy.recallWithSuggestions.toFixed(4)),
    };
  });

  if (booleanFlag(parsed, "json")) {
    return { stdout: JSON.stringify({ seed, repeat, rows }, null, 2), stderr: "", code: 0 };
  }

  const header = ["size", "books", "lines", "ms", "scored", "prec", "rec", "rec+"];
  const body = rows.map((row) => [
    `${row.months}m x${row.invoices}`,
    String(row.bookLines),
    String(row.statementLines),
    row.milliseconds.toFixed(1),
    `${(row.scoredShare * 100).toFixed(2)}%`,
    `${(row.precision * 100).toFixed(1)}%`,
    `${(row.recall * 100).toFixed(1)}%`,
    `${(row.recallWithSuggestions * 100).toFixed(1)}%`,
  ]);

  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((row) => (row[column] as string).length)),
  );
  const format = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padStart(widths[column] as number)).join("  ");

  return {
    stdout: [
      `Matcher over generated books, seed ${seed}, best of ${repeat}`,
      "",
      format(header),
      ...body.map(format),
      "",
      "scored is the share of all possible pairs that reached the scorer;",
      "rec+ counts a correct suggestion as found, which is what a reviewer sees.",
    ].join("\n"),
    stderr: "",
    code: 0,
  };
}

/**
 * Fold a reviewer's decisions into the memory.
 *
 * The decisions file is deliberately dumb: a list of `{ statement, book,
 * accepted, on }`. That is what a review UI can emit, what a script can build
 * from a spreadsheet, and what a person can write by hand when they want to
 * teach the matcher one thing without clicking through a queue to do it.
 */
function learnCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["learn"] as { flags: FlagSpecs }).flags);
  const memoryPath = requiredFlag(parsed, "memory");
  const existing = loadMemory(environment, memoryPath);

  if (booleanFlag(parsed, "show")) {
    if (booleanFlag(parsed, "json")) {
      return { stdout: JSON.stringify(existing.toDocument(), null, 2), stderr: "", code: 0 };
    }
    return { stdout: renderMemory(existing), stderr: "", code: 0 };
  }

  if (environment.writeFile === undefined) {
    return { stdout: "", stderr: "This environment cannot write files.\n", code: 1 };
  }

  const decisions = readDecisions(environment, requiredFlag(parsed, "decisions"));
  const updated = existing.learnAll(decisions);
  environment.writeFile(memoryPath, updated.toJson());

  const learned = updated.size - existing.size;
  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify(
        { memory: memoryPath, decisions: decisions.length, pairings: updated.size, new: learned },
        null,
        2,
      ),
      stderr: "",
      code: 0,
    };
  }

  return {
    stdout: [
      `Read ${decisions.length} ${decisions.length === 1 ? "decision" : "decisions"}, wrote ${memoryPath}`,
      `  ${updated.size} ${updated.size === 1 ? "pairing" : "pairings"} remembered, ${learned} new`,
    ].join("\n"),
    stderr: "",
    code: 0,
  };
}

/**
 * Book what the statement says happened and the books do not know about.
 *
 * Only lines the matcher left *entirely* unexplained are proposed. A line
 * sitting in the review queue has a ledger counterpart the matcher believes
 * in; booking an entry for it as well would double-count it. Undecided means
 * unproposed, which is the conservative reading and the right one.
 *
 * Decisions reach this command through the memory rather than through match
 * ids. The decisions file has no ids in it on purpose — an id only means
 * something against the exact reconciliation that produced it — so a
 * confirmation raises the pair's score until it matches outright, and a
 * rejection pushes it down until the statement line falls out of the queue and
 * becomes something to book. The mechanism was already there; this command
 * just points it at the right question.
 */
function postCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["post"] as { flags: FlagSpecs }).flags);

  const decisionsPath = stringFlag(parsed, "decisions");
  const decisions = decisionsPath === undefined ? [] : readDecisions(environment, decisionsPath);

  const run = reconciliationFor(environment, parsed, decisions);
  const { ledger, account, currencyCode, result, memory } = run;
  const needing = linesNeedingEntries(result, memory);

  const rulesPath = stringFlag(parsed, "rules");
  let rules = standardRules();
  if (rulesPath !== undefined) {
    try {
      rules = parseRules(environment.readFile(rulesPath));
    } catch (error) {
      if (error instanceof PostingRuleError) throw new ArgumentError(error.message);
      throw error;
    }
  }

  const suspense = stringFlag(parsed, "suspense");
  if (suspense !== undefined && ledger.chart?.isPostable(suspense) === false) {
    throw new ArgumentError(`The suspense account ${suspense} is not one this chart can post to`);
  }

  const options: ProposalOptions = {
    account,
    rules,
    ledger,
    ...(suspense === undefined ? {} : { suspenseAccount: suspense }),
  };
  let proposals;
  try {
    proposals = proposeEntries(needing, options);
  } catch (error) {
    if (error instanceof PostingRuleError) throw new ArgumentError(error.message);
    throw error;
  }
  const summary = summariseProposals(proposals, currencyCode);

  const out = stringFlag(parsed, "out");
  let written: string | undefined;
  if (out !== undefined) {
    if (environment.writeFile === undefined) {
      return { stdout: "", stderr: "This environment cannot write files.\n", code: 1 };
    }
    environment.writeFile(out, ledgerToJson(applyProposals(ledger, proposals)));
    written = out;
  }

  const strict = booleanFlag(parsed, "strict");
  const code = strict && summary.unclassified > 0 ? 2 : 0;

  if (booleanFlag(parsed, "json")) {
    return {
      stdout: JSON.stringify(
        {
          account,
          proposals: proposals.map((proposal) => ({
            statementLine: proposal.line.id,
            date: proposal.line.date,
            description: proposal.line.description,
            amount: proposal.line.amount.toDecimalString(),
            outcome: proposal.outcome,
            rule: proposal.rule?.id ?? null,
            account: proposal.account,
            entry: proposal.entry?.id ?? null,
            reason: proposal.reason,
          })),
          summary: {
            total: summary.total,
            booked: summary.booked,
            skipped: summary.skipped,
            unclassified: summary.unclassified,
            alreadyBooked: summary.alreadyBooked,
            net: summary.net.toDecimalString(),
            byAccount: summary.byAccount.map((total) => ({
              account: total.account,
              amount: total.amount.toDecimalString(),
              count: total.count,
            })),
          },
          ...(written === undefined ? {} : { wrote: written }),
        },
        null,
        2,
      ),
      stderr: "",
      code,
    };
  }

  const lines = [
    `${needing.length} statement ${needing.length === 1 ? "line has" : "lines have"} no counterpart in the books`,
    "",
    renderProposals(proposals, summary),
  ];
  if (suspense !== undefined) {
    lines.push(
      "",
      `Everything unmatched went to ${suspense}. A line the matcher merely failed to`,
      "match is not a line the books are missing, so check the queue before trusting this.",
    );
  }
  if (written !== undefined) {
    lines.push("", `Wrote ${written} with ${summary.booked} ${summary.booked === 1 ? "entry" : "entries"} applied.`);
  } else if (summary.booked > 0) {
    lines.push("", "Nothing was written. Pass --out to apply these.");
  }

  return {
    stdout: lines.join("\n"),
    stderr:
      code === 2
        ? `${summary.unclassified} line${summary.unclassified === 1 ? "" : "s"} could not be classified.\n`
        : "",
    code,
  };
}

/**
 * Read a decisions file, in the same format the dashboard writes.
 *
 * The format lives in `reconcile/decisions.ts` so that "what the review UI
 * emits" and "what this command accepts" cannot drift apart. Its errors are
 * re-thrown as usage errors because from the command line that is what they
 * are: a file the caller handed over that could not be read.
 */
function readDecisions(environment: CliEnvironment, path: string) {
  try {
    return decisionsFor(environment.readFile(path));
  } catch (error) {
    if (error instanceof DecisionDocumentError) throw new ArgumentError(error.message);
    throw error;
  }
}

const HANDLERS: Record<string, (environment: CliEnvironment, argv: readonly string[]) => CliResult> = {
  report: reportCommand,
  ageing: ageingCommand,
  reconcile: reconcileCommand,
  import: importCommand,
  accounts: accountsCommand,
  generate: generateCommand,
  bench: benchCommand,
  learn: learnCommand,
  dashboard: dashboardCommand,
  post: postCommand,
};

/** Run one invocation. Never throws; every failure becomes an exit code. */
export function run(argv: readonly string[], environment: CliEnvironment): CliResult {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return { stdout: usage(), stderr: "", code: command === undefined ? 1 : 0 };
  }
  if (command === "--version" || command === "-v") {
    return { stdout: "tallyd 0.1.0", stderr: "", code: 0 };
  }

  const handler = HANDLERS[command];
  if (handler === undefined) {
    return { stdout: "", stderr: `Unknown command: ${command}\n\n${usage()}\n`, code: 1 };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    return { stdout: commandHelp(command), stderr: "", code: 0 };
  }

  try {
    return handler(environment, rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `${message}\n`, code: 1 };
  }
}
