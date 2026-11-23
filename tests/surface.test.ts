import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Every type a public signature mentions can be named from the package.
 *
 * Each area's barrel chooses what it exports, and a module exports a helper so
 * that a sibling can import it, which TypeScript requires and which does not
 * make the helper part of the package. So "every module export reaches the
 * root" would be the wrong rule here.
 *
 * The rule that is right is narrower. If the root exports a function, its
 * parameter and return types are part of the package whether or not anyone
 * meant them to be: a caller can pass the argument and receive the result,
 * and if the type is not exported they cannot write down what they hold.
 * `exports` in the manifest blocks a deep import, so there is no way round
 * it. Five such types were missing when this gate was written. The one that
 * mattered most was `GoodwillImpairment`: it is the element type of a field
 * of `ConsolidationOptions` and `DisposalOptions`, so anyone declaring an
 * impairment wrote a value whose type they could not name. The others were
 * `GoodwillCarrying`, `AcquiredAmount`, `DisposalWorking` and
 * `ImpliedEntryView`, each inside a result type the root did export.
 *
 * What counts as part of a declaration's surface: parameter, return and
 * type-parameter types, property and method types of interfaces and of
 * classes, the right-hand side of a type alias, a variable's annotation, and
 * a class's `extends` and `implements`. What does not: anything inside a
 * function body or a variable's initialiser, which is implementation, and a
 * class member marked `private` or named with `#`, which no caller can reach.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A type a root export mentions, the export, and where the type lives. */
export interface Unreachable {
  readonly type: string;
  readonly usedBy: string;
  readonly file: string;
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function isHidden(member: ts.Node): boolean {
  if (
    (ts.isPropertyDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)) &&
    ts.isPrivateIdentifier(member.name)
  ) {
    return true;
  }
  if (!ts.canHaveModifiers(member)) return false;
  return (ts.getModifiers(member) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
  );
}

/**
 * The types named by the root's exports that the root does not export.
 *
 * `owned` decides which declarations are the project's own: a type from the
 * standard library or a dependency is not this package's to export.
 */
export function unreachableTypes(
  program: ts.Program,
  entry: string,
  owned: (fileName: string) => boolean,
): Unreachable[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (source === undefined) throw new Error(`no source file ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${entry} is not a module`);

  const exported = checker.getExportsOfModule(moduleSymbol);
  const reachable = new Set(exported.map((symbol) => resolveAlias(checker, symbol)));
  const found = new Map<string, Unreachable>();

  const note = (name: ts.Node, usedBy: string): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol === undefined) return;
    const target = resolveAlias(checker, symbol);
    const declaration = target.declarations?.[0];
    if (declaration === undefined || reachable.has(target)) return;
    if (target.flags & ts.SymbolFlags.TypeParameter) return;
    const file = declaration.getSourceFile().fileName;
    if (!owned(file)) return;
    const key = `${target.name}\u0000${usedBy}`;
    if (!found.has(key)) found.set(key, { type: target.name, usedBy, file });
  };

  const walk = (node: ts.Node, usedBy: string): void => {
    if (ts.isBlock(node)) return;
    if (isHidden(node)) return;
    if (ts.isTypeReferenceNode(node)) note(node.typeName, usedBy);
    if (ts.isExpressionWithTypeArguments(node)) note(node.expression, usedBy);
    if (ts.isVariableDeclaration(node)) {
      // An annotation is the surface. Without one, a function initialiser's
      // signature is: `const f = (h: Hidden) => ...` takes a `Hidden` exactly
      // as `function f(h: Hidden)` does. Any other initialiser is
      // implementation, and its inferred type is not walked.
      if (node.type !== undefined) walk(node.type, usedBy);
      else if (
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        walk(node.initializer, usedBy);
      }
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      for (const child of [...(node.typeParameters ?? []), ...node.parameters]) {
        walk(child, usedBy);
      }
      if (node.type !== undefined) walk(node.type, usedBy);
      return;
    }
    if (ts.isParameter(node) || ts.isPropertyDeclaration(node)) {
      // A default value or an initialiser is implementation; the annotation
      // is the surface.
      if (node.type !== undefined) walk(node.type, usedBy);
      return;
    }
    ts.forEachChild(node, (child) => walk(child, usedBy));
  };

  for (const symbol of exported) {
    const target = resolveAlias(checker, symbol);
    for (const declaration of target.declarations ?? []) {
      if (!owned(declaration.getSourceFile().fileName)) continue;
      walk(declaration, symbol.name);
    }
  }

  return [...found.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.usedBy.localeCompare(b.usedBy),
  );
}

function programFor(entry: string): ts.Program {
  return ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
  });
}

describe("the package's public surface", () => {
  it("names every type its own exports mention", () => {
    const entry = join(ROOT, "src", "index.ts");
    const src = join(ROOT, "src") + "/";
    const missing = unreachableTypes(programFor(entry), entry, (file) =>
      resolve(file).startsWith(src),
    ).map(({ type, usedBy }) => `${type} (in ${usedBy})`);
    expect(missing).toEqual([]);
  });

  it("is read from a program that sees the whole of src", () => {
    // A probe that resolved nothing would report nothing, and pass.
    const entry = join(ROOT, "src", "index.ts");
    const program = programFor(entry);
    const checker = program.getTypeChecker();
    const exported = checker.getExportsOfModule(
      checker.getSymbolAtLocation(program.getSourceFile(entry)!)!,
    );
    expect(exported.length).toBeGreaterThan(400);
    expect(exported.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["consolidate", "Ledger", "dashboardData", "parseRules"]),
    );
  });
});

/**
 * The probe's own rules, against source written to exercise each one. The
 * package's source does not use every construct the probe has a branch for,
 * and a rule the real source never reaches is a rule nothing has tested.
 */
describe("the surface probe", () => {
  const dir = mkdtempSync(join(tmpdir(), "tallyd-surface-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let counter = 0;
  function probe(lib: string, index: string): string[] {
    counter += 1;
    const folder = join(dir, String(counter));
    const entry = join(folder, "index.ts");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "lib.ts"), lib);
    writeFileSync(entry, index);
    return unreachableTypes(programFor(entry), entry, (file) =>
      resolve(file).startsWith(folder + "/"),
    ).map(({ type, usedBy }) => `${type}<-${usedBy}`);
  }

  const types = `
    export interface Hidden { readonly n: number }
    export type Other = { readonly s: string };
    export class Base { readonly x = 1 }
    export interface Shape { area(): number }
  `;

  it.each([
    ["a parameter type", "export function f(h: Hidden): void {}", ["Hidden<-f"]],
    ["a return type", "export function f(): Hidden { return { n: 1 }; }", ["Hidden<-f"]],
    ["an interface field", "export interface R { readonly h: Hidden }", ["Hidden<-R"]],
    ["a union in a type alias", "export type R = Hidden | Other;", ["Hidden<-R", "Other<-R"]],
    ["a type argument", "export function f(h: readonly Hidden[]): Map<string, Other> { return new Map(); }", ["Hidden<-f", "Other<-f"]],
    ["a class's base", "export class C extends Base {}", ["Base<-C"]],
    ["an implemented interface", "export class C implements Shape { area() { return 1; } }", ["Shape<-C"]],
    ["a public method", "export class C { m(h: Hidden): void {} }", ["Hidden<-C"]],
    ["a protected member", "export class C { protected h?: Hidden }", ["Hidden<-C"]],
    ["a variable's annotation", "export const v: Hidden = { n: 1 };", ["Hidden<-v"]],
    ["an arrow function's parameter", "export const f = (h: Hidden): number => h.n;", ["Hidden<-f"]],
    ["a block-bodied arrow function's return", "export const f = (): Hidden => { return { n: 1 }; };", ["Hidden<-f"]],
    ["a type parameter's constraint", "export function f<T extends Hidden>(t: T): T { return t; }", ["Hidden<-f"]],
  ])("reports a type reached through %s", (_label, body, expected) => {
    expect(probe(types, `import type { Hidden, Other, Shape } from "./lib.js";\nimport { Base } from "./lib.js";\n${body}`)).toEqual(expected);
  });

  it.each([
    ["one used only in a function body", "export function f(): number { const h: Hidden = { n: 1 }; return h.n; }"],
    ["one used only in an initialiser", "export const v = ({ n: 1 } as Hidden).n;"],
    ["one used only in an arrow function's body", "export const f = (): number => ({ n: 1 } as Hidden).n;"],
    ["one used only in a default value", "export function f(n: number = ({ n: 1 } as Hidden).n): number { return n; }"],
    ["one on a private member", "export class C { private h?: Hidden }"],
    ["one on a #private member", "export class C { #h?: Hidden; get n(): number { return this.#h?.n ?? 0; } }"],
    ["one the entry exports", "export type { Hidden };\nexport function f(h: Hidden): void {}"],
    ["one from the standard library", "export function f(m: Map<string, Promise<number>>): void {}"],
    ["a type parameter itself", "export function f<T>(t: T): T { return t; }"],
  ])("ignores %s", (_label, body) => {
    expect(probe(types, `import type { Hidden } from "./lib.js";\n${body}`)).toEqual([]);
  });

  it("reports a type once per export that mentions it, however often", () => {
    expect(
      probe(types, `import type { Hidden } from "./lib.js";\nexport function f(a: Hidden, b: Hidden): Hidden { return a; }`),
    ).toEqual(["Hidden<-f"]);
  });

  it("follows a re-export to the declaration it names", () => {
    const found = probe(
      `${types}\nexport function g(h: Hidden): void {}`,
      `export { g } from "./lib.js";`,
    );
    expect(found).toEqual(["Hidden<-g"]);
  });
});
