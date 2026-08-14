# tallyd — 7-day build plan

**Domain:** fintech · **Week of:** 14–21 Aug 2026

A double-entry ledger and bank-reconciliation engine. The interesting part is not
storing transactions — it is the matching engine that decides which bank statement
lines correspond to which ledger entries when the amounts, dates, and descriptions
all disagree slightly.

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
- [ ] **Day 3 — Statement ingestion.** CSV and OFX-lite parsers, column inference,
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
| `src/demo/month.ts` | A worked August for a small consultancy |

255 tests, all green.

## Carried over

- **CI is not wired up.** The workflow file was written but the automation token
  lacks GitHub's `workflow` scope, so `.github/workflows/ci.yml` cannot be pushed.
  Whoever has a full-scope token should add it; the commands are `npm run
  typecheck`, `npm test`, `npm run demo`.

## Status log

- **14 Aug** — repo scaffolded, plan written.
- **14 Aug (later)** — days 1 and 2 built: money, rounding, currencies, chart of
  accounts, calendar dates, journal entries, the append-only ledger, the trial
  balance, and a runnable worked month. 255 tests passing.
