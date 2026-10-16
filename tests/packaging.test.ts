/**
 * What `npm publish` would actually ship.
 *
 * The suite exercises the library through the source tree, which is exactly
 * the view that cannot see a packaging mistake: the entry points, the file
 * list and the executable's shebang are all invisible to it. Three real
 * defects lived in this repository behind a green suite — `bin` pointed at a
 * path the build did not produce, the build emitted the compiled test suite
 * into `dist`, and the executable had no shebang, so it would have been
 * handed to the shell rather than to node.
 *
 * So these tests read the manifest and ask `npm pack` what the tarball
 * contains. `npm pack --dry-run` runs the `prepack` hook, which means the
 * answers are about a freshly built `dist` rather than whatever happened to
 * be lying around.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly main: string;
  readonly types: string;
  readonly bin: Record<string, string>;
  readonly files: readonly string[];
  readonly engines: Record<string, string>;
  readonly repository: { readonly type: string; readonly url: string };
  readonly exports: Record<string, Record<string, string>>;
  readonly scripts: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as Manifest;

interface Packed {
  readonly name: string;
  readonly version: string;
  readonly entryCount: number;
  readonly files: readonly { readonly path: string }[];
}

/** Ask npm what it would ship. Slow — one process — so it is computed once. */
const packed: Packed = (() => {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--silent"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return (JSON.parse(output) as readonly Packed[])[0]!;
})();

const shipped = new Set(packed.files.map((file) => file.path));

describe("the manifest", () => {
  it("declares an entry point for every way in", () => {
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.exports["."]!["import"]).toBe("./dist/index.js");
    expect(manifest.exports["."]!["types"]).toBe("./dist/index.d.ts");
  });

  it("builds before it packs, not only before it publishes", () => {
    // prepublishOnly would leave `npm pack` free to tar up a stale dist,
    // which is how the missing shebang reached an installed tarball while
    // the local build that was tested predated it.
    expect(manifest.scripts["prepack"]).toBe("npm run build");
    expect(manifest.scripts["build"]).toBe("tsc -p tsconfig.build.json");
  });

  it("points the repository at this repository, exactly", () => {
    // npm trusted publishing compares this against the workflow's repository
    // and refuses the publish if they differ.
    expect(manifest.repository.url).toBe(
      "git+https://github.com/DaniyalMlk/tallyd.git",
    );
  });

  it("claims a licence the repository actually carries", () => {
    expect(manifest.license).toBe("MIT");
    const licence = readFileSync(resolve(root, "LICENSE"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("Copyright (c) 2026 Daniyal");
  });

  it("names a Node floor that supports the build it ships", () => {
    // The build targets ES2022 and emits ESM, so the floor is a Node that
    // runs both without flags.
    expect(manifest.engines["node"]).toBe(">=20.19.0");
  });
});

describe("the tarball", () => {
  it("is this package at this version", () => {
    expect(packed.name).toBe(manifest.name);
    expect(packed.version).toBe(manifest.version);
  });

  it("carries both entry points", () => {
    expect(shipped).toContain("dist/index.js");
    expect(shipped).toContain("dist/index.d.ts");
    expect(shipped).toContain("dist/cli/main.js");
  });

  it("carries the executable the bin entry names", () => {
    for (const target of Object.values(manifest.bin)) {
      expect(shipped).toContain(target);
    }
  });

  it("carries the generator the CLI imports", () => {
    // src/cli/run.ts imports it, so `tallyd generate` is broken without it.
    // It lives under src/demo, which reads like something a package would
    // exclude.
    expect(shipped).toContain("dist/demo/generator.js");
  });

  it("carries the licence and the readme", () => {
    expect(shipped).toContain("LICENSE");
    expect(shipped).toContain("README.md");
  });

  it("carries no tests", () => {
    const tests = [...shipped].filter(
      (path) => /(^|\/)tests?\//.test(path) || /\.(test|spec)\./.test(path),
    );
    expect(tests).toEqual([]);
  });

  it("carries no TypeScript sources and no build configuration", () => {
    // Declarations are the point of `types` and do ship, so the filter has to
    // exclude `.d.ts` rather than everything ending in `.ts`. Writing it the
    // obvious way flags all 102 declaration files as leaked sources.
    const leaked = [...shipped].filter(
      (path) =>
        path.startsWith("src/") ||
        (path.endsWith(".ts") && !path.endsWith(".d.ts")) ||
        path.startsWith("tsconfig"),
    );
    expect(leaked).toEqual([]);
  });

  it("carries declarations beside the code they describe", () => {
    const declarations = [...shipped].filter((path) => path.endsWith(".d.ts"));
    expect(declarations.length).toBeGreaterThan(50);
    for (const declaration of declarations) {
      expect(shipped).toContain(declaration.replace(/\.d\.ts$/, ".js"));
    }
  });

  it("ships nothing from outside dist but the two metadata files", () => {
    const stray = [...shipped].filter(
      (path) =>
        !path.startsWith("dist/") &&
        !["package.json", "README.md", "LICENSE"].includes(path),
    );
    expect(stray).toEqual([]);
  });
});

describe("the executable", () => {
  it("starts with a shebang in the built output", () => {
    // Without it the file is handed to the shell, which reads the first
    // import statement as a command. Asserted on the build rather than on
    // the source, since the build is what gets installed.
    const built = readFileSync(resolve(root, "dist/cli/main.js"), "utf8");
    expect(built.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs from the built output and prints its usage", () => {
    const printed = execFileSync(
      process.execPath,
      [resolve(root, "dist/cli/main.js"), "--help"],
      { encoding: "utf8" },
    );
    expect(printed).toContain("Usage: tallyd <command>");
    expect(printed).toContain("reconcile");
  });
});
