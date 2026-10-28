import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Ledger, LedgerError } from "../src/ledger";
import { Engine, FEE_BPS } from "../src/engine";

describe("ledger", () => {
  it("rejects unbalanced, zero, fractional and single-leg transactions", () => {
    const l = new Ledger();
    expect(() => l.post("a", "x", [{ account: "external:a", amount: -5 }, { account: "b", amount: 4 }])).toThrow(LedgerError);
    expect(() => l.post("b", "x", [{ account: "external:a", amount: 0 }, { account: "b", amount: 0 }])).toThrow();
    expect(() => l.post("c", "x", [{ account: "external:a", amount: -1.5 }, { account: "b", amount: 1.5 }])).toThrow();
    expect(() => l.post("d", "x", [{ account: "b", amount: 1 }])).toThrow();
    expect(l.journal()).toHaveLength(0);
  });
  it("blocks overdraft atomically", () => {
    const l = new Ledger();
    l.transfer("1", "fund", "external:bank", "u:cash", 100);
    expect(() => l.transfer("2", "spend", "u:cash", "m", 101)).toThrow(/insufficient/);
    expect(l.balance("u:cash")).toBe(100);
    expect(l.balance("m")).toBe(0);
  });
  it("is idempotent on replay and rejects key reuse with different postings", () => {
    const l = new Ledger();
    l.transfer("k", "fund", "external:bank", "u", 50);
    l.transfer("k", "fund", "external:bank", "u", 50);
    expect(l.balance("u")).toBe(50);
    expect(() => l.transfer("k", "fund", "external:bank", "u", 51)).toThrow(/idempotency/);
  });
  it("journal entries are immutable", () => {
    const l = new Ledger(); const t = l.transfer("k", "f", "external:bank", "u", 5);
    expect(() => { (t as any).id = "z"; }).toThrow();
  });
});

describe("engine", () => {
  const setup = () => {
    const e = new Engine();
    e.deposit("acme", 1_000_000, "1");
    e.addOffer({ id: "o1", provider: "p1", sku: "H100", gpus: 8, start: 0, end: 100, askCents: 250 });
    e.addOffer({ id: "o2", provider: "p2", sku: "H100", gpus: 8, start: 0, end: 100, askCents: 200 });
    e.addOffer({ id: "o3", provider: "p3", sku: "H100", gpus: 8, start: 0, end: 100, askCents: 200 });
    return e;
  };
  it("fills cheapest first, then earliest at the same price, with partial fills", () => {
    const e = setup();
    const r = e.match({ id: "b1", buyer: "acme", sku: "H100", gpus: 12, start: 10, end: 20, maxCents: 300 });
    expect(r.map((x) => [x.offerId, x.gpus])).toEqual([["o2", 8], ["o3", 4]]);
    expect(e.ledger.balance("buyer:acme:cash")).toBe(1_000_000 - 12 * 10 * 200);
  });
  it("never pays above the bid's max", () => {
    const e = setup();
    expect(e.match({ id: "b", buyer: "acme", sku: "H100", gpus: 4, start: 0, end: 1, maxCents: 199 })).toEqual([]);
  });
  it("respects time windows: overlapping reservations share capacity, disjoint ones don't", () => {
    const e = new Engine(); e.deposit("a", 1e7, "1");
    e.addOffer({ id: "o", provider: "p", sku: "A100", gpus: 4, start: 0, end: 48, askCents: 100 });
    expect(e.match({ id: "1", buyer: "a", sku: "A100", gpus: 4, start: 0, end: 24, maxCents: 100 })).toHaveLength(1);
    expect(e.match({ id: "2", buyer: "a", sku: "A100", gpus: 1, start: 12, end: 30, maxCents: 100 })).toHaveLength(0);
    expect(e.match({ id: "3", buyer: "a", sku: "A100", gpus: 4, start: 24, end: 48, maxCents: 100 })).toHaveLength(1);
  });
  it("delivery pays provider minus 3% fee; cancel refunds 90%", () => {
    const e = setup();
    const [a] = e.match({ id: "b", buyer: "acme", sku: "H100", gpus: 2, start: 10, end: 20, maxCents: 300 });
    e.deliver(a.id);
    expect(e.ledger.balance("platform:fees")).toBe(Math.floor((4000 * FEE_BPS) / 10000));
    expect(e.ledger.balance("provider:p2:receivable")).toBe(4000 - 120);
    const [c] = e.match({ id: "b2", buyer: "acme", sku: "H100", gpus: 1, start: 50, end: 60, maxCents: 300 });
    const before = e.ledger.balance("buyer:acme:cash");
    e.cancel(c.id, 40);
    expect(e.ledger.balance("buyer:acme:cash") - before).toBe(1800);
    expect(() => e.deliver(c.id)).toThrow();
    expect(() => e.deliver(a.id)).toThrow();
  });
  it("can't cancel after the window starts", () => {
    const e = setup();
    const [a] = e.match({ id: "b", buyer: "acme", sku: "H100", gpus: 1, start: 10, end: 20, maxCents: 300 });
    expect(() => e.cancel(a.id, 10)).toThrow(/started/);
  });
  it("stops matching when the buyer runs out of money (no unfunded reservation)", () => {
    const e = new Engine(); e.deposit("poor", 1000, "1");
    e.addOffer({ id: "o", provider: "p", sku: "H100", gpus: 8, start: 0, end: 10, askCents: 200 });
    expect(e.match({ id: "b", buyer: "poor", sku: "H100", gpus: 8, start: 0, end: 10, maxCents: 200 })).toEqual([]);
    expect(e.reservations).toHaveLength(0);
  });
});

// ---- property tests (fast-check): random markets + random action sequences ----
const offerArb = fc.record({ gpus: fc.integer({ min: 1, max: 8 }), start: fc.integer({ min: 0, max: 20 }), len: fc.integer({ min: 1, max: 30 }), ask: fc.integer({ min: 50, max: 500 }), sku: fc.constantFrom("H100", "A100") });
const bidArb = fc.record({ gpus: fc.integer({ min: 1, max: 20 }), start: fc.integer({ min: 0, max: 30 }), len: fc.integer({ min: 1, max: 10 }), max: fc.integer({ min: 40, max: 600 }), sku: fc.constantFrom("H100", "A100"), buyer: fc.constantFrom("a", "b", "c") });
const actArb = fc.array(fc.record({ kind: fc.constantFrom("deliver", "cancel", "none"), pick: fc.nat(), now: fc.integer({ min: 0, max: 40 }) }), { maxLength: 30 });

function runMarket(offers: any[], bids: any[], acts: any[], deposits: number[]) {
  const e = new Engine();
  ["a", "b", "c"].forEach((u, i) => e.deposit(u, deposits[i], u));
  offers.forEach((o, i) => e.addOffer({ id: `o${i}`, provider: `p${i % 3}`, sku: o.sku, gpus: o.gpus, start: o.start, end: o.start + o.len, askCents: o.ask }));
  const fills: { bid: any; res: any[] }[] = [];
  bids.forEach((b, i) => fills.push({ bid: b, res: e.match({ id: `b${i}`, buyer: b.buyer, sku: b.sku, gpus: b.gpus, start: b.start, end: b.start + b.len, maxCents: b.max }) }));
  for (const a of acts) {
    const open = e.reservations.filter((r) => r.status === "reserved");
    if (!open.length || a.kind === "none") continue;
    const r = open[a.pick % open.length];
    try { a.kind === "deliver" ? e.deliver(r.id) : e.cancel(r.id, a.now); } catch {}
  }
  return { e, fills };
}
const market = fc.tuple(fc.array(offerArb, { maxLength: 12 }), fc.array(bidArb, { maxLength: 25 }), actArb, fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 3, maxLength: 3 }));

describe("properties", () => {
  it("ledger always balances and rebuilds exactly from the journal", () => {
    fc.assert(fc.property(market, ([o, b, a, d]) => {
      const { e } = runMarket(o, b, a, d);
      expect(e.ledger.trialBalance()).toBe(0);
      expect(e.ledger.verify()).toBe(true);
    }), { numRuns: 300 });
  });
  it("money is conserved: deposits = cash + escrow + receivables + fees; no internal account negative", () => {
    fc.assert(fc.property(market, ([o, b, a, d]) => {
      const { e } = runMarket(o, b, a, d);
      let internal = 0;
      for (const [acct, v] of e.ledger.balances()) if (!acct.startsWith("external:")) { internal += v; expect(v).toBeGreaterThanOrEqual(0); }
      expect(internal).toBe(d.reduce((x, y) => x + y, 0));
    }), { numRuns: 300 });
  });
  it("no offer is ever over-allocated in any hour", () => {
    fc.assert(fc.property(market, ([o, b, a, d]) => {
      const { e } = runMarket(o, b, a, d);
      for (const off of e.offers) for (let h = off.start; h < off.end; h++) {
        const used = e.reservations.filter((r) => r.offerId === off.id && r.status === "reserved" && r.start <= h && h < r.end).reduce((s, r) => s + r.gpus, 0);
        expect(used).toBeLessThanOrEqual(off.gpus);
      }
    }), { numRuns: 300 });
  });
  it("fills respect bid size, max price, SKU and window", () => {
    fc.assert(fc.property(market, ([o, b, a, d]) => {
      const { e, fills } = runMarket(o, b, a, d);
      for (const { bid, res } of fills) {
        expect(res.reduce((s, r) => s + r.gpus, 0)).toBeLessThanOrEqual(bid.gpus);
        for (const r of res) {
          const off = e.offers.find((x) => x.id === r.offerId)!;
          expect(r.priceCents).toBeLessThanOrEqual(bid.max);
          expect(off.sku).toBe(bid.sku);
          expect(off.start <= r.start && r.end <= off.end).toBe(true);
          expect(r.totalCents).toBe(r.gpus * (r.end - r.start) * r.priceCents);
        }
      }
    }), { numRuns: 300 });
  });
  it("escrow is empty for every settled reservation and holds the exact total for open ones", () => {
    fc.assert(fc.property(market, ([o, b, a, d]) => {
      const { e } = runMarket(o, b, a, d);
      for (const r of e.reservations) expect(e.ledger.balance(`escrow:${r.id}`)).toBe(r.status === "reserved" ? r.totalCents : 0);
    }), { numRuns: 300 });
  });
});
