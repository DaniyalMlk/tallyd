import { describe, expect, it } from "vitest";
import {
  extractTransactionBlocks,
  importOfx,
  looksLikeOfx,
  parseOfxDate,
} from "../src/statement/ofx.js";
import { GBP, USD } from "../src/money/index.js";

// A realistic download: SGML with unclosed tags, an OFX header block, and the
// aggregate nesting a bank actually emits.
const SAMPLE = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>GBP
<BANKACCTFROM>
<BANKID>200000
<ACCTID>12345678
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260801
<DTEND>20260831
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260804120000[0:GMT]
<TRNAMT>-1850.00
<FITID>202608040001
<NAME>DD RENT AUGUST
<MEMO>Landlord &amp; Co
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260807
<DTAVAIL>20260808
<TRNAMT>473.08
<FITID>202608070002
<NAME>SQ *SETTLEMENT 0805
</STMTTRN>
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20260812
<TRNAMT>7200.00
<FITID>202608120003
<CHECKNUM>001234
<NAME>ACME LTD
<MEMO>INV1001
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>23143.58
<DTASOF>20260831
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

describe("OFX dates", () => {
  it.each([
    ["20260814", "2026-08-14"],
    ["20260814120000", "2026-08-14"],
    ["20260814120000[-5:EST]", "2026-08-14"],
    ["20260814120000.000[0:GMT]", "2026-08-14"],
  ])("reads %s as %s", (input, expected) => {
    expect(parseOfxDate(input)).toBe(expected);
  });

  it("drops the time rather than shifting the date by a timezone", () => {
    // 23:30 in GMT-5 is the next day in UTC. A posting is on the date the bank
    // says it is; converting would move transactions between months.
    expect(parseOfxDate("20260831233000[-5:EST]")).toBe("2026-08-31");
  });

  it("rejects nonsense", () => {
    expect(() => parseOfxDate("not a date")).toThrow(RangeError);
    expect(() => parseOfxDate("20261301")).toThrow();
  });
});

describe("aggregate extraction", () => {
  it("finds every transaction block", () => {
    expect(extractTransactionBlocks(SAMPLE)).toHaveLength(3);
  });

  it("copes with unclosed STMTTRN tags", () => {
    const unclosed = "<STMTTRN>\n<TRNAMT>-1.00\n<STMTTRN>\n<TRNAMT>-2.00\n";
    expect(extractTransactionBlocks(unclosed)).toHaveLength(2);
  });

  it("returns nothing for a file with no transactions", () => {
    expect(extractTransactionBlocks("<OFX></OFX>")).toEqual([]);
  });
});

describe("importing OFX", () => {
  const result = importOfx(SAMPLE);

  it("reads every transaction", () => {
    expect(result.transactionCount).toBe(3);
    expect(result.lines).toHaveLength(3);
    expect(result.errors).toEqual([]);
  });

  it("takes the currency from CURDEF", () => {
    expect(result.account.currency).toBe(GBP);
    expect(result.warnings).toEqual([]);
  });

  it("reads the account identifiers", () => {
    expect(result.account.bankId).toBe("200000");
    expect(result.account.accountId).toBe("12345678");
    expect(result.account.accountType).toBe("CHECKING");
  });

  it("keeps the bank's own signs", () => {
    expect(result.lines[0]?.amount.toDecimalString()).toBe("-1850.00");
    expect(result.lines[1]?.amount.toDecimalString()).toBe("473.08");
  });

  it("keys on FITID so a re-download is recognisable", () => {
    expect(result.lines[0]?.id).toBe("OFX-202608040001");
  });

  it("joins name and memo into a description, decoding entities", () => {
    expect(result.lines[0]?.description).toBe("DD RENT AUGUST — Landlord & Co");
  });

  it("reads the value date when present", () => {
    expect(result.lines[1]?.valueDate).toBe("2026-08-08");
    expect(result.lines[0]?.valueDate).toBeNull();
  });

  it("carries the cheque number as a reference and the type through", () => {
    expect(result.lines[2]?.reference).toBe("001234");
    expect(result.lines[2]?.type).toBe("CHECK");
  });

  it("keeps the raw tags for later explanation", () => {
    expect(result.lines[0]?.raw["TRNTYPE"]).toBe("DEBIT");
    expect(result.lines[0]?.raw["FITID"]).toBe("202608040001");
  });

  it("reads the closing ledger balance", () => {
    expect(result.ledgerBalance?.toDecimalString()).toBe("23143.58");
    expect(result.balanceAsOf).toBe("2026-08-31");
  });

  it("normalises descriptions the same way the CSV path does", () => {
    expect(result.lines[1]?.normalisedDescription).toBe("SETTLEMENT");
  });
});

describe("degraded input", () => {
  it("warns and falls back when no currency is declared", () => {
    const noCurrency = "<OFX><STMTTRN><DTPOSTED>20260801<TRNAMT>-1.00</STMTTRN></OFX>";
    const result = importOfx(noCurrency, { currency: USD });
    expect(result.account.currency).toBe(USD);
    expect(result.warnings.join(" ")).toMatch(/no currency/);
  });

  it("warns on an unknown declared currency rather than throwing", () => {
    const odd = "<OFX><CURDEF>XYZ<STMTTRN><DTPOSTED>20260801<TRNAMT>-1.00</STMTTRN></OFX>";
    const result = importOfx(odd);
    expect(result.account.currency).toBe(GBP);
    expect(result.warnings.join(" ")).toMatch(/unknown currency XYZ/);
  });

  it("reports a transaction missing its date or amount", () => {
    const broken = [
      "<OFX><CURDEF>GBP",
      "<STMTTRN><TRNAMT>-1.00</STMTTRN>",
      "<STMTTRN><DTPOSTED>20260801</STMTTRN>",
      "<STMTTRN><DTPOSTED>20260802<TRNAMT>-3.00</STMTTRN>",
      "</OFX>",
    ].join("\n");
    const result = importOfx(broken);
    expect(result.lines).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.reason).toMatch(/DTPOSTED/);
    expect(result.errors[1]?.reason).toMatch(/TRNAMT/);
  });

  it("reports a malformed amount without losing the file", () => {
    const broken = "<OFX><CURDEF>GBP<STMTTRN><DTPOSTED>20260801<TRNAMT>abc</STMTTRN></OFX>";
    const result = importOfx(broken);
    expect(result.lines).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("handles an empty file", () => {
    const result = importOfx("");
    expect(result.lines).toEqual([]);
    expect(result.transactionCount).toBe(0);
  });

  it("falls back to positional ids when FITID is absent", () => {
    const noFitId = "<OFX><CURDEF>GBP<STMTTRN><DTPOSTED>20260801<TRNAMT>-1.00</STMTTRN></OFX>";
    expect(importOfx(noFitId).lines[0]?.id).toBe("OFX-0001");
  });
});

describe("format sniffing", () => {
  it("recognises OFX", () => {
    expect(looksLikeOfx(SAMPLE)).toBe(true);
    expect(looksLikeOfx("OFXHEADER:100")).toBe(true);
  });

  it("does not mistake CSV for OFX", () => {
    expect(looksLikeOfx("Date,Description,Amount\n01/08/2026,RENT,-950.00")).toBe(false);
  });
});
