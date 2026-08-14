# tallyd — 7-day build plan

**Domain:** fintech · **Week of:** 14–21 Aug 2026

A double-entry ledger and bank-reconciliation engine. The interesting part is not
storing transactions — it is the matching engine that decides which bank statement
lines correspond to which ledger entries when the amounts, dates, and descriptions
all disagree slightly.

> **This file is canonical.** An automated session briefly renamed it to
> `ROADMAP.md`; that copy has been folded back in and removed. Please keep the
> plan here, under this name, so the scheduled sessions that read it keep finding
> it. See "Coordination" below.

## Design constraints

- Money is integer minor units. No floats anywhere in the accounting path.
- Every posting balances or it is rejected. The invariant is enforced at the type
  boundary, not by a validation pass afterwards.
- The reconciliation engine must explain itself: every match carries a score and
  the reasons behind it, so a human reviewing the queue can see why.
- No paid APIs. Demo data is generated deterministically.

## Milestones

- [x] **Day 1 — Money and the chart of accounts.** `Money` type with currency-safe
      arithmetic, rounding, and allocation (splitting 100 into 3 without losing a
      cent). Account tree, normal balances, account types. Table-driven tests.
- [x] **Day 2 — Posting engine.** Journal entries, the balancing invariant,
      immutable ledger with append-only postings, running balances, trial balance.
      Property tests: no sequence of valid postings can unbalance the ledger.
- [x] **Day 3 — Statement ingestion.** CSV and OFX-lite parsers, column inference,
      date-format detection, currency normalisation, duplicate detection on import.
- [ ] **Day 4 — Reconciliation matching engine.** Exact match, amount-and-date
      window match, fuzzy description scoring, one-to-many splits and many-to-one
      aggregations. Confidence scoring with per-rule explanations.
- [ ] **Day 5 — Reports and CLI.** Trial balance, P&L, balance sheet, ageing.
      A real CLI that ingests a statement, reconciles it, and prints the queue.
- [ ] **Day 6 — Dashboard.** Ledger explorer and reconciliation review UI. Charts
      for cash position and match-confidence distribution.
- [ ] **Day 7 — Polish.** Demo dataset generator, CI, README with a worked example,
      performance pass over the matcher.

## What exists now

| Module | What it does |
|---|---|
| `src/money/rounding.ts` | Seven rounding modes over exact bigint division |
| `src/money/currency.ts` | ISO currency registry with minor-unit exponents |
| `src/money/money.ts` | `Money`: exact arithmetic, `split`, `allocate`, formatting |
| `src/accounts/types.ts` | Five account types, normal balances, statement classes |
| `src/accounts/chart.ts` | Immutable validated account tree |
| `src/accounts/standard.ts` | A small-business chart in 1000-blocks |
| `src/ledger/date.ts` | Timezone-free calendar dates and day arithmetic |
| `src/ledger/entry.ts` | `JournalEntry` — unbalanced entries cannot be constructed |
| `src/ledger/ledger.ts` | Append-only ledger, balance index, `verify()` |
| `src/ledger/trialBalance.ts` | Trial balance, per-type totals, equation residual |
| `src/statement/csv.ts` | RFC 4180 reader, delimiter sniffing, preamble skip |
| `src/statement/amount.ts` | Amount parsing across bank formats and locales |
| `src/statement/dates.ts` | Column-wide date format detection |
| `src/statement/columns.ts` | Column role inference from headers and content |
| `src/statement/line.ts` | Statement lines, description normalisation, fingerprints |
| `src/statement/duplicates.ts` | Exact and near-duplicate detection |
| `src/statement/import.ts` | CSV import pipeline with per-row errors |
| `src/statement/ofx.ts` | OFX/QFX reader for the SGML banks actually emit |
| `src/demo/month.ts` | A worked August for a small consultancy |
| `src/demo/statement.ts` | The same August as the bank recorded it |

478 tests green, typecheck clean.

## Day 4 starts here

The two demo fixtures are deliberately mismatched, and the gaps between them are
the matcher's specification:

| Bank line | Ledger entry | Why it is hard |
|---|---|---|
| 07/08 `SQ *SETTLEMENT 0805` +473.08 | JE-004/JE-005, £480.00 sale | Two days late, £6.92 short — the fee |
| 12/08 `FPI ACME LTD INV1001` +7200.00 | JE-002 invoice, JE-007 receipt | Reference matches, description does not |
| 14/08 and 15/08 `BISTRO` −142.50 twice | JE-008 reversed, JE-010 recoded | One bank line each, three ledger entries |
| 18/08 `ATM CASH WITHDRAWAL` −60.00 | nothing | Genuinely unrecorded — must not be forced |
| 31/08 `INTEREST PAID` +3.12 | nothing | Same |

`npm run demo:ingest` prints the statement as the matcher will receive it,
including the normalised descriptions it will score against.

## Coordination

More than one automated session has worked in this repo on the same day, and they
collided: one renamed `PLAN.md` to `ROADMAP.md` while another was mid-branch. If
you are such a session, **rebase rather than force-push**, and keep the plan in
this file.

## Carried over

- **CI is not wired up.** The workflow file was written but the automation token
  lacks GitHub's `workflow` scope, so `.github/workflows/ci.yml` cannot be pushed.
  Whoever has a full-scope token should add it; the commands are `npm run
  typecheck`, `npm test`, `npm run demo`, `npm run demo:ingest`.
- **The `daily-mvp` topic was dropped from the repo** at some point on 14 Aug and
  restored. Automated sessions locate this project by that topic; without it they
  will start an unrelated new project instead of continuing this one.

## Status log

- **14 Aug** — repo scaffolded, plan written.
- **14 Aug** — days 1 and 2: money, rounding, currencies, chart of accounts,
  calendar dates, journal entries, the append-only ledger, the trial balance, and
  a runnable worked month.
- **14 Aug** — day 3: CSV and OFX readers, amount and date format detection,
  column inference, duplicate detection, and a second demo showing the bank's
  view of the same month. Fixed a NUL byte that had made `ledger.ts` binary to
  git, and a flaky CSV property test.
