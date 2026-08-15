/**
 * The executable. Everything interesting is in `run`, which is a pure
 * function; this file exists to connect it to the process.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { run } from "./run.js";
import { date } from "../ledger/date.js";
import type { CalendarDate } from "../ledger/date.js";

function today(): CalendarDate {
  // The only place in the codebase that reads the clock, kept to one line so
  // it is obvious where non-determinism enters.
  const now = new Date();
  const iso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
  return date(iso);
}

const result = run(process.argv.slice(2), {
  readFile: (path: string) => readFileSync(path, "utf8"),
  writeFile: (path: string, contents: string) => writeFileSync(path, contents, "utf8"),
  today,
});

if (result.stdout !== "") process.stdout.write(`${result.stdout}\n`);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exit(result.code);
