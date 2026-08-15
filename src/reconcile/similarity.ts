/**
 * How alike are two descriptions?
 *
 * The answer has to be graded, not boolean. "FPI ACME LTD — INV1001" and
 * "Invoice 1001 settled" describe the same event and share almost no
 * characters; "DD RENT, AUGUST 08" and "DD RENT, JULY 08" differ by one word
 * and describe different events. A single distance metric gets both of these
 * wrong, so three signals are combined:
 *
 * - character distance, which catches truncation and typos;
 * - token overlap, which survives reordering and padding words;
 * - reference tokens (`INV1001`, `SUB9931`), which are worth far more than an
 *   ordinary word because banks pass them through unchanged.
 *
 * Everything here is pure text. Nothing knows about money, dates or matching.
 */

/** Split into comparable tokens: uppercase, alphanumeric, no runts. */
export function tokenise(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Levenshtein edit distance, two-row DP.
 *
 * `maxDistance` turns it into a bounded check: once every cell in a row is
 * over the ceiling no later row can come back under it, so the walk stops and
 * returns `maxDistance + 1`. Callers comparing hundreds of pairs care.
 */
export function levenshtein(a: string, b: string, maxDistance?: number): number {
  if (a === b) return 0;

  // The ceiling is applied before the trivial cases, so a caller asking "is
  // this within 2?" gets the same answer shape however the two strings differ.
  const ceiling = maxDistance ?? Number.POSITIVE_INFINITY;
  if (Math.abs(a.length - b.length) > ceiling) return Math.floor(ceiling) + 1;

  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Iterate over the shorter string in the inner loop.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  let previous = new Array<number>(short.length + 1);
  let current = new Array<number>(short.length + 1);
  for (let j = 0; j <= short.length; j++) previous[j] = j;

  for (let i = 1; i <= long.length; i++) {
    current[0] = i;
    let rowMinimum = i;
    const longChar = long.charCodeAt(i - 1);
    for (let j = 1; j <= short.length; j++) {
      const substitution = (previous[j - 1] as number) + (longChar === short.charCodeAt(j - 1) ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      const best = Math.min(substitution, deletion, insertion);
      current[j] = best;
      if (best < rowMinimum) rowMinimum = best;
    }
    if (rowMinimum > ceiling) return Math.floor(ceiling) + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[short.length] as number;
}

/** Edit distance rescaled to `0..1`, where 1 is identical. */
export function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Jaro similarity: transposition-aware, and much kinder than edit distance to
 * strings that agree at the start and diverge later — which is how truncated
 * bank descriptors fail.
 */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(i + window + 1, b.length);
    for (let j = from; j < to; j++) {
      if (bMatched[j] === true) continue;
      if (a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (aMatched[i] !== true) continue;
    while (bMatched[k] !== true) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const half = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - half) / matches) / 3;
}

/**
 * Jaro-Winkler: Jaro with a bonus for a shared prefix, capped at four
 * characters. Bank descriptors put the merchant first, so the prefix carries
 * more signal than the tail.
 */
export function jaroWinkler(a: string, b: string, prefixWeight = 0.1): number {
  const base = jaro(a, b);
  if (base === 0) return 0;
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix++;
  return base + prefix * prefixWeight * (1 - base);
}

/**
 * A token that looks like an external reference rather than a word: it mixes
 * letters and digits, or is a bare run of digits long enough to be an id.
 */
export function isReferenceToken(token: string): boolean {
  if (token.length < 3) return false;
  const hasDigit = /[0-9]/.test(token);
  if (!hasDigit) return false;
  const hasLetter = /[A-Z]/.test(token);
  if (hasLetter) return true;
  return token.length >= 4;
}

export function referenceTokens(text: string): string[] {
  return tokenise(text).filter(isReferenceToken);
}

/** The digits inside a reference, which is the part banks preserve. */
function digitsOf(token: string): string {
  return token.replace(/[^0-9]/g, "");
}

/**
 * References the two sides agree on.
 *
 * Equality is deliberately loose: `INV1001` on our side and `1001` on the
 * bank's side are the same reference, and one being a suffix of the other is
 * the normal shape of that disagreement. Digit runs shorter than three are
 * ignored — too many false hits.
 */
export function sharedReferences(left: string, right: string): string[] {
  const leftRefs = referenceTokens(left);
  const rightRefs = referenceTokens(right);
  if (leftRefs.length === 0 || rightRefs.length === 0) return [];

  const shared: string[] = [];
  for (const l of leftRefs) {
    for (const r of rightRefs) {
      if (l === r) {
        shared.push(l);
        continue;
      }
      const ld = digitsOf(l);
      const rd = digitsOf(r);
      if (ld.length >= 3 && rd.length >= 3 && (ld.endsWith(rd) || rd.endsWith(ld))) {
        // Report the barer of the two spellings, so the same agreement is
        // named the same way whichever side it is read from.
        shared.push(l.length <= r.length ? l : r);
      }
    }
  }
  return [...new Set(shared)].sort();
}

const tokenWeight = (token: string): number => Math.min(token.length, 12);

/**
 * Weighted Sørensen-Dice over token sets.
 *
 * Weighting by token length is what stops "LTD" counting for as much as
 * "TOOLCHAIN". Tokens pair up greedily on Jaro-Winkler above a cutoff, so
 * near-misses ("SALARIES" / "SALARY") land as a partial hit rather than
 * nothing, and each token can only be spent once — otherwise a description
 * that says "RENT RENT" would look like a perfect match for "RENT".
 *
 * Dividing by the weight of *both* sides rather than the shorter one is what
 * makes the result symmetric, and it means a two-word descriptor buried inside
 * a ten-word one scores as the partial agreement it is.
 */
export function tokenOverlap(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;

  // Iterate the shorter side, breaking ties canonically so that swapping the
  // arguments cannot change the greedy pairing.
  const leftFirst =
    left.length < right.length ||
    (left.length === right.length && left.join(" ") <= right.join(" "));
  const [shorter, longer] = leftFirst ? [left, right] : [right, left];

  const taken = new Array<boolean>(longer.length).fill(false);

  let matched = 0;
  for (const token of shorter) {
    let bestScore = 0;
    let bestIndex = -1;
    for (let i = 0; i < longer.length; i++) {
      if (taken[i] === true) continue;
      const score = jaroWinkler(token, longer[i] as string);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestScore >= 0.82) {
      taken[bestIndex] = true;
      matched += Math.min(tokenWeight(token), tokenWeight(longer[bestIndex] as string)) * bestScore;
    }
  }

  const total =
    left.reduce((sum, t) => sum + tokenWeight(t), 0) +
    right.reduce((sum, t) => sum + tokenWeight(t), 0);

  return total === 0 ? 0 : Math.min(1, (2 * matched) / total);
}

export interface SimilarityBreakdown {
  /** Combined score in `0..1`. */
  readonly score: number;
  readonly tokenScore: number;
  readonly characterScore: number;
  readonly sharedReferences: readonly string[];
  readonly sharedTokens: readonly string[];
}

/**
 * Full similarity with the working shown, so a reviewer can see which signal
 * carried the match.
 *
 * A shared reference is treated as near-decisive: it lifts the floor to 0.9
 * rather than being averaged away by two descriptions that otherwise share no
 * words at all, which is exactly the "Invoice 1001 settled" case.
 */
export function similarityBreakdown(left: string, right: string): SimilarityBreakdown {
  const leftTokens = tokenise(left);
  const rightTokens = tokenise(right);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return Object.freeze({
      score: 0,
      tokenScore: 0,
      characterScore: 0,
      sharedReferences: Object.freeze([] as string[]),
      sharedTokens: Object.freeze([] as string[]),
    });
  }

  const tokenScore = tokenOverlap(leftTokens, rightTokens);
  const characterScore = jaroWinkler(leftTokens.join(" "), rightTokens.join(" "));
  const refs = sharedReferences(left, right);

  const shared = leftTokens.filter((t) => rightTokens.includes(t));

  let score = 0.65 * tokenScore + 0.35 * characterScore;
  if (refs.length > 0) score = Math.max(score, 0.9);

  return Object.freeze({
    score: Math.min(1, score),
    tokenScore,
    characterScore,
    sharedReferences: Object.freeze(refs),
    sharedTokens: Object.freeze([...new Set(shared)].sort()),
  });
}

/** The combined score alone. */
export function descriptionSimilarity(left: string, right: string): number {
  return similarityBreakdown(left, right).score;
}
