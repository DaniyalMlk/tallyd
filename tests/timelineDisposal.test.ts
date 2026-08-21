import { describe, expect, it } from "vitest";
import { GBP } from "../src/money/currency.js";
import { dateRange } from "../src/ledger/date.js";
import { GroupError, GroupStructure } from "../src/group/structure.js";
import { controlWindow, controlWindows, renderControlWindows } from "../src/group/timeline.js";

const period = dateRange("2026-01-01", "2026-12-31");

function groupWith(dates: { acquired?: string; disposed?: string }): GroupStructure {
  return GroupStructure.build(
    [
      { code: "P", name: "Parent", currency: GBP },
      {
        code: "S",
        name: "Sub",
        currency: GBP,
        parent: "P",
        holding: "75",
        ...(dates.acquired === undefined ? {} : { acquired: dates.acquired }),
        ...(dates.disposed === undefined ? {} : { disposed: dates.disposed }),
      },
    ],
    { presentation: "GBP", name: "A group" },
  );
}

const windowFor = (dates: { acquired?: string; disposed?: string }) =>
  controlWindow(groupWith(dates).get("S"), period);

describe("a company sold part-way through the period", () => {
  it("closes the window on the day control was lost", () => {
    const window = windowFor({ acquired: "2020-01-01", disposed: "2026-09-30" });
    expect(window.window).toEqual(dateRange("2026-01-01", "2026-09-30"));
    expect(window.disposedDuring).toBe(true);
    expect(window.acquiredDuring).toBe(false);
    expect(window.whole).toBe(false);
  });

  it("includes the day of the sale, because that day's trading is still the group's", () => {
    expect(windowFor({ disposed: "2026-09-30" }).window?.to).toBe("2026-09-30");
  });

  it("reads the entity's own position at the disposal date and not at the reporting date", () => {
    expect(windowFor({ disposed: "2026-09-30" }).consolidateAt).toBe("2026-09-30");
  });

  it("has nothing to close, because the far end of a window is not a closing question", () => {
    expect(windowFor({ disposed: "2026-09-30" }).closeAt).toBeNull();
  });

  it("says why in words that name the date", () => {
    expect(windowFor({ disposed: "2026-09-30" }).reason).toBe(
      "disposed of 2026-09-30, part-way through the period",
    );
  });

  it("is still in the period", () => {
    expect(windowFor({ disposed: "2026-09-30" }).inPeriod).toBe(true);
  });

  it("keeps the disposal date on the window for a reader to check", () => {
    expect(windowFor({ disposed: "2026-09-30" }).disposed).toBe("2026-09-30");
  });
});

describe("the edges of the far end", () => {
  it("sold on the reporting date is the whole period and no disposal to account for", () => {
    const window = windowFor({ disposed: "2026-12-31" });
    expect(window.window).toEqual(period);
    expect(window.whole).toBe(false);
    expect(window.disposedDuring).toBe(true);
    expect(window.consolidateAt).toBe("2026-12-31");
  });

  it("sold the day after the reporting date is not this period's business", () => {
    const window = windowFor({ disposed: "2027-01-01" });
    expect(window.disposedDuring).toBe(false);
    expect(window.whole).toBe(true);
    expect(window.window).toEqual(period);
    expect(window.consolidateAt).toBe("2026-12-31");
  });

  it("sold on the first day of the period leaves a window one day long", () => {
    const window = windowFor({ disposed: "2026-01-01" });
    expect(window.window).toEqual(dateRange("2026-01-01", "2026-01-01"));
    expect(window.disposedDuring).toBe(true);
  });

  it("sold the day before the period opened is not consolidated at all", () => {
    const window = windowFor({ disposed: "2025-12-31" });
    expect(window.inPeriod).toBe(false);
    expect(window.window).toBeNull();
    expect(window.reason).toContain("before the period opened");
  });

  it("falls back to the reporting date for a company still in the group", () => {
    expect(windowFor({}).consolidateAt).toBe("2026-12-31");
    expect(windowFor({ acquired: "2026-04-01" }).consolidateAt).toBe("2026-12-31");
  });
});

describe("bought and sold inside the same period", () => {
  const window = windowFor({ acquired: "2026-04-01", disposed: "2026-09-30" });

  it("opens the day after the purchase and closes on the day of the sale", () => {
    expect(window.window).toEqual(dateRange("2026-04-02", "2026-09-30"));
  });

  it("flags both ends", () => {
    expect(window.acquiredDuring).toBe(true);
    expect(window.disposedDuring).toBe(true);
    expect(window.whole).toBe(false);
  });

  it("still closes the books at the acquisition date", () => {
    expect(window.closeAt).toBe("2026-04-01");
  });

  it("reads the position at the disposal date", () => {
    expect(window.consolidateAt).toBe("2026-09-30");
  });

  it("names both dates in the reason", () => {
    expect(window.reason).toContain("2026-04-01");
    expect(window.reason).toContain("2026-09-30");
  });

  it("comes out empty when the two are the same day", () => {
    const sameDay = windowFor({ acquired: "2026-06-30", disposed: "2026-06-30" });
    expect(sameDay.window).toBeNull();
    expect(sameDay.inPeriod).toBe(true);
    expect(sameDay.consolidateAt).toBe("2026-06-30");
    expect(sameDay.reason).toContain("no day of the period's result is the group's");
  });

  it("comes out empty when it is sold the day after it is bought", () => {
    // The window opens on the day after the purchase and closes on the day of
    // the sale, so buying on Monday and selling on Tuesday is one day long.
    const overnight = windowFor({ acquired: "2026-06-29", disposed: "2026-06-30" });
    expect(overnight.window).toEqual(dateRange("2026-06-30", "2026-06-30"));
  });
});

describe("dates that are not a holding period", () => {
  it("refuses a company sold before it was bought", () => {
    expect(() => groupWith({ acquired: "2026-09-30", disposed: "2026-04-01" })).toThrow(GroupError);
    expect(() => groupWith({ acquired: "2026-09-30", disposed: "2026-04-01" })).toThrow(
      /before it was acquired/,
    );
  });

  it("allows a company bought and sold on the same day", () => {
    expect(() => groupWith({ acquired: "2026-06-30", disposed: "2026-06-30" })).not.toThrow();
  });
});

describe("the structure knows which companies have gone", () => {
  it("lists them", () => {
    const group = groupWith({ disposed: "2026-09-30" });
    expect(group.disposedEntities().map((e) => e.code)).toEqual(["S"]);
    expect(group.get("S").disposed).toBe("2026-09-30");
    expect(group.get("P").disposed).toBeNull();
  });

  it("lists none when nobody has been sold", () => {
    expect(groupWith({}).disposedEntities()).toEqual([]);
  });

  it("says so when it renders the structure", () => {
    expect(groupWith({ disposed: "2026-09-30" }).render()).toContain("sold 2026-09-30");
  });
});

describe("rendering the windows", () => {
  it("shows the closed window and the date the position is read at", () => {
    const group = groupWith({ disposed: "2026-09-30" });
    const text = renderControlWindows(controlWindows(group, period), (c) => group.get(c).name);
    expect(text).toContain("2026-01-01 to 2026-09-30");
    expect(text).toContain("its balance sheet is read at 2026-09-30");
  });

  it("says nothing about a balance sheet for a company still held", () => {
    const group = groupWith({});
    const text = renderControlWindows(controlWindows(group, period), (c) => group.get(c).name);
    expect(text).not.toContain("taken back out");
  });
});
