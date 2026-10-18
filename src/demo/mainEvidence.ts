/**
 * Entry point for the front page's figures:
 *
 *     npm run demo:evidence
 *
 * Exits non-zero if any of them moves outside the band the README states.
 */

import { evidenceReport } from "./evidence.js";

console.log(evidenceReport());
