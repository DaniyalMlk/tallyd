# tallyd

A double-entry ledger and bank-reconciliation engine, written in TypeScript.

Bookkeeping software is mostly a solved problem right up until the moment you have
to match a bank statement against your books. Then the amounts are off by a payment
processor's fee, the dates are off by two days of settlement lag, the description is
`SQ *COFFEE 4471` and your ledger says `Client lunch — Acme`, and one deposit covers
three invoices. That matching problem is what this project is actually about.

## Status

Phases 1–5 of 7 are done; see [`ROADMAP.md`](./ROADMAP.md). The accounting core is
complete and tested — money, the chart of accounts, journal entries, the ledger
and the trial balance — and so is statement ingestion: CSV and OFX readers,
format detection and duplicate flagging. The matching engine works end to end,
including one-to-many and many-to-one matches, and produces a bank
reconciliation statement that balances to the penny. On top of that sit the
financial statements — income statement, balance sheet and ageing — and a CLI
that runs the whole thing against files on disk. A dashboard is still to come.

## Running it

```bash
npm install
npm test              # 636 tests
npm run typecheck
npm run demo          # a worked month, posted and reported
npm run demo:ingest   # the same month as the bank recorded it
npm run demo:reconcile # the two, matched against each other
npm run demo:reports  # income statement, balance sheet and ageing
```

## The command line

```bash
npm run build
node dist/src/cli/main.js --help

tallyd report    -l books.json --from 2026-07-01 --to 2026-09-30 --compare 2026-04-01:2026-06-30
tallyd ageing    -l books.json -a 1130 --as-at 2026-09-30
tallyd reconcile -l books.json -s statement.csv
tallyd import    -s statement.csv          # what the reader made of it, no matching
tallyd accounts  -l books.json
```

Every command takes `--json`. Exit codes carry meaning: `0` success, `1` a bad
file or a bad flag, and `2` for work that ran to completion and came out wrong —
a reconciliation that does not balance, a trial balance that does not agree. A
CI job that treats an unbalanced reconciliation as a pass is worse than no CI
job at all.

```
$ tallyd reconcile -l month.json -s bank.csv
Reconciling 1110 against 12 statement lines
  7 matched, 2 to review, 1 + 3 unmatched
...
Reconciled                                            0.00
$ echo $?
0
```

`npm run demo` posts a month of transactions for a small consultancy and prints the
trial balance, the totals by account type, and a running bank statement:

```
Trial balance (GBP)
---------------------------------------------------------
Account Name                            Debit      Credit
1110    Bank                         23143.58
2200    VAT Payable                               1200.00
2300    Payroll Liabilities                       2180.00
3100    Share Capital                            25000.00
4100    Sales                                      480.00
4200    Consulting                                6000.00
5200    Salaries                      9400.00
5300    Rent                          1850.00
5400    Software                       299.00
5500    Payment Processing Fees          6.92
5700    Professional Fees              142.50
5800    Bank Charges                    18.00
---------------------------------------------------------
        Total                        34860.00    34860.00
```

The month is deliberately awkward in the ways real books are. A £480 card sale is
captured on the 5th but settles on the 7th as £473.08, net of a 1.4% + 20p fee, so
the deposit that reaches the bank matches no invoice exactly — the case the
matcher exists for. A £299 licence is split three ways across projects with no penny
lost. An expense posted to the wrong account is corrected by reversal, not by
editing history, so `JE-008` is still there next to the `JE-009` that undoes it.

`npm run demo:ingest` reads the bank's own record of that month — a CSV with a
three-line preamble, day-first dates and separate paid-out/paid-in columns — and
prints what the importer made of it:

```
Bank statement — CSV
  12 lines, 0 duplicates, 0 errors from 12 rows (DD/MM/YYYY, '.' decimal, GBP)
  columns: 0:date  1:description  2:debit  3:credit  4:balance

Near-duplicates worth a second look
  2026-08-14 and 2026-08-15 (1d apart): -142.50 TO BISTRO

Descriptions as the matcher will see them
  SQ *SETTLEMENT 0805 4471            →  SETTLEMENT 0805
  FPI ACME LTD — INV1001              →  ACME LTD INV1001
```

`npm run demo:reconcile` is the one that matters. It runs the matcher over both,
prints what it decided and why, and finishes with the reconciliation statement:

```
Matched
  1:1  exact  0.970      7200.00
       bank    2026-08-12  FPI ACME LTD INV1001
       ledger  2026-08-12  Invoice 1001 settled
         · amount: exact at 7200.00
         · date: same day
         · reference: reference 1001
  1:N  high   0.883      5160.00
       bank    2026-09-20  FPI NORTHWIND LTD INV1042
       ledger  2026-09-20  Northwind Ltd — INV1042
       ledger  2026-09-20  Northwind Ltd — INV1043
       ledger  2026-09-20  Northwind Ltd — INV1044

Review queue
  1:1  medium 0.709      -142.50
       bank    2026-08-15  CARD PAYMENT TO BISTRO ON 14-AUG
       ledger  2026-08-15  Client dinner — recoded

Bank reconciliation (GBP)
Balance per bank statement                        20764.20
  Add: receipts not yet on the statement
    2026-08-15  Reverse JE-008 — miscoded to Tra      142.50
  Less: payments not yet on the statement
    2026-08-14  Client dinner                        -142.50
    2026-08-15  Client dinner — recoded              -142.50
Adjusted bank balance                             20621.70
...
Reconciled                                            0.00
```

## Using it as a library

```ts
import { Ledger, JournalEntry, Money, GBP, standardChart, trialBalance } from "tallyd";

const chart = standardChart(GBP);
const ledger = Ledger.empty(chart).post(
  JournalEntry.simple({
    id: "JE-001",
    date: "2026-08-01",
    narration: "August rent",
    debit: "5300",
    credit: "1110",
    amount: Money.parse("1850.00", GBP),
  }),
);

trialBalance(ledger).balanced; // true
```

Reconciling a statement takes three calls:

```ts
import { bankView, reconcile, reconciliationBridge, renderReconciliationBridge } from "tallyd";

const books = bankView(ledger, "1110");
const result = reconcile(books, importedStatementLines);

result.matched;             // safe to post
result.suggested;           // needs a human, best first
result.unmatchedStatement;  // charges and interest nobody booked

const bridge = reconciliationBridge(result, { bankClosingBalance, bookClosingBalance });
bridge.reconciled;          // true, or the matcher lost a line
console.log(renderReconciliationBridge(bridge));
```

## Design notes

**Money is never a float.** Every amount is a `bigint` count of minor units paired
with a currency. Arithmetic between mismatched currencies is an exception, not a
runtime surprise, and converting from a JS `number` requires naming a rounding mode
at the call site so the lossy step is visible in the code. Allocation uses
largest-remainder, so splitting £100 three ways yields 33.34 / 33.33 / 33.33 and
never loses a penny — verified by a property test that the parts sum back to the
original for any amount, any weights, and either sign.

**The one that mattered: the balancing invariant lives in the constructor.** A
`JournalEntry` whose postings do not sum to zero cannot be constructed. The
constructor is private, the factory checks, and every field is frozen. The
alternative — a `validate()` method called by whoever remembers — is the design
that lets an unbalanced entry reach the database on the one path nobody tested.
Two consequences fall out of putting the check at the type boundary. Postings carry
a single signed amount rather than a `(side, magnitude)` pair, so the invariant is
literally "the amounts sum to zero" and needs no interpretation. And the check runs
per currency, so a GBP debit offset by a USD credit is rejected rather than netting
to a nonsense zero. The `Ledger` never re-checks entries it is handed; it cannot
hold an invalid one. What it does check, in `verify()`, is that its own incremental
balance index still agrees with a full replay of the entries — because that index
is an optimisation, and optimisations are what drift.

**Ambiguity is decided per column, never per row.** `03/04/2026` is 3 April in
London and 4 March in New York, and `1.234` is either a thousand or one and a
bit. Both questions are settled once for a whole column, by looking for a value
that rules one reading out — a day above 12, a separator that repeats. Deciding
per row is the failure mode that matters: it yields a statement where most lines
are right and a few are silently six weeks or a thousandfold out. When a column
genuinely cannot be settled, the importer says so in a warning and takes a
documented default rather than pretending to know. The same instinct runs through
duplicate detection: two £2.85 coffees at the same shop on the same day are two
transactions, so repeated lines are counted and flagged for a human rather than
quietly dropped.

**Dates are strings, not `Date`s.** A posting happens on a calendar date. Using
`Date` would drag a timezone into every comparison, and a statement line dated
1 March in London would sort before a ledger entry dated 1 March in New York. So
dates are validated `YYYY-MM-DD` strings with integer day arithmetic, which also
means lexicographic sort is chronological sort.

**Matching is two passes, and the order is the whole design.** Groups go first.
A batch supplier payment leaves the bank as one debit and sits in the books as
four invoices; if the one-to-one pass ran first it would pair that bank line
with whichever single invoice looked closest, consume both, and strand the other
three — and the mistake is unrecoverable, because the evidence has been spent.
Only once the groups are settled do the remaining lines go through
maximum-weight bipartite matching, so that two statement lines competing for the
same ledger entry are decided by what is best overall rather than by which
happened to be scored first. Greedy matching is kept in the codebase purely to
show the gap: on one small matrix it scores 1.05 where optimal scores 1.80.

Group candidates come from a bounded subset-sum search, and the bound that
matters most is not the node budget — it is the rule that a group is only
proposed when no single line already explains the anchor on its own. Without it,
a £7,200 receipt gets "explained" as an invoice plus a reversal pair that
happens to cancel out. That is arithmetic, not evidence.

**Every match carries its reasons.** Amount and direction are gates rather than
contributions: a payment that differs by £40 is not a weak match, it is a
different transaction. What remains — amount, date proximity, description
similarity, shared references — is weighted and averaged, and each rule reports
its own sub-score and what it contributed. The reference rule drops out of the
average entirely when neither side carries one, because scoring a missing signal
as zero would punish every cash transaction for something it could never have
had. Descriptions are compared after normalisation, which is what lets
`DD RENT, AUGUST 08` and `August rent` agree, and a reference both sides share
(`INV1001` against a bare `1001`) is treated as near-decisive.

**The reconciliation statement is the real test.** Matching produces two piles of
leftovers; the bridge walks from the bank's closing balance to the ledger's, one
reconciling item at a time, and the two adjusted balances must be equal. That is
not a convention — every match pairs equal amounts, so the whole difference
between the two closing balances has to live in the unmatched items. A matcher
that pairs the wrong things still balances; a matcher that loses or double-counts
a line cannot. The property test throws 400 random books-and-statement pairs at
it and asserts the difference is exactly zero every time.

**The balance sheet folds the period result into equity itself.** This ledger is
append-only and never rewrites history, so nothing has been closed out to
retained earnings — income and expense accounts still hold their balances.
Report equity as it stands and the statement is out by exactly the profit for
the period, every time. So the result goes in as its own visible line. It is not
a fudge to make the two sides agree: it is what closing entries would post if
they existed, and the identity underneath falls straight out of double entry.
A test removes the fold and asserts the sheet then fails to balance, so the line
cannot be deleted as redundant.

**Ageing groups by reference, not by counterparty.** A receivables account is not
a list of debts, it is a list of postings, some of which cancel others. Postings
are grouped by external reference, netted, and the groups that do not reach zero
are what is outstanding. Two invoices to the same customer age separately,
because one may be current while the other is ninety days overdue — rolling them
together hides exactly the item worth chasing. An item ages from its earliest
posting, not its last: a part payment received today does not make a sixty-day
debt current. An overpayment stays visible as a negative item, because filtering
it out would be tidier and would quietly stop the ageing total tying to the
account balance.

**The CLI is a pure function.** `run(argv, environment)` takes its filesystem
reader and its clock as parameters and returns stdout, stderr and an exit code.
Nothing in the command layer touches `process` or `console`; the executable is
twenty lines that connect the two. The whole CLI is therefore tested end to end
against an in-memory filesystem, running the same code paths the binary does,
with no spawning and no temp directories.

## Licence

MIT
