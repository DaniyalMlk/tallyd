# tallyd

A double-entry ledger and bank-reconciliation engine, written in TypeScript.

Bookkeeping software is mostly a solved problem right up until the moment you have
to match a bank statement against your books. Then the amounts are off by a payment
processor's fee, the dates are off by two days of settlement lag, the description is
`SQ *COFFEE 4471` and your ledger says `Client lunch — Acme`, and one deposit covers
three invoices. That matching problem is what this project is actually about.

## Status

Week 1 of 7 planned days — see [`PLAN.md`](./PLAN.md). Currently scaffolding.

## Design notes

**Money is never a float.** Every amount is an integer count of minor units paired
with a currency. Arithmetic between mismatched currencies is a type error, not a
runtime surprise. Allocation uses largest-remainder so splitting £100 three ways
yields 33.34 / 33.33 / 33.33 and never loses a penny.

**Postings are immutable and always balanced.** A journal entry that does not sum to
zero cannot be constructed — the invariant lives in the constructor, so no downstream
code has to remember to check it. Corrections are made by reversing entries, the way
real accounting works, which keeps the audit trail intact.

**Matches explain themselves.** The reconciliation engine emits a score plus the
reasons that produced it (`amount:exact`, `date:+2d`, `description:0.72`), because a
human reviewing a match queue needs to know why the machine thinks two rows are the
same thing.

## Licence

MIT
