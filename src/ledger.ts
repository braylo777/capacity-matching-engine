// Double-entry ledger. Amounts are integer cents; every transaction's postings sum to zero.
export type Account = string; // e.g. "buyer:acme:cash", "escrow:res-1", "provider:p1:receivable", "platform:fees"
export interface Posting { account: Account; amount: number } // +debit / -credit convention: + increases the holder's balance
export interface Txn { id: string; memo: string; postings: Posting[]; at: number }

export class LedgerError extends Error {}

export class Ledger {
  private txns: Txn[] = [];
  private seen = new Map<string, Txn>();
  private bal = new Map<Account, number>();
  /** Accounts allowed to go negative (external funding sources). */
  constructor(private overdraftOk: (a: Account) => boolean = (a) => a.startsWith("external:")) {}

  post(id: string, memo: string, postings: Posting[], at = 0): Txn {
    const prior = this.seen.get(id);
    if (prior) {
      if (JSON.stringify(prior.postings) !== JSON.stringify(postings)) throw new LedgerError(`idempotency key ${id} reused with different postings`);
      return prior; // idempotent replay
    }
    if (postings.length < 2) throw new LedgerError("a transaction needs at least two postings");
    for (const p of postings) if (!Number.isSafeInteger(p.amount) || p.amount === 0) throw new LedgerError(`bad amount ${p.amount}`);
    if (postings.reduce((s, p) => s + p.amount, 0) !== 0) throw new LedgerError("unbalanced transaction");
    const next = new Map(this.bal);
    for (const p of postings) next.set(p.account, (next.get(p.account) ?? 0) + p.amount);
    for (const p of postings) if ((next.get(p.account) ?? 0) < 0 && !this.overdraftOk(p.account)) throw new LedgerError(`insufficient funds in ${p.account}`);
    const t: Txn = Object.freeze({ id, memo, postings: postings.map((p) => ({ ...p })), at }) as Txn;
    this.txns.push(t); this.seen.set(id, t); this.bal = next;
    return t;
  }
  transfer(id: string, memo: string, from: Account, to: Account, amount: number, at = 0) {
    return this.post(id, memo, [{ account: from, amount: -amount }, { account: to, amount }], at);
  }
  balance(a: Account) { return this.bal.get(a) ?? 0; }
  balances() { return new Map(this.bal); }
  journal(): readonly Txn[] { return this.txns; }
  /** Trial balance: sum over all accounts must be 0. */
  trialBalance() { let s = 0; for (const v of this.bal.values()) s += v; return s; }
  /** Rebuild balances from the journal and compare (detects any drift). */
  verify() {
    const re = new Map<Account, number>();
    for (const t of this.txns) for (const p of t.postings) re.set(p.account, (re.get(p.account) ?? 0) + p.amount);
    for (const [a, v] of this.bal) if ((re.get(a) ?? 0) !== v) return false;
    return this.trialBalance() === 0;
  }
}
