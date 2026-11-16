import { describe, expect, it } from "vitest";
import { keyFromDescription, normalizeMerchant } from "../src/index.ts";

/** [description, expected key]. Invented examples in the shapes banks print. */
const CASES: [string, string][] = [
  ["SQ *SIP & SWIRL", "SIP AND SWIRL"],
  ["TST* BLUE HERON CAFE", "BLUE HERON CAFE"],
  ["PAYPAL *BELLROYOPER", "BELLROYOPER"],
  ["AMAZON MKTPL*B74LW12L0", "AMAZON"],
  ["AMZN Mktp US*2K4AB1CD0", "AMAZON"],
  ["Amazon.com*RT4XY99Z1", "AMAZON"],
  ["AMAZON PRIME*9Y0BJ4TQ3", "AMAZON PRIME"],
  ["SPACE AGE #24 KING CITY OR", "SPACE AGE"],
  ["FRED-MEYER #0355", "FRED MEYER"],
  ["SMITHS FOOD #4172", "SMITHS FOOD"],
  ["TOPP STOP TOPPENISH WA", "TOPP STOP"],
  ["76 - FASTB LLC 2708958 REDMOND WA", "76 FASTB LLC"],
  ["CINEMARK 1119 BOXCON", "CINEMARK BOXCON"],
  ["RECREATION.GOV", "RECREATION"],
  ["Deposit from Checking XXXXXXX7603", "DEPOSIT FROM CHECKING"],
  ["Withdrawal to Savings XXXXXXX4382", "WITHDRAWAL TO SAVINGS"],
  ["AUTOPAY 220627074405147RAUTOPAY AUTO-PMT", "AUTOPAY AUTO PMT"],
  ["Thankyou Points Redeemed TY OR276767758", "THANKYOU POINTS REDEEMED TY"],
  ["POS PURCHASE 483920", "POS PURCHASE"],
  ["CHECKCARD 0412 CORNER BAKERY", "CORNER BAKERY"],
  ["CAPITAL ONE AUTOPAY PYMT", "CAPITAL ONE AUTOPAY PYMT"],
  ["Monthly Interest Paid", "MONTHLY INTEREST PAID"],
  ["O'REILLY AUTO PARTS", "OREILLY AUTO PARTS"],
  ["  ", "UNKNOWN"],
  ["#42", "42"],
];

describe("merchant normalizer", () => {
  it.each(CASES)("%s -> %s", (description, key) => {
    expect(keyFromDescription(description)).toBe(key);
  });

  it("gives the same key whatever the store, city or reference", () => {
    const keys = new Set(
      ["SPACE AGE #24 KING CITY OR", "SPACE AGE #202 CASTLE ROCK WA", "Space Age #7"].map(keyFromDescription),
    );
    expect(keys.size).toBe(1);
  });

  it("prefers Plaid's merchant name and keeps it as the display name", () => {
    expect(normalizeMerchant("Smith's", "SMITHS FOOD #4172")).toEqual({ key: "SMITHS", name: "Smith's" });
    expect(normalizeMerchant(null, "SQ *SIP & SWIRL")).toEqual({ key: "SIP AND SWIRL", name: "Sip And Swirl" });
    expect(normalizeMerchant("  ", "TOPP STOP TOPPENISH WA").key).toBe("TOPP STOP");
  });
});
