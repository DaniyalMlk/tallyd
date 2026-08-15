/**
 * Two charts, drawn as SVG by hand.
 *
 * Not a library, because the whole artefact is one file that has to open from
 * a file path on a machine with no network — and because two charts do not
 * justify shipping a charting engine inside a bookkeeping report.
 *
 * Both answer a question rather than decorating a panel. The cash position
 * line answers "when was the account tight"; the confidence distribution
 * answers "how much of this did the matcher actually know". Neither carries a
 * legend: each is a single series, and the heading names it, so a legend box
 * would be a second label for the same thing.
 *
 * Colour does no identifying work here. One series takes the categorical blue;
 * the distribution is ordinal, so it steps one hue light to dark — never a
 * hue per bar, which would imply four unrelated categories.
 */

import type { SeriesPoint } from "./model.js";

export interface ChartOptions {
  readonly width?: number;
  readonly height?: number;
  readonly exponent: number;
  readonly symbol: string;
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function majorUnits(minor: number, exponent: number): number {
  return minor / 10 ** exponent;
}

function formatAxisMoney(minor: number, exponent: number, symbol: string): string {
  const value = majorUnits(minor, exponent);
  const abs = Math.abs(value);
  if (abs >= 1000) return `${symbol}${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${symbol}${value.toFixed(0)}`;
}

function formatMoney(minor: number, exponent: number, symbol: string): string {
  const negative = minor < 0;
  const digits = Math.abs(minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${symbol}${grouped}${fraction}`;
}

/**
 * Round a range outward to friendly ticks. Axes that stop at 23,143.58 read as
 * an accident; axes that stop at 25,000 read as a decision.
 */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1) * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Math.round(value));
  }
  return ticks;
}

/** Cash position across the period, as a line with a soft fill beneath it. */
export function cashPositionChart(
  points: readonly SeriesPoint[],
  options: ChartOptions,
): string {
  const width = options.width ?? 640;
  const height = options.height ?? 200;
  const padLeft = 52;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 26;

  if (points.length === 0) {
    return `<div class="empty"><strong>No movements</strong>Nothing has been posted to this account in the period.</div>`;
  }

  const values = points.map((point) => point.minor);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const low = Math.min(...ticks);
  const high = Math.max(...ticks);

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  // Position by date, not by index. Spacing ten movements evenly across a
  // month draws three days and thirteen days the same width, which is a lie
  // about the one axis the chart exists to show.
  const day = (iso: string): number => {
    const [year, month, dayOfMonth] = iso.split("-").map(Number) as [number, number, number];
    return Math.floor(Date.UTC(year, month - 1, dayOfMonth) / 86_400_000);
  };
  const firstDay = day((points[0] as SeriesPoint).date);
  const lastDay = day((points[points.length - 1] as SeriesPoint).date);
  const span = lastDay - firstDay;

  const x = (index: number): number => {
    if (points.length === 1 || span === 0) return padLeft + plotWidth / 2;
    const offset = day((points[index] as SeriesPoint).date) - firstDay;
    return padLeft + (offset / span) * plotWidth;
  };
  const y = (value: number): number =>
    padTop + plotHeight - ((value - low) / (high - low || 1)) * plotHeight;

  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.minor).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(low).toFixed(1)} L${x(0).toFixed(1)},${y(low).toFixed(1)} Z`;

  const gridLines = ticks
    .map((tick) => `<line x1="${padLeft}" x2="${width - padRight}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" />`)
    .join("");
  const axisLabels = ticks
    .map(
      (tick) =>
        `<text x="${padLeft - 8}" y="${(y(tick) + 3).toFixed(1)}" text-anchor="end">${escapeAttribute(
          formatAxisMoney(tick, options.exponent, options.symbol),
        )}</text>`,
    )
    .join("");

  const first = points[0] as SeriesPoint;
  const last = points[points.length - 1] as SeriesPoint;
  const dateLabels = [
    `<text x="${padLeft}" y="${height - 6}" text-anchor="start">${escapeAttribute(first.date)}</text>`,
    points.length > 1
      ? `<text x="${width - padRight}" y="${height - 6}" text-anchor="end">${escapeAttribute(last.date)}</text>`
      : "",
  ].join("");

  const markers = points
    .map(
      (point, index) =>
        `<circle class="marker" data-index="${index}" cx="${x(index).toFixed(1)}" cy="${y(point.minor).toFixed(1)}" r="4"><title>${escapeAttribute(
          `${point.date} · ${formatMoney(point.minor, options.exponent, options.symbol)}`,
        )}</title></circle>`,
    )
    .join("");

  // Wide invisible hit areas: a 4px dot is a poor target, and the tooltip
  // should follow the pointer across the whole column, not just the mark.
  const hitAreas = points
    .map((point, index) => {
      const here = x(index);
      const before = index === 0 ? padLeft : (x(index - 1) + here) / 2;
      const after = index === points.length - 1 ? width - padRight : (here + x(index + 1)) / 2;
      const left = Math.max(padLeft, before);
      const right = Math.min(width - padRight, after);
      return `<rect class="hit" x="${left.toFixed(1)}" y="${padTop}" width="${(right - left).toFixed(1)}" height="${plotHeight}" fill="transparent" data-x="${x(index).toFixed(1)}" data-y="${y(point.minor).toFixed(1)}" data-label="${escapeAttribute(
        `${point.date}  ${formatMoney(point.minor, options.exponent, options.symbol)}`,
      )}" />`;
    })
    .join("");

  return `<div class="chart" data-chart="cash">
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cash position across the period">
    <g class="grid">${gridLines}</g>
    <path class="series-area" d="${area}" />
    <path class="series-line" d="${line}" />
    <g class="axis">${axisLabels}${dateLabels}</g>
    ${markers}
    <line class="crosshair" y1="${padTop}" y2="${padTop + plotHeight}" x1="0" x2="0" style="display:none" />
    ${hitAreas}
  </svg>
  <div class="tooltip" role="status" aria-live="polite"></div>
</div>`;
}

/**
 * Distribution of match confidence, as horizontal bars.
 *
 * Horizontal because the labels are words: rotated axis text is a readability
 * cost paid for nothing when there are four categories.
 */
export function confidenceChart(
  bands: readonly { readonly label: string; readonly count: number }[],
  options: { readonly width?: number } = {},
): string {
  const width = options.width ?? 340;
  const rowHeight = 32;
  const labelWidth = 66;
  const countWidth = 28;
  const height = bands.length * rowHeight;

  const total = bands.reduce((sum, band) => sum + band.count, 0);
  if (total === 0) {
    return `<div class="empty"><strong>Nothing matched</strong>No pair scored high enough to appear.</div>`;
  }

  const most = Math.max(...bands.map((band) => band.count));
  const barWidth = width - labelWidth - countWidth;

  const rows = bands
    .map((band, index) => {
      const y = index * rowHeight;
      const length = most === 0 ? 0 : (band.count / most) * barWidth;
      const fill = `var(--seq-${4 - index})`;
      const share = total === 0 ? 0 : Math.round((band.count / total) * 100);
      return `<g>
      <text class="bar-label" x="0" y="${y + 19}">${escapeAttribute(band.label)}</text>
      <rect class="bar" x="${labelWidth}" y="${y + 8}" width="${Math.max(length, band.count > 0 ? 3 : 0).toFixed(1)}" height="14" rx="4" fill="${fill}"><title>${escapeAttribute(
        `${band.count} ${band.count === 1 ? "match" : "matches"} · ${share}%`,
      )}</title></rect>
      <text class="bar-label" x="${width}" y="${y + 19}" text-anchor="end">${band.count}</text>
    </g>`;
    })
    .join("");

  return `<div class="chart" data-chart="confidence">
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Distribution of match confidence">
    ${rows}
  </svg>
</div>`;
}
