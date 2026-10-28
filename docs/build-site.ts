/**
 * Write the site out, and render the dashboard into it.
 *
 *     npm run docs
 *
 * Kept apart from `docs/site.ts` so that the generator itself touches no
 * filesystem and the tests can call it directly. The dashboard needs no
 * bundler: it is already one HTML file with its styles, its script and its
 * data inlined, so "building" it means generating a set of books, reconciling
 * them, and rendering the result — which is also the only honest way to put it
 * on a website, because a screenshot of a review queue is a picture of
 * something nobody can use.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, DASHBOARD, DASHBOARD_FILE } from "./site.js";
import { reviewDashboard } from "./dashboard.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site");

// Cleared rather than written over: a page the generator no longer produces
// should not survive in the published site because it was there last time.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// The dashboard first: the page quotes its size and its counts, so it has to
// exist before the page that describes it can be written.
const dashboard = reviewDashboard();

const files = buildSite(dashboard);
for (const [name, content] of files) {
  writeFileSync(join(OUT, name), content, "utf8");
}

mkdirSync(join(OUT, DASHBOARD), { recursive: true });
writeFileSync(join(OUT, DASHBOARD, DASHBOARD_FILE), dashboard.html, "utf8");

process.stdout.write(
  `site: ${[...files.keys()].join(", ")}\n` +
    `dashboard: ${DASHBOARD}${DASHBOARD_FILE}, ` +
    `${Math.round(dashboard.html.length / 1024)} KB, ` +
    `${dashboard.matched} matched, ${dashboard.toReview} to review, ` +
    `${dashboard.unexplained} unexplained, no network needed\n`,
);
