/**
 * The environment the executable runs in: the real filesystem and the real
 * clock. `run` is pure and is tested against an in-memory environment, which
 * is the right fixture for everything except the one thing it cannot see —
 * how a path behaves on an actual disk. That is what this module is for, and
 * why it is separate from `main.ts`, which exists only to connect it to the
 * process and cannot be imported without running.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { date } from "../ledger/date.js";
import type { CalendarDate } from "../ledger/date.js";
import type { CliEnvironment } from "./run.js";

/**
 * Write a file, creating the directory it goes in if there is none yet.
 *
 * Every command that produces an artefact takes a path for it, and the path a
 * person types first is usually a new one: the first line on the front page
 * is `tallyd generate --out books`. Writing straight to `books/books.json`
 * failed with ENOENT, because nothing had made `books`. An in-memory
 * environment accepts any path, so the suite could not see it.
 */
export function writeCreatingDirectory(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/** Today in UTC, read off the clock. */
export function today(): CalendarDate {
  // The only place in the codebase that reads the clock, kept to one line so
  // it is obvious where non-determinism enters.
  const now = new Date();
  const iso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
  return date(iso);
}

/** The environment `tallyd` runs in when it is started from a shell. */
export function nodeEnvironment(): CliEnvironment {
  return {
    readFile: (path: string) => readFileSync(path, "utf8"),
    writeFile: writeCreatingDirectory,
    today,
  };
}
