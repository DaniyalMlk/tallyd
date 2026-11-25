#!/usr/bin/env node
/**
 * The executable. Everything interesting is in `run`, which is a pure
 * function, and the real filesystem and clock are in `environment.ts`; this
 * file exists to connect the two to the process.
 */

import { nodeEnvironment } from "./environment.js";
import { run } from "./run.js";

const result = run(process.argv.slice(2), nodeEnvironment());

if (result.stdout !== "") process.stdout.write(`${result.stdout}\n`);
if (result.stderr !== "") process.stderr.write(result.stderr);
process.exit(result.code);
