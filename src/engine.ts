import { Ledger, LedgerError } from "./ledger";

// Capacity is sold in GPU-hours over a window [start,end) (hours since epoch of the market).
export interface Offer { id: string; provider: string; sku: string; gpus: number; start: number; end: number; askCents: number; seq: number }
export interface Bid { id: string; buyer: string; sku: string; gpus: number; start: number; end: number; maxCents: number }
export interface Reservation { id: string; bidId: string; offerId: string; buyer: string; provider: string; sku: string; gpus: number; start: number; end: number; priceCents: number; totalCents: number; status: "reserved" | "delivered" | "cancelled" }

export const FEE_BPS = 300;          // platform fee on delivery: 3%
export const CANCEL_FEE_BPS = 1000;  // cancel before start: 10% to provider, rest refunded

export class Engine {
  offers: Offer[] = [];
  reservations: Reservation[] = [];
  private seq = 0;
  private rid = 0;
  constructor(public ledger = new Ledger()) {}

  deposit(buyer: string, cents: number, key: string) {
    this.ledger.transfer(`dep:${key}`, `deposit ${buyer}`, `external:bank`, `buyer:${buyer}:cash`, cents);
  }

  addOffer(o: Omit<Offer, "seq">) {
    if (o.gpus <= 0 || o.end <= o.start || o.askCents <= 0) throw new Error("invalid offer");
    this.offers.push({ ...o, seq: this.seq++ });
  }

  /** Remaining GPUs on an offer that are free for every hour of [start,end). */
  free(o: Offer, start: number, end: number) {
    let used = 0;
    for (const r of this.reservations) if (r.offerId === o.id && r.status === "reserved" && r.start < end && start < r.end) used += r.gpus;
    return o.gpus - used;
  }

  /**
   * Match a bid: cheapest ask first, then earliest offer (price-time priority). The bid can be split
   * across offers (partial fills) but each slice must cover the whole window. The buyer pays each
   * offer's ask (never above maxCents). Funds move cash -> escrow in the same step; if the buyer
   * can't fund a slice, matching stops there (no partial slice reserved without money).
   */
  match(b: Bid): Reservation[] {
    if (b.gpus <= 0 || b.end <= b.start) throw new Error("invalid bid");
    const hours = b.end - b.start;
    const cands = this.offers
      .filter((o) => o.sku === b.sku && o.start <= b.start && o.end >= b.end && o.askCents <= b.maxCents)
      .sort((x, y) => x.askCents - y.askCents || x.seq - y.seq);
    let need = b.gpus; const out: Reservation[] = [];
    for (const o of cands) {
      if (!need) break;
      const take = Math.min(need, this.free(o, b.start, b.end));
      if (take <= 0) continue;
      const total = take * hours * o.askCents;
      const id = `res-${++this.rid}`;
      try {
        this.ledger.transfer(`escrow:${id}`, `reserve ${id}`, `buyer:${b.buyer}:cash`, `escrow:${id}`, total);
      } catch (e) { if (e instanceof LedgerError) break; throw e; }
      const r: Reservation = { id, bidId: b.id, offerId: o.id, buyer: b.buyer, provider: o.provider, sku: b.sku, gpus: take, start: b.start, end: b.end, priceCents: o.askCents, totalCents: total, status: "reserved" };
      this.reservations.push(r); out.push(r); need -= take;
    }
    return out;
  }

  deliver(resId: string) {
    const r = this.get(resId);
    if (r.status !== "reserved") throw new Error(`cannot deliver ${r.status}`);
    const fee = Math.floor((r.totalCents * FEE_BPS) / 10000);
    this.ledger.post(`deliver:${r.id}`, `deliver ${r.id}`, [
      { account: `escrow:${r.id}`, amount: -r.totalCents },
      { account: `provider:${r.provider}:receivable`, amount: r.totalCents - fee },
      { account: `platform:fees`, amount: fee },
    ].filter((p) => p.amount !== 0));
    r.status = "delivered";
  }

  cancel(resId: string, now: number) {
    const r = this.get(resId);
    if (r.status !== "reserved") throw new Error(`cannot cancel ${r.status}`);
    if (now >= r.start) throw new Error("window already started");
    const penalty = Math.floor((r.totalCents * CANCEL_FEE_BPS) / 10000);
    this.ledger.post(`cancel:${r.id}`, `cancel ${r.id}`, [
      { account: `escrow:${r.id}`, amount: -r.totalCents },
      { account: `buyer:${r.buyer}:cash`, amount: r.totalCents - penalty },
      { account: `provider:${r.provider}:receivable`, amount: penalty },
    ].filter((p) => p.amount !== 0));
    r.status = "cancelled";
  }

  private get(id: string) { const r = this.reservations.find((x) => x.id === id); if (!r) throw new Error("no such reservation"); return r; }
}
