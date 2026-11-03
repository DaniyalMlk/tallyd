/**
 * The roadmap's known gaps, and whether each one is still a gap.
 *
 * What an engine does *not* do is harder to find out than what it does, and
 * reading the tests will not tell you: a suite says nothing about the cases
 * nobody wrote. So the roadmap carries the list, and this file pairs every
 * line of it with a predicate over the package's own surface.
 *
 * The failure mode worth guarding against is not an incomplete list but a
 * stale one. A line saying something is missing after it has been built is
 * worse than no line at all, because it is believed — and three of this
 * list's thirty-four lines turned out to be exactly that when the predicates
 * were written:
 *
 * - the suite size "nothing recomputes", which `tests/docs.test.ts` had
 *   already been pinning in three directions;
 * - the translation adjustment "never posted", with "no reserve account for
 *   it and no entry", while `GROUP_ACCOUNTS.translationReserve` is 3250, is
 *   declared in `CONSOLIDATION_ACCOUNTS`, and is posted to twice in
 *   `consolidate`;
 * - unrealised profit on intragroup stock "not eliminated", leaving
 *   "consolidated stock carried at what the group charged itself", when
 *   `intragroupStock` provides for it and takes the stock down by the whole
 *   margin.
 *
 * All three came out. The gate fails five ways so that the next one cannot
 * last as long: a line with no predicate, a predicate with no line, the list
 * shrinking, a bullet going thin, and a predicate that no longer holds because
 * the thing it says is missing has been built. Closing a gap therefore breaks
 * this file, which is the point — the line has to be removed deliberately
 * rather than left behind.
 *
 * Most predicates are deliberately crude. They ask whether anything in the
 * surface is *named* for the missing thing, which is a weaker question than
 * whether it is modelled, and weaker in the safe direction: a name can appear
 * without the behaviour, and then the line comes out and is replaced by
 * something sharper. What cannot happen is the behaviour appearing while the
 * line stays.
 *
 * Two traps that shaped the crude ones. The inventory is built by parsing
 * rather than grepping, because this repository's comments discuss most of
 * what it does not do and a grep-backed predicate reads those paragraphs as
 * the feature arriving. And a bare word matches inside longer words: `/vat/i`
 * over the names finds `observations`, and `vat` itself is a field on a demo
 * invoice fixture rather than anything the posting engine applies. So the
 * patterns are anchored, and where a crude question would be the wrong one
 * the predicate reads a declaration instead — the members of one interface,
 * or the arms of one union.
 *
 * There is no exemption mechanism, deliberately.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROADMAP = join(ROOT, "ROADMAP.md");

function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (extname(path) === ".ts") found.push(path);
    }
  };
  walk(join(ROOT, "src"));
  return found;
}

interface Surface {
  /** Every name the source declares, at any nesting depth. */
  readonly names: ReadonlySet<string>;
  /** The property and method names of each interface, by interface name. */
  readonly members: ReadonlyMap<string, ReadonlySet<string>>;
  /** The string-literal arms of each union type alias, by alias name. */
  readonly unions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Deliberately inclusive: declarations at any depth, exported or not,
 * including locals and parameters. An over-wide inventory errs towards finding
 * a name and so towards failing — which forces a line out and a human to look
 * — while a narrow one would quietly keep a line that had stopped being true.
 */
function surface(): Surface {
  const names = new Set<string>();
  const members = new Map<string, Set<string>>();
  const unions = new Map<string, Set<string>>();

  const memberNames = (nodes: ts.NodeArray<ts.TypeElement>): Set<string> => {
    const found = new Set<string>();
    for (const member of nodes) {
      if (
        (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
        member.name !== undefined &&
        ts.isIdentifier(member.name)
      ) {
        found.add(member.name.text);
      }
    }
    return found;
  };

  for (const file of sources()) {
    const tree = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.parent !== undefined) {
        const parent = node.parent;
        const declares =
          (ts.isInterfaceDeclaration(parent) ||
            ts.isTypeAliasDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isEnumDeclaration(parent) ||
            ts.isEnumMember(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isMethodSignature(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isShorthandPropertyAssignment(parent)) &&
          parent.name === node;
        if (declares) names.add(node.text);
      }
      if (ts.isInterfaceDeclaration(node)) {
        const found = members.get(node.name.text) ?? new Set<string>();
        for (const name of memberNames(node.members)) found.add(name);
        members.set(node.name.text, found);
      }
      if (ts.isTypeAliasDeclaration(node)) {
        if (ts.isTypeLiteralNode(node.type)) {
          const found = members.get(node.name.text) ?? new Set<string>();
          for (const name of memberNames(node.type.members)) found.add(name);
          members.set(node.name.text, found);
        }
        if (ts.isUnionTypeNode(node.type)) {
          const arms = new Set<string>();
          for (const arm of node.type.types) {
            if (ts.isLiteralTypeNode(arm) && ts.isStringLiteral(arm.literal)) {
              arms.add(arm.literal.text);
            }
          }
          if (arms.size > 0) unions.set(node.name.text, arms);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return { names, members, unions };
}

const SURFACE = surface();

/** True while nothing the source declares is named for `pattern`. */
function nothingNamed(pattern: RegExp): boolean {
  for (const name of SURFACE.names) if (pattern.test(name)) return false;
  return true;
}

/** The members of one interface, which must exist. */
function membersOf(type: string): ReadonlySet<string> {
  const found = SURFACE.members.get(type);
  if (found === undefined) throw new Error(`known-gaps: no interface named ${type}`);
  return found;
}

/** True while no member of `type` is named for `pattern`. */
function noMemberNamed(type: string, pattern: RegExp): boolean {
  for (const name of membersOf(type)) if (pattern.test(name)) return false;
  return true;
}

/** True while the source declares something named exactly `name`. */
const declares = (name: string): boolean => SURFACE.names.has(name);

interface Gap {
  /** The bolded lead of the roadmap bullet, exactly as written. */
  readonly heading: string;
  /** True while the gap is still a gap. */
  readonly stillOpen: () => boolean;
}

const GAPS: readonly Gap[] = [
  {
    heading: "The classification rules are a starting point, not a claim about anybody's business.",
    // Nothing derives a rule from data: the shipped set is written down, and a
    // different business supplies its own through `--rules`.
    stillOpen: () => nothingNamed(/^(learn|infer|derive|suggest)Rules?$|^ruleSuggestion/i),
  },
  {
    heading: "A line the matcher merely failed to match looks exactly like a line the books are missing.",
    // The outcomes a proposal can carry. Four arms, and none of them means
    // "this probably had a counterpart that the matcher missed".
    stillOpen: () => {
      const arms = SURFACE.unions.get("ProposalOutcome");
      return (
        arms !== undefined &&
        arms.size === 4 &&
        ["book", "skip", "unclassified", "already-booked"].every((arm) => arms.has(arm))
      );
    },
  },
  {
    heading: "Nothing learns from a classification.",
    // There is a counterparty memory and no equivalent for accounts: the
    // memory's entries key statement text to book text, never to a code.
    stillOpen: () =>
      noMemberNamed("MemoryEntry", /account/i) &&
      nothingNamed(/^(account|classification)Memory$|^recallAccount$/i),
  },
  {
    heading: "Proposed entries carry no VAT treatment.",
    // Neither the rule nor the proposal it produces has anywhere to put one.
    // `vat` does appear in the surface — as a field on a demo invoice fixture
    // — which is why this reads the two declarations that would have to carry
    // it rather than searching for the word.
    stillOpen: () =>
      noMemberNamed("PostingRule", /vat|tax/i) && noMemberNamed("Proposal", /vat|tax/i),
  },
  {
    heading: "The dashboard embeds every posting in the file.",
    stillOpen: () => nothingNamed(/^paginat|^lazyLoad|^virtualis|^pageOf$/i),
  },
  {
    heading: "The CLI reads a whole ledger into memory on every invocation.",
    stillOpen: () => nothingNamed(/^streamLedger$|^ledgerCache$|^ledgerIndex$|^incremental/i),
  },
  {
    heading: "Ageing groups by reference alone.",
    // No counterparty dimension on the options or on the report.
    stillOpen: () =>
      noMemberNamed("AgeingOptions", /counterparty|customer|supplier/i) &&
      noMemberNamed("Ageing", /counterparty|customer|supplier/i),
  },
  {
    heading: "The dashboard knows nothing about foreign currency.",
    // It is handed one account's books and one statement, and no rates.
    stillOpen: () => noMemberNamed("DashboardInput", /rates?$|revaluation|exposure/i),
  },
  {
    heading: "Translation restates the trial balance, not the statements.",
    // The statement renderers take no translation input of any kind.
    stillOpen: () =>
      noMemberNamed("BalanceSheetOptions", /translat|present|rates?$/i) &&
      nothingNamed(/^translatedBalanceSheet$|^translatedIncomeStatement$/i),
  },
  {
    heading: "A statement in a foreign currency cannot be reconciled.",
    stillOpen: () => noMemberNamed("ReconciliationOptions", /rates?$|currenc/i),
  },
  {
    heading: "The revaluation reads the whole ledger to find its open items, once per run.",
    stillOpen: () => nothingNamed(/^openItemIndex$|^revaluationCache$/i),
  },
  {
    heading: "Memory is keyed on the counterparty name and nothing else.",
    // The key is derived from text, and an entry holds the two keys and the
    // verdicts — no identifier, no account, nothing that survives a rename.
    stillOpen: () =>
      declares("counterpartyKey") &&
      [...membersOf("MemoryEntry")].every((name) =>
        ["bookKey", "statementKey", "confirmed", "rejected", "lastSeen"].includes(name),
      ),
  },
  {
    heading: "Memory never ages.",
    // `lastSeen` is recorded, and nothing weighs anything by it.
    stillOpen: () => declares("lastSeen") && nothingNamed(/^decay|halfLife|^recency/i),
  },
  {
    heading: "Group matching is capped at four lines a side and never mixes directions.",
    stillOpen: () => declares("maxGroupSize") && nothingNamed(/^mixedDirection|^crossDirection/i),
  },
  {
    heading: "The generator models one business shape.",
    // Its options choose the size of that shape, never a different one.
    stillOpen: () => noMemberNamed("GeneratorOptions", /shape|profile|scenario|group|foreign/i),
  },
  {
    heading: "An associate is identified and then left alone.",
    // `associates()` exists on the structure and nothing downstream consumes
    // it: a consolidation carries no associate anywhere in its result.
    //
    // The first draft of this predicate searched for `/^shareOfResult/` among
    // the names, on the reasoning that equity accounting takes a share of an
    // associate's result. It found one — the *outside stake's* share of the
    // result, in the non-controlling interest's movement schedule, which has
    // nothing to do with associates. A crude pattern is safe in the direction
    // of failing, and this is what that looks like from the inside.
    stillOpen: () =>
      declares("associates") &&
      noMemberNamed("Consolidation", /associate/i) &&
      nothingNamed(/^equityAccount|^equityMethod|^associateShare|^investmentInAssociate/i),
  },
  {
    heading: "An impairment is declared, never computed.",
    // What follows from one is modelled; deciding there should be one is not,
    // because a recoverable amount is a forecast and this engine holds none.
    stillOpen: () =>
      declares("goodwillImpairment") &&
      nothingNamed(/^recoverableAmount$|^valueInUse$|^impairmentTest$/i),
  },
  {
    heading: "A partly-recognised impairment is not grossed up where the outside stake was measured proportionately.",
    stillOpen: () => nothingNamed(/grossUp|grossedUp/i),
  },
  {
    heading: "Fair value adjustments can only be given as a single figure for the net assets acquired.",
    // One figure on the way in, so there is no asset to depreciate afterwards.
    stillOpen: () =>
      membersOf("AcquisitionInput").has("netAssetsAtAcquisition") &&
      noMemberNamed("AcquisitionInput", /fairValueAdjust|uplift|byAsset/i) &&
      nothingNamed(/^fairValueAdjustment$|^depreciateUplift$/i),
  },
  {
    heading: "Indirect holdings use the direct method.",
    stillOpen: () => nothingNamed(/^indirectMethod$|^scaledCost$|^effectiveCost$/i),
  },
  {
    heading: "Nothing verifies that an entity's books were closed at the start of the reporting period.",
    // The fix exists and the caller has to ask for it.
    stillOpen: () =>
      declares("withResultClosed") && nothingNamed(/^verifyClosed$|^assertClosed$|^openingClosed$/i),
  },
  {
    heading: "The translation reserve is not recycled on the sale of a foreign operation.",
    stillOpen: () => nothingNamed(/recycl/i),
  },
  {
    heading: "A partial disposal cannot be expressed.",
    // A disposal names what went and what came in, and has nowhere to put a
    // retained interest or the fair value it would be measured at.
    stillOpen: () =>
      noMemberNamed("DisposalInput", /retained|remaining|^holding$|fairValue/i) &&
      nothingNamed(/^partialDisposal$|^retainedInterest$/i),
  },
  {
    heading: "A disposal's declared proceeds and the holder's own books are reconciled only after the fact.",
    stillOpen: () => declares("disposalResidual") && nothingNamed(/^refuseDisposal$|^proceedsMismatch/i),
  },
  {
    heading: "A disposal assumes the holder has already derecognised the investment.",
    stillOpen: () => declares("investmentResidual"),
  },
  {
    heading: "The movement schedules name the outside stake's removal on a disposal and stop there.",
    stillOpen: () => nothingNamed(/^disposalSchedule$|^disposalMovement$/i),
  },
  {
    heading: "Books that have never been closed to reserves hand the group every year's profit at once.",
    stillOpen: () => declares("withResultClosed") && nothingNamed(/^detectUnclosed$|^inferPeriodBoundary$/i),
  },
  {
    heading: "The pre-acquisition result is computed and reported but never translated.",
    stillOpen: () =>
      declares("preAcquisitionResult") && nothingNamed(/^preAcquisitionTranslated$|^translatedPreAcquisition$/i),
  },
  {
    heading: "The movement schedules explain three things and nothing else.",
    // The comparative consolidation carries a schedule for the outside stake,
    // the translation reserve and goodwill. Reserves are the conspicuous
    // absence, and this is the sharpest form of the line: the three are
    // there, a fourth is not.
    stillOpen: () => {
      const members = membersOf("ComparativeConsolidation");
      return (
        ["nci", "translationReserve", "goodwill"].every((name) => members.has(name)) &&
        noMemberNamed("ComparativeConsolidation", /^reserves|Schedule$/i)
      );
    },
  },
  {
    heading: "The dashboard knows nothing about groups.",
    stillOpen: () => noMemberNamed("DashboardInput", /group|consolidat|entit/i),
  },
  {
    heading: "The matcher still holds both sides in memory.",
    stillOpen: () => nothingNamed(/^streamMatch|^incrementalReconcile$/i),
  },
];

/** The bolded lead and the body of every bullet in the roadmap's gaps section. */
function bullets(): { heading: string; body: string }[] {
  const text = readFileSync(ROADMAP, "utf8");
  const section = /\n## Known gaps\n([\s\S]*?)(?=\n## |$)/.exec(text);
  expect(section, "the roadmap has no known-gaps section").not.toBeNull();
  const found: { heading: string; body: string }[] = [];
  for (const chunk of (section?.[1] ?? "").split(/\n(?=- \*\*)/)) {
    const bullet = /^- \*\*(.+?)\*\*([\s\S]*)$/.exec(chunk.trim());
    if (bullet === null) continue;
    found.push({ heading: bullet[1] ?? "", body: (bullet[2] ?? "").trim() });
  }
  return found;
}

describe("the known-gaps list", () => {
  it("surveyed the source it claims to have surveyed", () => {
    // Every predicate of the form "nothing is named X" passes trivially over
    // an empty inventory, so the inventory is asserted before any of them
    // runs: enough files, enough names, and a handful that are certainly
    // there, including one each of the three shapes the predicates read.
    expect(sources().length).toBeGreaterThan(90);
    expect(SURFACE.names.size).toBeGreaterThan(1800);
    for (const certain of ["withResultClosed", "lastSeen", "maxGroupSize", "disposalResidual"]) {
      expect(SURFACE.names).toContain(certain);
    }
    expect(nothingNamed(/^withResultClosed$/)).toBe(false);
    expect(SURFACE.unions.get("ProposalOutcome")).toBeDefined();
    expect(membersOf("MemoryEntry").size).toBe(5);
    expect(() => membersOf("NoSuchInterface")).toThrow(/no interface named/);
  });

  it("is in the roadmap, in this order", () => {
    expect(bullets().map((entry) => entry.heading)).toEqual(GAPS.map((gap) => gap.heading));
  });

  it("has not quietly shrunk", () => {
    expect(GAPS).toHaveLength(31);
  });

  it("says what each gap costs, rather than only naming it", () => {
    // A bullet reduced to its lead is a list entry, not a disclosure: the lead
    // says what is absent and the body has to say what that means for somebody
    // who assumed otherwise.
    for (const entry of bullets()) {
      expect(entry.body.length, `the bullet "${entry.heading}" has gone thin`).toBeGreaterThan(90);
    }
  });

  it("is still true of every line", () => {
    const closed = GAPS.filter((gap) => !gap.stillOpen()).map((gap) => gap.heading);
    expect(
      closed,
      "these gaps look closed; take the lines out of the roadmap and the entries out of this table",
    ).toEqual([]);
  });
});
