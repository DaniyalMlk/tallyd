/**
 * Every documented option, and whether anything ever sets it.
 *
 * An optional property with a default is a claim: that the caller may choose,
 * and that choosing works. A property nothing anywhere supplies has never had
 * that claim tested. The code reading it runs — it is covered, and coverage
 * says so — but only ever with the one value the author happened to pick, and
 * the branch where the caller picks something else has never executed.
 *
 * That turns out to be where defects sit. Running this probe over this
 * repository by hand found six such properties and three of them were wrong:
 * a chart size with no validation that drew invalid SVG, a decimal convention
 * that could contradict the file by a factor of a hundred in silence, and a
 * field whose name said the opposite of the one template it fed. None of the
 * three was reachable from any test, because setting the option is what
 * reveals them.
 *
 * So the probe is a gate rather than a habit. It parses the source, collects
 * the optional properties of every exported interface and type literal, and
 * requires each to be assigned somewhere — in the library, a test, or the docs
 * generator. A new option that arrives undocumented by use fails here.
 *
 * Exported declarations only. An optional field on a type a module keeps to
 * itself is a shape rather than an offer: `confidenceChart` takes its width on
 * an inline type and nobody outside that file is being invited to set it.
 * (That one got the guard anyway, because it had the same arithmetic as the
 * chart that was flagged. The gate decides what must be exercised, not what
 * may be fixed.)
 *
 * An assignment inside the declaring file does not count on its own: that is
 * usually the default being written down rather than a caller choosing.
 *
 * There are no exemptions and the gate has no way to grant one. Adding that
 * machinery is the first thing that will be wanted the next time this fails,
 * and it is the wrong thing: an option nobody can be bothered to choose once
 * in a test is an option to delete.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH = ["src", "tests", "docs"];

function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "site") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (extname(path) === ".ts") found.push(path);
    }
  };
  for (const directory of SEARCH) walk(join(ROOT, directory));
  return found;
}

interface Declared {
  readonly type: string;
  readonly property: string;
  readonly file: string;
}

function survey(): { declared: Declared[]; assigned: Map<string, Set<string>> } {
  const declared: Declared[] = [];
  const assigned = new Map<string, Set<string>>();

  const optionals = (
    members: ts.NodeArray<ts.TypeElement>,
    type: string,
    file: string,
  ): void => {
    for (const member of members) {
      if (
        ts.isPropertySignature(member) &&
        member.questionToken !== undefined &&
        member.name !== undefined &&
        ts.isIdentifier(member.name)
      ) {
        declared.push({ type, property: member.name.text, file });
      }
    }
  };

  for (const file of sources()) {
    const tree = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const visit = (node: ts.Node): void => {
      const exported =
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
          true;
      if (ts.isInterfaceDeclaration(node) && exported) {
        optionals(node.members, node.name.text, file);
      }
      if (ts.isTypeAliasDeclaration(node) && exported && ts.isTypeLiteralNode(node.type)) {
        optionals(node.type.members, node.name.text, file);
      }
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        if (ts.isIdentifier(node.name)) {
          const files = assigned.get(node.name.text) ?? new Set<string>();
          files.add(file);
          assigned.set(node.name.text, files);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return { declared, assigned };
}

const { declared, assigned } = survey();

/**
 * Whether anything outside the declaring file ever sets this property.
 *
 * Named and exported to the test below rather than inlined, because the
 * interesting half of it — discounting an assignment made only inside the file
 * that declares the property — is not exercised by the current source. Every
 * option here is either set by a caller or set nowhere, so loosening this to
 * "assigned anywhere" would pass over today's tree and the rule would be
 * carried untested until the day it mattered. So it is tested directly,
 * against a map built for the purpose.
 */
function exercisedElsewhere(entry: Declared, where: ReadonlyMap<string, Set<string>>): boolean {
  const files = where.get(entry.property);
  if (files === undefined) return false;
  return [...files].some((file) => file !== entry.file);
}

describe("every documented option is exercised somewhere", () => {
  it("surveyed the source it claims to have surveyed", () => {
    // A gate of the form "nothing is unexercised" passes trivially over an
    // empty survey, so the survey is asserted before the gate runs: enough
    // files, enough optional properties, and four that are certainly there.
    expect(sources().length).toBeGreaterThan(150);
    expect(declared.length).toBeGreaterThan(180);
    const names = new Set(declared.map((entry) => `${entry.type}.${entry.property}`));
    for (const certain of [
      "ChartOptions.width",
      "ImportOptions.decimal",
      "ProposalOptions.rules",
      "BalanceSheetOptions.retainedEarningsAccount",
    ]) {
      expect(names).toContain(certain);
    }
    // And that assignments are being seen at all, across more than one file,
    // since a survey that found none would pass the gate below by finding
    // everything unexercised and nothing to compare it against.
    expect(assigned.get("includeZero")?.size).toBeGreaterThan(4);
    expect(assigned.get("rules")?.size).toBeGreaterThan(1);
    expect(assigned.get("decimal")?.size).toBeGreaterThan(1);
  });

  it("discounts an assignment made only inside the declaring file", () => {
    // The default being written down is not a caller choosing. Asserted
    // against a constructed map, because no option in the tree is currently
    // in that state: loosening the rule to "assigned anywhere" passes over
    // today's source, so nothing here would notice.
    const entry: Declared = { type: "Opts", property: "span", file: "/src/thing.ts" };
    expect(exercisedElsewhere(entry, new Map())).toBe(false);
    expect(exercisedElsewhere(entry, new Map([["span", new Set(["/src/thing.ts"])]]))).toBe(false);
    expect(
      exercisedElsewhere(entry, new Map([["span", new Set(["/src/thing.ts", "/tests/a.test.ts"])]])),
    ).toBe(true);
    expect(exercisedElsewhere(entry, new Map([["span", new Set(["/tests/a.test.ts"])]]))).toBe(true);
    // And a different property's assignments are not this one's.
    expect(exercisedElsewhere(entry, new Map([["other", new Set(["/tests/a.test.ts"])]]))).toBe(
      false,
    );
  });

  it("leaves no optional property only ever at its default", () => {
    const unexercised = declared
      .filter((entry) => !exercisedElsewhere(entry, assigned))
      .map((entry) => `${entry.type}.${entry.property}`);
    expect([...new Set(unexercised)].sort()).toEqual([]);
  });
});
