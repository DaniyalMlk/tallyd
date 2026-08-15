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
import { ledgerFromJson } from "../ledger/serialise.js";
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
import {
  ArgumentError,
  booleanFlag,
  parseArgs,
  renderFlags,
  requiredFlag,
  stringFlag,
  type FlagSpecs,
} from "./args.js";

export interface CliEnvironment {
  /** Read a file as UTF-8, or throw. */
  readonly readFile: (path: string) => string;
  /** Today, for commands that default their as-at date. */
  readonly today: () => CalendarDate;
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

function bankAccountFor(ledger: Ledger, requested: string | undefined): string {
  if (requested !== undefined) {
    if (ledger.chart !== undefined && !ledger.chart.has(requested)) {
      throw new ArgumentError(`No account ${requested} in the chart`);
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

function reconcileCommand(environment: CliEnvironment, argv: readonly string[]): CliResult {
  const parsed = parseArgs(argv, (COMMANDS["reconcile"] as { flags: FlagSpecs }).flags);
  const ledger = loadLedger(environment, requiredFlag(parsed, "ledger"));
  const account = bankAccountFor(ledger, stringFlag(parsed, "account"));
  const raw = environment.readFile(requiredFlag(parsed, "statement"));

  const currencyCode =
    stringFlag(parsed, "currency") ??
    ledger.chart?.find(account)?.currency.code ??
    ledger.currenciesUsed()[0] ??
    "GBP";
  const imported = importStatement(raw, { currency: lookupCurrency(currencyCode), idPrefix: "BANK" });

  const windowText = stringFlag(parsed, "date-window");
  const options: Parameters<typeof reconcile>[2] = {};
  if (windowText !== undefined) {
    const days = Number(windowText);
    if (!Number.isInteger(days) || days < 0) {
      throw new ArgumentError(`--date-window wants a whole number of days, got "${windowText}"`);
    }
    options.dateWindowDays = days;
  }
  if (booleanFlag(parsed, "no-groups")) options.groupMatching = false;

  const books = bankView(ledger, account, { currency: currencyCode });
  const result = reconcile(books, imported.lines, options);

  const bookBalance = books.reduce(
    (total, line) => total.plus(line.amount),
    Money.zero(currencyCode),
  );
  const bridge = reconciliationBridge(result, {
    bankClosingBalance: statementClosingBalance(imported.lines, Money.zero(currencyCode)),
    bookClosingBalance: bookBalance,
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

const HANDLERS: Record<string, (environment: CliEnvironment, argv: readonly string[]) => CliResult> = {
  report: reportCommand,
  ageing: ageingCommand,
  reconcile: reconcileCommand,
  import: importCommand,
  accounts: accountsCommand,
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
