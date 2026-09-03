import test from "node:test";
import assert from "node:assert/strict";
import { probeTransaction, getMatchCandidates, canImportSeparately, importSeparateCandidate, importCandidate } from "../import-reconciliation.js";

// Simulated responses using the shapes in the published API 26.9.0 bundle.
const empty = { added: [], updated: [], errors: [] };
const added = { added: ["new"], updated: [], errors: [] };
const ignored = { ...empty, updatedPreview: [{ transaction: {}, ignored: true }] };
const suppressed = { ...empty, updatedPreview: [{ transaction: {}, tombstone: true, existing: false }] };
const incoming = { date: "2026-09-01", amount: -232, payee_name: "TIM HORTONS" };
const earlier = { id: "earlier", date: "2026-08-27", amount: -232, payee: "payee", reconciled: true };
function fixture(results = [ignored, ignored, added, added], existing = [earlier]) {
  const calls = [];
  return {
    calls,
    async importTransactions(account, rows, options) {
      calls.push({ rows: structuredClone(rows), options });
      assert.equal(account, "account");
      assert.equal(rows.length, 1);
      assert.ok(results.length, "unexpected API call");
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    async getTransactions(account, start, end) {
      assert.equal(account, "account");
      assert.ok(start <= end);
      return structuredClone(existing);
    },
    async getPayees() { return [{ id: "payee", name: "Tim Hortons" }]; }
  };
}
test("ignored preview with zero counts is an Actual match", async () => {
  assert.equal((await probeTransaction(fixture([ignored, ignored]), "account", incoming)).classification, "actualMatched");
});
test("suppressed preview is not an active match", async () => {
  const result = await probeTransaction(fixture([suppressed, suppressed]), "account", incoming);
  assert.equal(result.classification, "actualSkipped");
  assert.match(result.reason, /suppressed/);
});
test("ignored normal result with successful restore is still a deleted import", async () => {
  assert.equal((await probeTransaction(fixture([ignored, added]), "account", incoming)).classification, "previouslyDeleted");
});
test("Tim Hortons candidate shows signed amount, date, payee and five-day gap", async () => {
  const rows = await getMatchCandidates(fixture(), "account", incoming);
  assert.equal(rows[0].date, "2026-08-27");
  assert.equal(rows[0].amount, -2.32);
  assert.equal(rows[0].payee, "Tim Hortons");
  assert.equal(rows[0].daysApart, 5);
  assert.equal(canImportSeparately(incoming, rows), true);
});
test("seven-day Pizza candidate included; eight-day candidate excluded", async () => {
  const pizza = { date: "2026-08-27", amount: -735, payee_name: "PIZZA 2001" };
  const rows = await getMatchCandidates(fixture([], [
    { ...earlier, date: "2026-08-20", amount: -735 },
    { ...earlier, id: "outside", date: "2026-08-19", amount: -735 }
  ]), "account", pizza);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].daysApart, 7);
  assert.equal(canImportSeparately(pizza, rows), true);
});
test("selected separate row uses force only in last preview and write", async () => {
  const api = fixture();
  assert.equal((await importSeparateCandidate(api, "account", incoming)).added.length, 1);
  assert.deepEqual(api.calls.map(c => !!c.rows[0].forceAddTransaction), [false, false, true, true]);
  assert.deepEqual(api.calls.map(c => c.options.dryRun), [true, true, true, false]);
  assert.equal(api.calls.at(-1).options.reimportDeleted, false);
  assert.equal(incoming.forceAddTransaction, undefined);
});
test("unchecked match never bypasses reconciliation", async () => {
  const api = fixture([ignored, ignored]);
  assert.equal((await importCandidate(api, "account", incoming, "actualMatched", false)).skipped, true);
  assert.ok(api.calls.every(c => c.options.dryRun && !c.rows[0].forceAddTransaction));
});
test("bank IDs, same-day matches and absent candidates block writes", async () => {
  for (const [transaction, existing] of [
    [{ ...incoming, imported_id: "bank-id" }, [earlier]],
    [incoming, [{ ...earlier, date: incoming.date }]], [incoming, []]
  ]) {
    const api = fixture([ignored, ignored], existing);
    assert.equal((await importSeparateCandidate(api, "account", transaction)).skipped, true);
    assert.ok(api.calls.every(c => c.options.dryRun && !c.rows[0].forceAddTransaction));
  }
});
test("new same-day match prevents stale separate choice", async () => {
  const api = fixture([ignored, ignored], [earlier, { ...earlier, id: "newer", date: incoming.date }]);
  assert.equal((await importSeparateCandidate(api, "account", incoming)).skipped, true);
  assert.ok(api.calls.every(c => c.options.dryRun));
});
test("unsuccessful bypass preview prevents write", async () => {
  const api = fixture([ignored, ignored, empty]);
  assert.equal((await importSeparateCandidate(api, "account", incoming)).skipped, true);
  assert.ok(api.calls.every(c => c.options.dryRun));
});
test("bypass preview error prevents write", async () => {
  const api = fixture([ignored, ignored, new Error("offline")]);
  await assert.rejects(importSeparateCandidate(api, "account", incoming), /offline/);
  assert.ok(api.calls.every(c => c.options.dryRun));
});
test("unknown skips and deleted rows cannot use separate-purchase route", async () => {
  for (const results of [[empty, empty], [empty, added], [suppressed, suppressed]]) {
    const api = fixture(results);
    assert.equal((await importSeparateCandidate(api, "account", incoming)).skipped, true);
    assert.ok(api.calls.every(c => c.options.dryRun));
  }
});
