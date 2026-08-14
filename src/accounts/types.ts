/**
 * Account classification and normal balances.
 *
 * The five statement classes determine which side of a posting increases an
 * account. Getting this wrong is the single most common source of a report
 * that balances arithmetically but reads backwards, so the mapping lives in
 * one table and everything else derives from it.
 */

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export const ACCOUNT_TYPES: readonly AccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

/** The side on which an account's balance normally sits. */
export type NormalBalance = "debit" | "credit";

const NORMAL_BALANCE: Record<AccountType, NormalBalance> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  income: "credit",
};

export function normalBalanceOf(type: AccountType): NormalBalance {
  return NORMAL_BALANCE[type];
}

/** +1 when a debit increases this type, -1 when a debit decreases it. */
export function debitSign(type: AccountType): 1 | -1 {
  return NORMAL_BALANCE[type] === "debit" ? 1 : -1;
}

/** Accounts that appear on the balance sheet rather than the P&L. */
export function isBalanceSheet(type: AccountType): boolean {
  return type === "asset" || type === "liability" || type === "equity";
}

/** Accounts closed out to retained earnings at period end. */
export function isTemporary(type: AccountType): boolean {
  return type === "income" || type === "expense";
}

export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}
