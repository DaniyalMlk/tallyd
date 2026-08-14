import { describe, expect, it } from "vitest";
import { inferColumns } from "../src/statement/columns.js";

describe("inference from headers", () => {
  it("maps a straightforward UK export", () => {
    const mapping = inferColumns(
      ["Date", "Description", "Amount", "Balance"],
      [
        ["01/08/2026", "OPENING BALANCE", "0.00", "1000.00"],
        ["02/08/2026", "CARD PAYMENT TESCO", "-12.99", "987.01"],
      ],
    );
    expect(mapping.date).toBe(0);
    expect(mapping.description).toBe(1);
    expect(mapping.amount).toBe(2);
    expect(mapping.balance).toBe(3);
    expect(mapping.warnings).toEqual([]);
  });

  it("maps a paid in / paid out pair", () => {
    const mapping = inferColumns(
      ["Date", "Description", "Paid Out", "Paid In", "Balance"],
      [
        ["01/08/2026", "RENT", "950.00", "", "50.00"],
        ["02/08/2026", "SALARY", "", "2000.00", "2050.00"],
      ],
    );
    expect(mapping.debit).toBe(2);
    expect(mapping.credit).toBe(3);
    expect(mapping.amount).toBeNull();
    expect(mapping.balance).toBe(4);
  });

  it("distinguishes transaction date from value date", () => {
    const mapping = inferColumns(
      ["Transaction Date", "Value Date", "Narrative", "Amount"],
      [["01/08/2026", "03/08/2026", "FASTER PAYMENT", "250.00"]],
    );
    expect(mapping.date).toBe(0);
    expect(mapping.valueDate).toBe(1);
    expect(mapping.description).toBe(2);
  });

  it("reads Dutch headers", () => {
    const mapping = inferColumns(
      ["Datum", "Omschrijving", "Bedrag", "Saldo"],
      [["01-02-2026", "ALBERT HEIJN", "-42,15", "957,85"]],
    );
    expect(mapping.date).toBe(0);
    expect(mapping.description).toBe(1);
    expect(mapping.amount).toBe(2);
    expect(mapping.balance).toBe(3);
  });

  it("picks up reference, currency and type columns", () => {
    const mapping = inferColumns(
      ["Date", "Type", "Description", "Reference", "Currency", "Amount"],
      [["01/08/2026", "DD", "RENT", "REF123", "GBP", "-950.00"]],
    );
    expect(mapping.type).toBe(1);
    expect(mapping.reference).toBe(3);
    expect(mapping.currency).toBe(4);
    expect(mapping.amount).toBe(5);
  });
});

describe("inference from content", () => {
  it("works with no header at all", () => {
    const mapping = inferColumns(
      ["", "", ""],
      [
        ["01/08/2026", "CARD PAYMENT TESCO", "-12.99"],
        ["02/08/2026", "DIRECT DEBIT BRITISH GAS", "-64.00"],
        ["03/08/2026", "FASTER PAYMENT ACME LTD", "1200.00"],
      ],
    );
    expect(mapping.date).toBe(0);
    expect(mapping.description).toBe(1);
    expect(mapping.amount).toBe(2);
  });

  it("survives meaningless headers", () => {
    const mapping = inferColumns(
      ["col1", "col2", "col3"],
      [
        ["2026-08-01", "SAINSBURYS PETROL", "-58.20"],
        ["2026-08-02", "TFL TRAVEL CHARGE", "-6.60"],
      ],
    );
    expect(mapping.date).toBe(0);
    expect(mapping.description).toBe(1);
    expect(mapping.amount).toBe(2);
  });

  it("does not mistake a date column for an amount column", () => {
    const mapping = inferColumns(
      ["", ""],
      [
        ["2026-08-01", "-58.20"],
        ["2026-08-02", "-6.60"],
      ],
    );
    expect(mapping.date).toBe(0);
    expect(mapping.amount).toBe(1);
  });

  it("gives each column at most one role", () => {
    const mapping = inferColumns(
      ["Date", "Description", "Amount", "Balance"],
      [["01/08/2026", "RENT", "-950.00", "50.00"]],
    );
    const used = mapping.assignments.filter((a) => a.role !== "unknown").map((a) => a.index);
    expect(new Set(used).size).toBe(used.length);
  });

  it("reports the score behind each assignment", () => {
    const mapping = inferColumns(["Date", "Amount"], [["01/08/2026", "-950.00"]]);
    for (const assignment of mapping.assignments) {
      if (assignment.role !== "unknown") expect(assignment.score).toBeGreaterThan(0);
    }
  });

  it("marks columns it cannot place as unknown", () => {
    const mapping = inferColumns(
      ["Date", "Description", "Amount", "Sort Code"],
      [["01/08/2026", "RENT", "-950.00", "20-00-00"]],
    );
    const sortCode = mapping.assignments[3];
    expect(sortCode?.role).toBe("unknown");
  });
});

describe("overrides and warnings", () => {
  it("honours an explicit override", () => {
    const mapping = inferColumns(
      ["Date", "Description", "Amount"],
      [["01/08/2026", "RENT", "-950.00"]],
      { description: 2, amount: 1 },
    );
    expect(mapping.description).toBe(2);
    expect(mapping.amount).toBe(1);
  });

  it("warns when nothing can value a row", () => {
    const mapping = inferColumns(["Date", "Description"], [["01/08/2026", "RENT"]]);
    expect(mapping.warnings.join(" ")).toMatch(/cannot be valued/);
  });

  it("warns when there is no date", () => {
    const mapping = inferColumns(["Description", "Amount"], [["RENT", "-950.00"]]);
    expect(mapping.warnings.join(" ")).toMatch(/No date column/);
  });

  it("warns when there is no description", () => {
    const mapping = inferColumns(["Date", "Amount"], [["01/08/2026", "-950.00"]]);
    expect(mapping.warnings.join(" ")).toMatch(/No description column/);
  });

  it("warns when an amount column and a debit/credit pair both appear", () => {
    const mapping = inferColumns(
      ["Date", "Description", "Debit", "Credit", "Amount"],
      [["01/08/2026", "RENT", "950.00", "", "-950.00"]],
    );
    expect(mapping.warnings.join(" ")).toMatch(/amount column wins/);
  });

  it("handles an empty table", () => {
    const mapping = inferColumns([], []);
    expect(mapping.assignments).toEqual([]);
    expect(mapping.date).toBeNull();
    expect(mapping.warnings.length).toBeGreaterThan(0);
  });

  it("handles ragged rows without crashing", () => {
    const mapping = inferColumns(
      ["Date", "Description", "Amount"],
      [["01/08/2026", "RENT", "-950.00"], ["02/08/2026", "SHORT ROW"]],
    );
    expect(mapping.date).toBe(0);
    expect(mapping.amount).toBe(2);
  });
});
