import { Engine } from "../src/engine";
const e = new Engine();
for (const [u, c] of [["acme", 500_000], ["labs", 150_000]] as const) e.deposit(u, c, u);
const offers = [["o1","coreweave-sim","H100",8,0,72,249],["o2","lambda-sim","H100",16,0,48,229],["o3","vast-sim","H100",4,0,72,189],["o4","runpod-sim","A100",8,0,72,119],["o5","crusoe-sim","H200",8,0,72,349]] as const;
for (const [id, provider, sku, gpus, start, end, askCents] of offers) e.addOffer({ id, provider, sku, gpus, start, end, askCents });
let n = 0;
const $ = (id: string) => document.getElementById(id)!;
const usd = (c: number) => "$" + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });
function render() {
  $("offers").innerHTML = "<tr><th>Offer</th><th>Provider</th><th>SKU</th><th>GPUs free now</th><th>Window (h)</th><th>Ask /GPU-h</th></tr>" + e.offers.map((o) => `<tr><td>${o.id}</td><td>${o.provider}</td><td>${o.sku}</td><td>${e.free(o, 0, 1)}/${o.gpus}</td><td>${o.start}–${o.end}</td><td>${usd(o.askCents)}</td></tr>`).join("");
  $("res").innerHTML = "<tr><th>ID</th><th>Buyer</th><th>Offer</th><th>GPUs</th><th>Hours</th><th>Total</th><th>Status</th><th></th></tr>" + e.reservations.map((r) => `<tr><td>${r.id}</td><td>${r.buyer}</td><td>${r.offerId}</td><td>${r.gpus}</td><td>${r.start}–${r.end}</td><td>${usd(r.totalCents)}</td><td>${r.status}</td><td>${r.status === "reserved" ? `<button data-d="${r.id}">deliver</button> <button data-c="${r.id}">cancel</button>` : ""}</td></tr>`).join("");
  const b = [...e.ledger.balances()].sort();
  $("bal").innerHTML = "<tr><th>Account</th><th>Balance</th></tr>" + b.map(([a, v]) => `<tr><td>${a}</td><td>${usd(v)}</td></tr>`).join("") + `<tr><td><b>Trial balance (must be 0)</b></td><td><b>${usd(e.ledger.trialBalance())}</b> ${e.ledger.verify() ? "✓ rebuilt from journal" : "✗"}</td></tr>`;
  $("journal").textContent = e.ledger.journal().slice(-12).map((t) => `${t.id.padEnd(16)} ${t.memo.padEnd(22)} ` + t.postings.map((p) => `${p.account} ${p.amount > 0 ? "+" : ""}${(p.amount / 100).toFixed(2)}`).join(" | ")).join("\n");
}
$("bid").onclick = () => {
  const v = (id: string) => ($(id) as HTMLInputElement).value;
  const start = +v("start");
  const r = e.match({ id: `b${++n}`, buyer: v("buyer"), sku: v("sku"), gpus: +v("gpus"), start, end: start + +v("hours"), maxCents: Math.round(+v("max") * 100) });
  $("msg").textContent = r.length ? `Filled ${r.reduce((s, x) => s + x.gpus, 0)} GPUs across ${r.length} offer(s).` : "No fill (price, capacity, window or funds).";
  render();
};
document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  try { if (t.dataset.d) e.deliver(t.dataset.d); if (t.dataset.c) e.cancel(t.dataset.c, -1); } catch (err) { $("msg").textContent = String(err); }
  if (t.dataset.d || t.dataset.c) render();
});
render();
