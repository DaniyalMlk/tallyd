# tallyd

A double-entry ledger and bank-reconciliation engine, written in TypeScript.

Bookkeeping software is mostly a solved problem right up until the moment you have
to match a bank statement against your books. Then the amounts are off by a payment
processor's fee, the dates are off by two days of settlement lag, the description is
`SQ *COFFEE 4471` and your ledger says `Client lunch — Acme`, and one deposit covers
three invoices. That matching problem is what this project is actually about.

## Status

Days 1–3 of 7 are done; see [`PLAN.md`](./PLAN.md). The accounting core is
complete and tested — money, the chart of accounts, journal entries, the ledger
and the trial balance — and so is statement ingestion: CSV and OFX readers,
format detection and duplicate flagging. The matching engine is next, and it is
the point of the whole thing.

## Running it

```bash
npm install
npm test           # 478 tests
npm run typecheck
npm run demo       # a worked month, posted and reported
npm run demo:ingest # the same month as the bank recorded it
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
the deposit that reaches the bank matches no invoice exactly — the case the day-4
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

## Licence

MIT
