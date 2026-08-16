/**
 * A small deterministic random source.
 *
 * The generator that sits on top of this has to be reproducible or the
 * benchmark numbers it produces are worthless: "the matcher takes 400ms" only
 * means something if the same seed builds the same books tomorrow. Reaching
 * for `Math.random()` would make every run a different problem.
 *
 * This is xorshift128, which is not a cryptographic generator and is not trying
 * to be. It needs three properties and has them: identical output for identical
 * seeds on every platform, a period long enough that a hundred thousand draws
 * never wraps, and no dependence on floating-point rounding for its state — the
 * whole state transition is 32-bit integer arithmetic, so it cannot drift
 * between engines.
 */

export class Random {
  private x: number;
  private y: number;
  private z: number;
  private w: number;

  constructor(seed: number) {
    // A zero state is a fixed point of xorshift, so fold the seed into four
    // words with a mixing constant and guarantee at least one is non-zero.
    const s = Math.trunc(seed) >>> 0;
    this.x = (s ^ 0x9e3779b9) >>> 0;
    this.y = (Math.imul(s, 0x85ebca6b) ^ 0x165667b1) >>> 0;
    this.z = (Math.imul(s, 0xc2b2ae35) ^ 0x27d4eb2f) >>> 0;
    this.w = (s ^ 0x94d049bb) >>> 0;
    if ((this.x | this.y | this.z | this.w) === 0) this.x = 0x1a2b3c4d;
    // Discard the first few draws: the low words of a freshly folded seed are
    // correlated with it, and it shows in the first handful of outputs.
    for (let i = 0; i < 16; i++) this.next();
  }

  /** The raw 32-bit draw. */
  next(): number {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return this.w;
  }

  /** A float in `[0, 1)`. */
  float(): number {
    return this.next() / 0x1_0000_0000;
  }

  /** An integer in `[min, max]`, both ends included. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`Empty range ${min}..${max}`);
    const span = max - min + 1;
    return min + (this.next() % span);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Cannot pick from an empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /**
   * A fresh copy of `items` in random order.
   *
   * Fisher-Yates, drawing from the unshuffled tail — the naive version that
   * draws from the whole array is subtly biased and produces some orderings
   * more often than others.
   */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = a;
    }
    return copy;
  }

  /**
   * A draw skewed towards the low end of `[min, max]`.
   *
   * Invoice values, settlement delays and batch sizes all cluster small with a
   * long tail, and drawing them uniformly produces books that look nothing like
   * a real business: too many enormous invoices, too many fortnight-long lags.
   */
  skewed(min: number, max: number, power = 2): number {
    const fraction = this.float() ** power;
    return min + Math.floor(fraction * (max - min + 1));
  }
}
