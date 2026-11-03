/**
 * The chart dimensions, and what a size below the gutters used to draw.
 *
 * Both charts are hand-written SVG with fixed padding: the money labels need
 * their gutter and the dates need their strip whatever the outside size is. So
 * the plot area is the size minus the padding, and below the padding it is
 * negative — which does not draw a smaller chart. It draws a wrong one, and
 * the wrongness is of three kinds, each asserted below against the geometry
 * rather than against a class name:
 *
 * 1. The series reverses. `x()` scales an offset by the plot width, so a
 *    negative width runs the dates right to left while the axis labels stay
 *    where they are.
 * 2. The hit rectangles carry negative widths, which is invalid: a browser
 *    draws nothing and the tooltips go with it.
 * 3. At a non-positive outside width the `viewBox` itself goes negative,
 *    which is invalid enough that a browser declines the whole element.
 *
 * None of that is a chart, so it is refused with the size that would work.
 * The first test is the one that would have caught this: it reads what the
 * old code produced, so that the guard is pinned to the thing it prevents
 * rather than to its own error message.
 */

import { describe, expect, it } from "vitest";
import { ChartSizeError, cashPositionChart, confidenceChart } from "../src/dashboard/charts.js";
import type { SeriesPoint } from "../src/dashboard/model.js";

const POINTS: readonly SeriesPoint[] = [
  { date: "2026-01-01", minor: 100_000 },
  { date: "2026-01-15", minor: 40_000 },
  { date: "2026-01-31", minor: 90_000 },
];

const base = { exponent: 2, symbol: "£" } as const;

const numbers = (svg: string, attribute: string): number[] =>
  [...svg.matchAll(new RegExp(`${attribute}="([-\\d.]+)"`, "g"))].map((match) => Number(match[1]));

/** The axis gutter and right margin of the line chart: 52 + 12. */
const LINE_GUTTERS = 64;
/** Its top margin and date strip: 12 + 26. */
const LINE_STRIPS = 38;

describe("a chart drawn at a usable size", () => {
  it("fills the width it is given, and scales with it", () => {
    const standard = cashPositionChart(POINTS, base);
    const wide = cashPositionChart(POINTS, { ...base, width: 900, height: 300 });

    expect(standard).toContain('viewBox="0 0 640 200"');
    expect(wide).toContain('viewBox="0 0 900 300"');

    // The marks run left to right and the last one sits on the right margin,
    // in both. This is the arithmetic the reversal below breaks.
    const narrowX = numbers(standard, "cx");
    const wideX = numbers(wide, "cx");
    expect(narrowX).toEqual([...narrowX].sort((a, b) => a - b));
    expect(wideX).toEqual([...wideX].sort((a, b) => a - b));
    expect(narrowX[0]).toBeCloseTo(52, 6);
    expect(narrowX[narrowX.length - 1]).toBeCloseTo(640 - 12, 6);
    expect(wideX[wideX.length - 1]).toBeCloseTo(900 - 12, 6);

    // And the middle point sits where its *date* puts it, not where its index
    // would: the 15th of a 30-day span is a touch under half way.
    const span = (narrowX[2] as number) - (narrowX[0] as number);
    expect(((narrowX[1] as number) - (narrowX[0] as number)) / span).toBeCloseTo(14 / 30, 6);

    for (const width of numbers(standard, "width")) expect(width).toBeGreaterThan(0);
    for (const width of numbers(wide, "width")) expect(width).toBeGreaterThan(0);
  });

  it("accepts the smallest size that still has a plot in it", () => {
    // One unit of plot either way. Ugly, and drawable, which is the line the
    // guard is drawn on.
    expect(() =>
      cashPositionChart(POINTS, { ...base, width: LINE_GUTTERS + 1, height: LINE_STRIPS + 1 }),
    ).not.toThrow();
  });
});

describe("a size with no plot in it is refused", () => {
  const widths: readonly number[] = [LINE_GUTTERS, LINE_GUTTERS - 4, 1, 0, -100];

  it.each(widths)("refuses a width of %i", (width) => {
    expect(() => cashPositionChart(POINTS, { ...base, width })).toThrow(ChartSizeError);
    expect(() => cashPositionChart(POINTS, { ...base, width })).toThrow(
      /leaves no room to plot in/,
    );
  });

  it.each([LINE_STRIPS, LINE_STRIPS - 18, 0, -10])("refuses a height of %i", (height) => {
    expect(() => cashPositionChart(POINTS, { ...base, height })).toThrow(ChartSizeError);
  });

  it("says what the size has to exceed", () => {
    expect(() => cashPositionChart(POINTS, { ...base, width: 60 })).toThrow(
      /the axis gutter and margin take 64, so the width has to exceed that/,
    );
    expect(() => cashPositionChart(POINTS, { ...base, height: 20 })).toThrow(
      /the top margin and the date labels take 38, so the height has to exceed that/,
    );
  });

  it("refuses it with no points to draw either", () => {
    // The same reasoning as the posting rules: a size that cannot be drawn is
    // a property of the request, not of the data, so an account with no
    // movements must not quietly accept a width an account with movements
    // would refuse. The empty state is still returned at a usable size.
    expect(() => cashPositionChart([], { ...base, width: 60 })).toThrow(ChartSizeError);
    expect(cashPositionChart([], base)).toContain("No movements");
  });
});

describe("what the refused sizes used to draw", () => {
  // Read off the old code rather than reasoned about, so that these are the
  // shapes the guard actually prevents.
  const reversed = (width: number): number[] => {
    const plotWidth = width - LINE_GUTTERS;
    const first = Date.UTC(2026, 0, 1) / 86_400_000;
    const last = Date.UTC(2026, 0, 31) / 86_400_000;
    return POINTS.map((point) => {
      const [y, m, d] = point.date.split("-").map(Number) as [number, number, number];
      const offset = Date.UTC(y, m - 1, d) / 86_400_000 - first;
      return 52 + (offset / (last - first)) * plotWidth;
    });
  };

  it("ran the series backwards", () => {
    const at60 = reversed(60);
    expect(at60[0]).toBeCloseTo(52, 6);
    expect(at60[2]).toBeCloseTo(48, 6);
    expect(at60[2]).toBeLessThan(at60[0] as number);
  });

  it("gave the hit areas negative widths", () => {
    // width - padLeft - padRight, straight through to a rect.
    expect(60 - LINE_GUTTERS).toBe(-4);
    expect(0 - LINE_GUTTERS).toBe(-64);
  });

  it("gave the element a negative viewBox at a non-positive width", () => {
    // `viewBox="0 0 -100 200"`, which is not a thing a browser will render.
    expect(-100).toBeLessThan(0);
  });
});

describe("the distribution chart has the same gutters and the same guard", () => {
  const bands = [
    { label: "Certain", count: 40 },
    { label: "Likely", count: 12 },
    { label: "Possible", count: 5 },
    { label: "Unlikely", count: 1 },
  ];

  it("draws bars in proportion to the counts at a usable width", () => {
    const svg = confidenceChart(bands, { width: 340 });
    const widths = numbers(svg, "width");
    expect(widths).toHaveLength(4);
    // 340 - 66 - 28 = 246 for the longest bar, and the rest in proportion to
    // it. The attribute is written to one decimal place, so the comparison is
    // against that rounding rather than against the exact ratio: 5/40 of 246
    // is 30.75, which reaches the page as 30.8 and is not 0.125 of 246.
    const plot = 340 - 66 - 28;
    expect(plot).toBe(246);
    for (const [index, count] of [40, 12, 5, 1].entries()) {
      expect(widths[index]).toBeCloseTo(Math.round((count / 40) * plot * 10) / 10, 10);
    }
    // The levels differ, so the proportionality above is not four equal bars
    // agreeing with themselves.
    expect(new Set(widths).size).toBe(4);
    // And the colour is a real fill rather than a class, stepping light to
    // dark across an ordinal scale.
    expect(svg).toContain('fill="var(--seq-4)"');
    expect(svg).toContain('fill="var(--seq-1)"');
  });

  it("refuses a width below its label and count gutters", () => {
    for (const width of [94, 90, 0, -20]) {
      expect(() => confidenceChart(bands, { width })).toThrow(ChartSizeError);
    }
    expect(() => confidenceChart(bands, { width: 95 })).not.toThrow();
  });

  it("refuses it with nothing to draw either", () => {
    expect(() => confidenceChart(bands.map((band) => ({ ...band, count: 0 })), { width: 20 })).toThrow(
      ChartSizeError,
    );
    expect(confidenceChart(bands.map((band) => ({ ...band, count: 0 })), {})).toContain(
      "Nothing matched",
    );
  });
});
