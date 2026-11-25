/**
 * The command line against a real disk.
 *
 * Every other CLI test runs `run` against an in-memory environment, which
 * accepts any path at all. That is the right fixture for what a command
 * computes and the wrong one for where it writes: the first line on the front
 * page, `tallyd generate --out books`, failed with ENOENT on a real disk
 * because nothing created `books`, and no test could see it.
 *
 * So these drive the environment the executable itself uses, in a fresh
 * temporary directory, and the commands are read off the page that prints
 * them rather than retyped here.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeEnvironment, writeCreatingDirectory } from "../src/cli/environment.js";
import { run } from "../src/cli/run.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The commands the site's install section prints, without the `npx tallyd`. */
function firstMinuteCommands(siteSource: string): string[][] {
  const commands: string[][] = [];
  for (const match of siteSource.matchAll(/^(?:\s*<pre><code>)?npx \$\{esc\(PACKAGE\)\} ([^<\n]+)/gm)) {
    commands.push(match[1]!.trim().split(/\s+/));
  }
  return commands;
}

let scratch: string;
let previous: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "tallyd-cli-"));
  previous = process.cwd();
  process.chdir(scratch);
});

afterEach(() => {
  process.chdir(previous);
  rmSync(scratch, { recursive: true, force: true });
});

describe("writing a file the CLI produces", () => {
  it("creates the directory it goes in", () => {
    const path = join(scratch, "a", "b", "out.txt");
    writeCreatingDirectory(path, "written");
    expect(readFileSync(path, "utf8")).toBe("written");
  });

  it("writes into a directory that already exists, replacing the file", () => {
    const path = join(scratch, "out.txt");
    writeFileSync(path, "before", "utf8");
    writeCreatingDirectory(path, "after");
    expect(readFileSync(path, "utf8")).toBe("after");
  });

  it("writes a bare file name into the working directory", () => {
    writeCreatingDirectory("out.txt", "here");
    expect(readFileSync(join(scratch, "out.txt"), "utf8")).toBe("here");
  });

  it("still fails where a file stands in the way of the directory", () => {
    writeFileSync(join(scratch, "books"), "not a directory", "utf8");
    expect(() => writeCreatingDirectory(join(scratch, "books", "books.json"), "{}")).toThrow();
  });
});

describe("the front page's first minute, on a real disk", () => {
  const site = readFileSync(resolve(root, "docs/site.ts"), "utf8");
  const commands = firstMinuteCommands(site);

  it("finds the commands the page prints", () => {
    // Without this the loop below could pass by running nothing.
    expect(commands.map((argv) => argv[0])).toEqual(["generate", "dashboard"]);
  });

  it("runs each of them in order from an empty directory", () => {
    expect(existsSync("books")).toBe(false);
    for (const argv of commands) {
      const result = run(argv, nodeEnvironment());
      expect(result.stderr, argv.join(" ")).toBe("");
      expect(result.code, argv.join(" ")).toBe(0);
    }
    expect(statSync("books/books.json").size).toBeGreaterThan(0);
    expect(statSync("books/statement.csv").size).toBeGreaterThan(0);
    expect(readFileSync("review.html", "utf8")).toMatch(/^<!doctype html>/i);
  });

  it("writes a dashboard into a directory nobody made either", () => {
    expect(run(["generate", "--out", "books"], nodeEnvironment()).code).toBe(0);
    const result = run(
      ["dashboard", "-l", "books/books.json", "-s", "books/statement.csv", "-a", "1110", "-o", "reports/review.html"],
      nodeEnvironment(),
    );
    expect(result.code).toBe(0);
    expect(existsSync("reports/review.html")).toBe(true);
  });
});

describe("reading the commands off the page", () => {
  it("takes every npx line, inside a code block or continuing one", () => {
    const source = [
      "  <pre><code>npx ${esc(PACKAGE)} generate --out books",
      "npx ${esc(PACKAGE)} dashboard -l books/books.json -o review.html</code></pre>",
    ].join("\n");
    expect(firstMinuteCommands(source)).toEqual([
      ["generate", "--out", "books"],
      ["dashboard", "-l", "books/books.json", "-o", "review.html"],
    ]);
  });

  it("does not take a line that only mentions npx in prose", () => {
    expect(firstMinuteCommands("  <p>run npx ${esc(PACKAGE)} generate first</p>")).toEqual([]);
  });

  it("does not take the install line", () => {
    expect(firstMinuteCommands("  <pre><code>npm install ${esc(PACKAGE)}</code></pre>")).toEqual([]);
  });
});
