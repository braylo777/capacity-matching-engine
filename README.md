# Capacity Reservation & Matching Engine

A market for reserving GPU capacity by the GPU-hour: providers post offers (SKU, GPUs, time window, ask), buyers post bids, and every money movement goes through a **double-entry ledger** with escrow. Correctness is checked with **property-based tests**.

**Playground:** https://capacity-matching-engine.braylo777.workers.dev (runs in the browser; providers and balances are sample data)

## Design
- **Ledger** (`src/ledger.ts`): integer cents; every transaction has ≥ 2 postings summing to 0; atomic overdraft check (only `external:*` accounts may go negative); idempotency keys (replay returns the original, reuse with different postings throws); frozen journal entries; `verify()` rebuilds balances from the journal.
- **Matching** (`src/engine.ts`): price-time priority (cheapest ask, then earliest offer); bids split across offers (partial fills) but every slice covers the whole window; capacity is checked per overlapping window, so disjoint windows reuse the same GPUs; the buyer pays the ask, never above their max.
- **Lifecycle**: reserve = buyer cash → `escrow:<res>` in the same step (no unfunded reservations) · deliver = escrow → provider receivable minus a 3% platform fee · cancel before start = 90% refund, 10% to the provider.

## Tests (15, Vitest + fast-check)
10 example tests plus 5 properties, each over 300 random markets (≤ 12 offers, ≤ 25 bids, ≤ 30 random deliver/cancel actions):
1. Trial balance is always 0 and balances rebuild exactly from the journal.
2. Money is conserved: deposits = cash + escrow + receivables + fees; no internal account goes negative.
3. No offer is over-allocated in any hour.
4. Fills respect bid size, max price, SKU, window, and total = GPUs × hours × price.
5. Escrow holds exactly the total for open reservations and 0 for settled ones.

The property suite caught a real edge case during the build (zero-amount deposits are rejected by the ledger), which is now an explicit rule.

```bash
npm ci && npm test && npm run build
```
In-memory by design (the ledger is the system of record in tests). A Postgres adapter would persist the same `Txn` rows; not built yet. See `DEPLOYS.md` for deploys and rollback points.
