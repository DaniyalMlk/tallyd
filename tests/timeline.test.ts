import { describe, expect, it } from "vitest";
import { GBP } from "../src/money/currency.js";
import { dateRange } from "../src/ledger/date.js";
import { GroupStructure } from "../src/group/structure.js";
import { controlWindow, controlWindows, renderControlWindows } from "../src/group/timeline.js";

const period = dateRange("2026-01-01", "2026-12-31");

function groupWith(acquired: string | undefined): GroupStructure {
  return GroupStructure.build(
    [
      { code: "P", name: "Parent", currency: GBP },
      {
        code: "S",
        name: "Sub",
        currency: GBP,
        parent: "P",
        holding: "75",
        ...(acquired === undefined ? {} : { acquired }),
      },
    ],
    { presentation: "GBP", name: "A group" },
  );
}

const windowFor = (acquired: string | undefined) =>
  controlWindow(groupWith(acquired).get("S"), period);

describe("an entity held for the whole period", () => {
  it("takes the whole period when it was acquired before it opened", () => {
    const window = windowFor("2024-06-30");
    expect(window.whole).toBe(true);
    expect(window.acquiredDuring).toBe(false);
    expect(window.closeAt).toBeNull();
    expect(window.window).toEqual(period);
    expect(window.reason).toContain("before the period opened");
  });

  it("takes the whole period when it was acquired the day before it opened", () => {
    expect(windowFor("2025-12-31").whole).toBe(true);
    expect(windowFor("2025-12-31").closeAt).toBeNull();
  });

  it("takes the whole period when nobody recorded an acquisition date", () => {
    const window = windowFor(undefined);
    expect(window.whole).toBe(true);
    expect(window.acquired).toBeNull();
    expect(window.reason).toContain("no acquisition date");
  });
});

describe("an entity acquired during the period", () => {
  it("opens its window the day after control was obtained", () => {
    const window = windowFor("2026-04-01");
    expect(window.acquiredDuring).toBe(true);
    expect(window.whole).toBe(false);
    expect(window.window).toEqual(dateRange("2026-04-02", "2026-12-31"));
    expect(window.closeAt).toBe("2026-04-01");
  });

  it("closes the books at the acquisition date, not the day before", () => {
    // Net assets at acquisition are measured as at that date, including that
    // day's transactions. If the profit boundary were a day earlier, a sale
    // made on the day of completion would be counted twice: once in the price
    // paid for the net assets and once in the group's result.
    expect(windowFor("2026-04-01").closeAt).toBe("2026-04-01");
  });

  it("handles control obtained on the first day of the period", () => {
    const window = windowFor("2026-01-01");
    expect(window.acquiredDuring).toBe(true);
    expect(window.window).toEqual(dateRange("2026-01-02", "2026-12-31"));
    expect(window.closeAt).toBe("2026-01-01");
  });

  it("handles control obtained on the reporting date itself", () => {
    const window = windowFor("2026-12-31");
    // The group owns the balance sheet and none of the period's result. That
    // is a window with no days in it rather than no window at all, and the
    // books still need closing, so `acquiredDuring` is what separates it from
    // an entity acquired after the reporting date.
    expect(window.acquiredDuring).toBe(true);
    expect(window.closeAt).toBe("2026-12-31");
    expect(window.window).toBeNull();
    expect(window.reason).toContain("none of the period's result is the group's");
  });

  it("names the date in the reason, so a reader can check it against the books", () => {
    expect(windowFor("2026-04-01").reason).toBe("acquired 2026-04-01, part-way through the period");
  });
});

describe("an entity acquired after the reporting date", () => {
  it("gets no window at all, and is told apart from one acquired on it", () => {
    const window = windowFor("2027-03-01");
    expect(window.window).toBeNull();
    expect(window.whole).toBe(false);
    expect(window.acquiredDuring).toBe(false);
    expect(window.reason).toContain("after the reporting date");
    expect(windowFor("2026-12-31").acquiredDuring).toBe(true);
  });
});

describe("windows across a whole group", () => {
  const group = GroupStructure.build(
    [
      { code: "P", name: "Parent", currency: GBP },
      { code: "A", name: "Held all year", currency: GBP, parent: "P", holding: "80", acquired: "2020-01-01" },
      { code: "B", name: "Bought in April", currency: GBP, parent: "P", holding: "60", acquired: "2026-04-01" },
      { code: "C", name: "Not controlled", currency: GBP, parent: "P", holding: "30", acquired: "2021-01-01" },
    ],
    { presentation: "GBP", name: "A larger group" },
  );

  it("covers every consolidated entity and nothing else", () => {
    const windows = controlWindows(group, period);
    expect(windows.map((w) => w.entity)).toEqual(["P", "A", "B"]);
    expect(windows.map((w) => w.entity)).not.toContain("C");
  });

  it("gives the parent the whole period", () => {
    const parent = controlWindows(group, period).find((w) => w.entity === "P");
    expect(parent?.whole).toBe(true);
  });

  it("distinguishes the two subsidiaries", () => {
    const windows = controlWindows(group, period);
    expect(windows.find((w) => w.entity === "A")?.acquiredDuring).toBe(false);
    expect(windows.find((w) => w.entity === "B")?.acquiredDuring).toBe(true);
  });

  it("reads as a table naming each company and its span", () => {
    const text = renderControlWindows(controlWindows(group, period), (c) => group.get(c).name);
    expect(text).toContain("How much of the period each company was the group's");
    expect(text).toContain("the whole period");
    expect(text).toContain("2026-04-02 to 2026-12-31");
    expect(text).toContain("Bought in April");
  });
});

describe("a period of one day", () => {
  it("is a whole period like any other for an entity held before it", () => {
    const oneDay = dateRange("2026-12-31", "2026-12-31");
    const window = controlWindow(groupWith("2024-01-01").get("S"), oneDay);
    expect(window.whole).toBe(true);
    expect(window.window).toEqual(oneDay);
  });
});
