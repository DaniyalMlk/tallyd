# tallyd

A double-entry ledger and bank-reconciliation engine, written in TypeScript.

Bookkeeping software is mostly a solved problem right up until the moment you have
to match a bank statement against your books. Then the amounts are off by a payment
processor's fee, the dates are off by two days of settlement lag, the description is
`SQ *COFFEE 4471` and your ledger says `Client lunch — Acme`, and one deposit covers
three invoices. That matching problem is what this project is actually about.

## Status

Phases 1–9 are done; see [`ROADMAP.md`](./ROADMAP.md). The accounting core is
complete and tested — money, the chart of accounts, journal entries, the ledger
and the trial balance — and so is statement ingestion: CSV and OFX readers,
format detection and duplicate flagging. The matching engine works end to end,
including one-to-many and many-to-one matches, and produces a bank
reconciliation statement that balances to the penny. On top of that sit the
financial statements — income statement, balance sheet and ageing — a CLI that
runs the whole thing against files on disk, and a dashboard that turns the
review queue into something you can actually work through.

Two pieces of recent work are worth calling out. A seeded generator that builds
books of any size *with the answer key*, and the performance pass measured
against it: a year of a busy account — 715 ledger movements against 625
statement lines — went from 16.8 seconds to 0.2 with identical accuracy either
side. And a matcher that no longer forgets: a counterparty a reviewer confirms
once is recognised the next month, which on generated books moved recall from
75.6% to 89.0% and cut the review queue by 69%.

The cycle now closes at both ends. Decisions leave the review UI as a file the
CLI already reads, and the statement lines nothing in the books explains come
back as journal entries — classified, balanced, and impossible to post twice.

## Running it

```bash
npm install
npm test              # 995 tests
npm run typecheck
npm run demo          # a worked month, posted and reported
npm run demo:ingest   # the same month as the bank recorded it
npm run demo:reconcile # the two, matched against each other
npm run demo:reports  # income statement, balance sheet and ageing
npm run bench         # the matcher timed and scored over generated books
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
tallyd dashboard -l books.json -s statement.csv -o reconciliation.html
tallyd generate  -o ./fixtures --months 12 --invoices 30 --truth
tallyd rates     -r ecb.csv -b EUR -p USD/GBP --on 2026-03-13 --amount 5000.00
tallyd bench     --sizes 1:10,6:15,12:30
tallyd learn     -m memory.json -d decisions.json
tallyd reconcile -l books.json -s statement.csv -m memory.json
tallyd post      -l books.json -s statement.csv -d decisions.json -o after.json
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

## The dashboard

`tallyd dashboard` writes one HTML file — inline styles, inline script, data
embedded as JSON, nothing fetched. It opens from a file path on a machine with
no network and no toolchain, which matters because the person who most needs to
look at a reconciliation is often the one who cannot install anything.

It is not a rendering of the CLI output. Accepting a suggestion moves it into
the matched set and recomputes the bridge in front of you; rejecting one pushes
both lines back into the leftovers. An undecided suggestion counts as
outstanding on *both* sides, so the arithmetic is honest about what has not been
confirmed yet. The ledger explorer lists every account that has been posted to,
with grouping accounts rolled up, and drills into the postings behind any of
them.

### Getting the decisions back out

Working through a queue produces the only new information in the whole cycle: a
person asserting which counterparties are the same counterparty. The page hands
that back as a decisions file, in the format `tallyd learn` reads.

```bash
tallyd dashboard -l books.json -s statement.csv -a 1110 -o review.html
# work the queue, press Export decisions, then:
tallyd learn -m memory.json -d ~/Downloads/decisions-1110-2026-04-30.json
```

A decision is reversible until it is exported — the bar along the bottom counts
what is pending and undoes the last one, and the *Decided* section undoes any of
them. Nothing is written anywhere until you ask for the file.

The design decision that mattered here is where the format lives. The payload
for each suggestion — which two descriptions are being paired, and the amount,
date, kind and confidence that ride along as context — is computed in
TypeScript and baked into the page. The browser stamps a verdict and today's
date onto it and serialises the result. That is the whole of the client's
involvement with the format, so what can go wrong in the browser is a boolean
and a date rather than a schema. A format definition living in a string of
hand-written client JavaScript is a format definition nobody can test.

Group matches expand: accepting `BACS SUPPLIER RUN 724262` against three
supplier payments is one click but three facts, because next month the same
batch arrives with a different reference and the same three names in it. The
expansion is the cross product of the descriptions on each side, deduplicated,
and bounded at sixteen by the matcher's own four-a-side group cap.

## Generated books, and performance

Everything above was developed against a hand-written month: a dozen statement
lines, a couple of dozen postings. That is enough to prove the logic and nothing
like enough to prove it scales, so `tallyd generate` builds books of any size.

It is seeded, so the same seed produces the same books byte for byte, and it is
deliberately awkward in the ways real books are — settlement lag, processor fees
netted off the deposit, batch supplier runs that leave the bank as one debit,
charges nobody booked, cheques that clear next period, and descriptors written
the way a bank writes them rather than the way a bookkeeper does.

The part that matters most is `--truth`: because the generator built both sides,
it knows which statement line really came from which posting. That answer key is
what turns a benchmark from "how fast" into "how fast, and still right".

```bash
tallyd generate -o ./fixtures --months 12 --invoices 30 --truth
tallyd bench --sizes 1:10,6:15,12:30,24:40 --repeat 2
```

```
   size  books  lines      ms  scored    prec    rec   rec+
 1m x10     22     20     3.2   4.09%  100.0%  79.0%  94.7%
 3m x12     77     70     6.2   1.21%  100.0%  76.5%  95.6%
 6m x15    189    171    12.3   0.50%  100.0%  73.5%  96.4%
12m x15    380    329    23.0   0.24%  100.0%  72.7%  95.9%
12m x30    715    625   189.4   0.13%  100.0%  76.9%  96.7%
24m x40   1916   1657  1655.4   0.05%  100.0%  77.5%  96.6%
```

Precision is 100% at every size: the matcher never auto-accepted a pairing the
generator says is wrong. That is the number to watch, because the two kinds of
error are not equally bad. A missed match costs a reviewer a minute; a *wrong*
match costs them an afternoon, because the evidence has been consumed and the
two lines that should have gone together are now stranded elsewhere in the
report. `rec` is what went through unattended and `rec+` counts a correct
suggestion as found, which is what a reviewer actually experiences.

<h3 id="performance">What made it fast</h3>

The 12m x30 row took **16.8 seconds** before this work and takes **0.2** now,
from two changes. Both came from taking the scorer's own structure seriously
rather than from micro-optimisation.

**The one-to-one pass was scoring every pair.** All of them: 715 x 625 is
446,875 comparisons, each running Levenshtein and Jaro-Winkler over two
descriptions to produce, 99.9% of the time, a rejection. But the scorer's first
rules are *gates*, not contributions — a pair dies outright if the currencies
differ, if the amounts differ by more than the tolerance, if the signs disagree,
or if the dates fall outside the window. Three of those four are indexable. So
book lines are bucketed by currency and amount and kept sorted by date, and a
statement line's candidates are a map lookup plus a binary search. The `scored`
column above is the share that survived to be scored at all — 0.13% on that row.

The index's contract is exact rather than approximate: it admits precisely the
pairs the scorer would not reject, never a superset and never a subset. Blocking
that quietly dropped a real pair would cost recall while looking like a speedup,
which is why the equivalence is a property test rather than a comment.

**What survives is sparse, so it decomposes.** The Hungarian solver needs a
complete matrix and pads it to `(rows + cols)` square, making it cubic in the
total number of lines whether or not the pairs are plausible. But a matching
cannot use an edge between two components of a graph, because there is none — so
each connected component is solved on its own and the answers concatenated. The
result is exactly as optimal as solving the whole thing at once; the cost
becomes cubic in the largest island rather than in the size of the books.

**Group matching was searching both directions at once.** Finding which
invoices add up to one batch debit is subset-sum, pruned by bounds on what the
remaining values could still contribute. With inflows and outflows in the same
pool that bound spans everything from the sum of all the debits to the sum of
all the credits, so no branch can ever be ruled out and the search degenerates.
Restricting the pool to movements going the same way as the anchor is what the
direction gate already implies — a supplier run is all outflows, a lump-sum
receipt all inflows — and it took the group pass from 8.3 seconds to 0.2. It is
also more correct: a "group" mixing directions is money in and money out that
happen to cancel, which is exactly the coincidence the matcher should refuse.

The worst case has not gone away and is not pretended away. Books where hundreds
of movements share one amount and one date are a single component with no
decomposition to exploit, and that stays a dense solve. It stays correct; it
does not stay fast.

## What it remembers

Every month the same supplier arrives with a new reference. The bank writes
`FPO ASHGROVE SUPPLIES 4471 BILL-3104` in March and `SO ASHGROVE SUPPLIES 8822
BILL-3391` in April; the books say `Payment — Ashgrove Supplies` both times. The
description rule scores the two months identically, so a pair a human confirmed
in March lands back in the review queue in April, and in May, and for as long as
anyone uses the tool. That is the cheapest training signal there is being thrown
away — a confirmed match is a person asserting the identity the description rule
is guessing at.

What gets remembered is the **counterparty**, not the transaction. Transactions
never repeat; counterparties do. Anything carrying a digit is a reference, a
terminal id or a date, so it goes, and what is left is the name — stable on both
sides, month after month.

```bash
tallyd learn -m memory.json -d decisions.json      # fold in what a reviewer decided
tallyd learn -m memory.json --show                 # read back what it thinks it knows
tallyd reconcile -l books.json -s statement.csv -m memory.json
```

```
$ tallyd learn -m memory.json --show
2 remembered pairings

bank           ledger           yes/no  last seen
BACS PAYROLL   NET PAY PAYROLL  1/0     2026-04-30
PROPERTY RENT  MONTHLY RENT     1/0     2026-04-30
```

The file is plain JSON of exactly that, which is deliberate. A memory nobody can
read is a memory nobody can correct, and being able to open it and delete a line
is the difference between a tool that learns and a tool that quietly drifts.

Three things are worth remembering, not one. A **confirmation** is evidence for.
A **rejection** is evidence against, and outweighs a confirmation of the same
pairing — proposing a pair a reviewer already refused is worse than proposing
nothing, because it teaches them the queue is not worth reading. And a bank name
seen before but only ever confirmed against a *different* ledger counterparty is
evidence against too, which is the case that absence-of-memory would silently
score as neutral.

Measured on generated books — trained on one four-month period, then run against
a different one with the same cast of customers and suppliers:

| | auto-accepted | review queue | precision | recall |
|---|---|---|---|---|
| cold | 62 | 16 | 100% | 75.6% |
| with memory | 73 | 5 | 100% | 89.0% |

Eleven more matches went through unattended, the queue shrank by 69%, and not
one of the extra matches was wrong. Precision is the number that makes the rest
of the table mean anything: auto-accepting more is only an improvement if the
extra ones are right.

### What memory is not allowed to do

It never overrides a gate. A remembered counterparty does not make a £40
discrepancy acceptable, does not reconcile a debit against a credit, and does not
pull a pair back inside the date window. It is weighted level with description —
a reviewer's assertion should not count for less than the wording guess it
replaces — and no higher, because it is evidence about *who*, not about *which
transaction*: two payments to the same supplier in one week are remembered
equally well. In practice it lifts a pair the numbers already agree on over the
auto-accept line, and it cannot carry a weak one there on its own.

It does get one veto. A pairing a reviewer has refused is denied the exact-match
floor that would otherwise restore its score to 0.95 whatever else was known.
Without that the refusal would change nothing, which is the one outcome
guaranteed to make somebody stop using the review queue.

With no memory supplied, scoring is exactly what it was before any of this
existed — the rule contributes nothing and is not averaged in, the same
treatment the reference rule gets when neither side carries one.

## Booking what the statement says happened

A reconciliation ends with statement lines the ledger has never heard of: the
bank charge nobody entered, the interest, the direct debit set up two years
ago, the card processor's cut. They are not matching failures — there is
genuinely nothing to match them against — and the reconciliation will not
balance until somebody books them. That somebody used to retype each one and
guess the account, and the guess was recorded nowhere.

```bash
tallyd post -l books.json -s statement.csv -a 1110              # what would be booked
tallyd post -l books.json -s statement.csv -a 1110 -o after.json  # and book it
```

```
$ tallyd post -l books.json -s statement.csv -a 1110

5 statement lines have no counterpart in the books

date        description                 amount  account  rule
2026-01-27  BACS SUPPLIER RUN 724262  -2053.00  —        unclassified
2026-02-03  ACCOUNT MAINTENANCE FEE      -1.64  5800     bank-charges
2026-02-26  BACS SUPPLIER RUN 178732  -4849.00  —        unclassified
2026-03-11  ACCOUNT MAINTENANCE FEE      -1.84  5800     bank-charges
2026-03-28  BACS SUPPLIER RUN 709648  -7151.00  —        unclassified

2 to book, 0 skipped, 0 already in the ledger, 3 unclassified
Net effect on the bank account: -3.48

  5800         -3.48  (2 lines)
```

Three refusals shape this, and they are the interesting part.

**It proposes; it does not post.** Every proposal carries the statement line it
came from, the rule that classified it, and a balanced entry. `--out` is a
separate thing to ask for.

**It never invents an account.** A line no rule matches comes back
unclassified — the three supplier runs above — rather than being swept into a
suspense account the chart does not have. That is how a chart of accounts rots:
the account appears, everything awkward goes in it, and nobody ever empties it.
`--suspense 1120` names an existing account and takes responsibility for it;
`--strict` turns anything left unclassified into exit code 2, which is what a
pipeline wants.

**Posting the same statement twice is a no-op.** Entry ids are derived from the
statement line's fingerprint — date, amount, normalised description — so the
same line always implies the same id, and an id already in the ledger is
reported as already booked rather than posted again. Overlapping exports are
the normal case, not an edge case. In practice the second run does not even get
that far: the entries posted on the first run now *match* those lines, so they
never reach the proposal stage.

Classification is an ordered rule list, and the order is load-bearing.
`INTEREST` outbound is a cost of borrowing and `INTEREST` inbound is income, so
direction is part of the test, not an afterthought. Opening balance lines are
skipped before anything can read them as a receipt — the bank telling you where
it thinks you started is not a transaction. The rules are plain JSON and
`--rules` replaces them wholesale, because a chart that is not this chart needs
its own.

### What the reviewer's decisions have to do with it

Only lines with *no* suggestion are proposed. A line sitting in the review queue
has a ledger counterpart the matcher believes in, and booking a second entry for
it would double-count the transaction. Undecided means unproposed: a missed
entry is a reconciliation that does not balance, and a duplicated entry is a
reconciliation that balances and is wrong.

A rejection changes that. `tallyd post -d decisions.json` reads the file the
dashboard exports, and a suggestion whose every description pair the reviewer
refused is treated as no suggestion at all — its statement lines join the ones
needing entries. A batch where only one of four suppliers was refused stays
where it is; part of it is still something the books know about.

The dashboard shows the same thing under *What this implies*, and recomputes it
as you work: rejecting a suggestion adds a row in the same gesture that pushes
its lines back into the leftovers. Every statement line carries a precomputed
proposal for exactly this reason — the browser cannot classify anything, so the
classification has to be there before it is needed.

## Rates

Everything above holds one currency at a time. A business that invoices in euros
and banks in sterling needs somewhere for a price to come from, and it has to be
as exact as the rest of the money path — so a rate is a pair of bigints, not a
float. `0.8473` as an IEEE-754 double is `0.847300000000000053290705182007513940334320068359375`,
and that error compounds through an inversion, a triangulation and a
multiplication before landing in a revaluation entry where it looks like a real
gain.

```bash
tallyd rates -r ecb.csv -b EUR                       # what the table holds
tallyd rates -r ecb.csv -b EUR -p EUR/GBP --on 2026-03-15
tallyd rates -r ecb.csv -b EUR -p USD/GBP --amount 5000.00
tallyd rates -r ecb.csv -b EUR -p EUR/GBP --average 2026-03-01:2026-03-31
```

Rate files are sparse in three ways at once and a lookup has to survive all
three. Sparse in **time**: rates are published on business days and asked for on
any day, so lookup is on-or-before with a bound on staleness — a payment dated
Sunday takes Friday's close, and a quote from four hundred days ago is not an
answer. Sparse in **direction**: a file quoting EUR/GBP answers GBP/EUR by
inversion. Sparse in **pairs**: a file quoting everything against the euro
answers USD/GBP by going through it, found by a breadth-first walk so the answer
uses the fewest legs available and ties break deterministically.

Every answer carries how it was reached:

```
1 USD = 0.781858 GBP on 2026-03-14
  via USD -> EUR -> GBP, quotes 2026-03-13, 2026-03-13
  1 day behind the date asked for
  source: ecb.csv
```

A triangulated rate composes exactly and rounds once, at the end. Converting leg
by leg does not: 0.01 EUR through two rates of 1.5 gives 0.03 stepwise and 0.02
composed, and 0.0225 is the true answer.

Two readers, because rates arrive in two shapes. The JSON document is
canonical — versioned, explicit about direction, carrying its own staleness
bound. The CSV reader handles what actually comes out of a provider: a wide
table, one row per date, one column per currency, with blank cells for the days
that market was shut.

Period averages come in two kinds, because "the average rate for March" means
two different things. `--method quoted` averages the quotes that were published,
which under-weights days a market was closed. `--method daily` (the default)
averages one rate per calendar day, carrying the last close forward over
weekends — which is what a monthly translation wants. Both are exact means of
rationals, reduced at each step, so a year of daily quotes averages to the same
value whatever order they arrive in.

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

And booking what is left over takes two more:

```ts
import { linesNeedingEntries, proposeEntries, applyProposals } from "tallyd";

const proposals = proposeEntries(linesNeedingEntries(result, memory), {
  account: "1110",
  ledger,             // so a line already booked is skipped rather than duplicated
});

proposals.filter((p) => p.outcome === "unclassified");  // still a person's problem
const booked = applyProposals(ledger, proposals);
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

**The dashboard does arithmetic in integer minor units, in the browser.** Every
amount crosses into the page twice: once as a decimal string to display, once as
a count of minor units to add up. Recomputing the bridge from formatted strings —
or from floats parsed out of them — is how a reconciliation ends up out by a
penny in the one place a penny matters. The test suite runs the client's bridge
arithmetic over the embedded data for every possible subset of accept decisions
and asserts the difference is exactly zero each time, so a page that would open
showing a discrepancy fails in CI rather than in front of a user.

**Charts are drawn by hand, and positioned by date.** Two charts do not justify
shipping a charting engine inside a bookkeeping report, and a library would break
the single-file promise. The cash position line places points by calendar date
rather than by index — spacing ten movements evenly across a month draws a
three-day gap and a thirteen-day gap the same width, which is a lie about the one
axis the chart exists to show.

## Licence

MIT
