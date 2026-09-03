import test from "node:test";
import assert from "node:assert/strict";
import { probeTransaction, importCandidate } from "../import-reconciliation.js";

const empty = { added: [], updated: [], errors: [] };
const added = { added: ["new-id"], updated: [], errors: [] };
const matched = { added: [], updated: ["existing-id"], errors: [] };
const transaction = { date: "2026-09-01", amount: -232, payee_name: "TIM HORTONS" };
function mock(...results) {
  const calls = [];
  return {
    calls,
    async importTransactions(account, rows, options) {
      calls.push({ account, rows, options });
      assert.equal(account, "account");
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], transaction);
      assert.ok(results.length, "No unexpected API calls");
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

test("ordinary new row uses only a non-restoring dry run", async () => {
  const api = mock(added);
  assert.equal((await probeTransaction(api, "account", transaction)).classification, "new");
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].options.dryRun, true);
  assert.equal(api.calls[0].options.reimportDeleted, false);
});
test("deleted classification requires the restore-only addition", async () => {
  const api = mock(empty, added);
  assert.equal((await probeTransaction(api, "account", transaction)).classification, "previouslyDeleted");
  assert.deepEqual(api.calls.map(c => c.options.reimportDeleted), [false, true]);
  assert.ok(api.calls.every(c => c.options.dryRun));
});
test("skipped in both runs is not labelled deleted", async () => {
  assert.equal((await probeTransaction(mock(empty, empty), "account", transaction)).classification, "actualSkipped");
});
test("an Actual match is not treated as a new or deleted transaction", async () => {
  const api = mock(matched);
  assert.equal((await probeTransaction(api, "account", transaction)).classification, "actualMatched");
  assert.equal(api.calls.length, 1);
});
test("a restore-run update does not prove a deleted import", async () => {
  assert.equal((await probeTransaction(mock(empty, matched), "account", transaction)).classification, "actualSkipped");
});
test("errors and malformed results fail closed", async () => {
  for (const result of [new Error("offline"), {}, { ...empty, errors: ["failure"] }]) {
    assert.equal((await probeTransaction(mock(result), "account", transaction)).classification, "actualError");
  }
  assert.equal((await probeTransaction(mock(empty, new Error("offline")), "account", transaction)).classification, "actualError");
});
test("missing optional errors field accepts valid addition arrays", async () => {
  assert.equal((await probeTransaction(mock({ added: ["id"], updated: [] }), "account", transaction)).classification, "new");
});
test("unchecked deleted row never causes a write", async () => {
  const api = mock(empty, added);
  assert.equal((await importCandidate(api, "account", transaction, "previouslyDeleted", false)).skipped, true);
  assert.ok(api.calls.every(c => c.options.dryRun));
});
test("selected deleted row is rechecked and imported with restore enabled", async () => {
  const api = mock(empty, added, added);
  await importCandidate(api, "account", transaction, "previouslyDeleted", true);
  assert.deepEqual(api.calls.map(c => [c.options.dryRun, c.options.reimportDeleted]), [[true, false], [true, true], [false, true]]);
});
test("normal import never enables restoring deleted transactions", async () => {
  const api = mock(added, added);
  await importCandidate(api, "account", transaction, "new", true);
  assert.equal(api.calls.at(-1).options.reimportDeleted, false);
  assert.equal(api.calls.at(-1).options.dryRun, false);
});
test("stale choice becoming an existing match never writes", async () => {
  const api = mock(matched);
  assert.equal((await importCandidate(api, "account", transaction, "previouslyDeleted", true)).skipped, true);
  assert.ok(api.calls.every(c => c.options.dryRun));
});
test("new row becoming deleted does not silently opt into restoring", async () => {
  const api = mock(empty, added);
  assert.equal((await importCandidate(api, "account", transaction, "new", false)).skipped, true);
  assert.ok(api.calls.every(c => c.options.dryRun));
});
