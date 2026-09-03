// Use Actual's own reconciliation, not guessed matches against deleted data.
export const importOptions = {
  defaultCleared: true,
  payeeNameNormalization: "original"
};

function resultCounts(result) {
  if (!result || !Array.isArray(result.added) ||
      !Array.isArray(result.updated) || (result.errors != null && !Array.isArray(result.errors))) {
    throw new Error("Actual returned an unexpected reconciliation result.");
  }
  if (result.errors?.length) {
    throw new Error("Actual reported an error during reconciliation. No restore choice is available for this row.");
  }
  return { added: result.added.length, updated: result.updated.length };
}

export async function probeTransaction(api, accountId, transaction) {
  try {
    const normalResult = await api.importTransactions(
      accountId, [{ ...transaction }],
      { ...importOptions, dryRun: true, reimportDeleted: false }
    );
    const normal = resultCounts(normalResult);
    if (normal.added === 1 && normal.updated === 0) {
      return { classification: "new", reason: "Actual dry run: ready to add." };
    }
    if (normal.updated > 0) {
      return { classification: "actualMatched", reason: "Actual would reconcile this with an existing transaction; skipped to avoid modifying that match." };
    }
    if (normal.added !== 0) throw new Error("Unexpected number of additions in a single-row dry run.");

    const restoredResult = await api.importTransactions(
      accountId, [{ ...transaction }],
      { ...importOptions, dryRun: true, reimportDeleted: true }
    );
    const restored = resultCounts(restoredResult);
    if (restored.added === 1 && restored.updated === 0) {
      return {
        classification: "previouslyDeleted",
        reason: "Previously deleted — skipped. Actual would add this row only with reimporting deleted transactions enabled."
      };
    }
    const preview = Array.isArray(restoredResult.updatedPreview) ? restoredResult.updatedPreview : [];
    const suppressed = preview.some(item => item.tombstone || item.transaction?.tombstone || item.existing?.tombstone);
    if (!suppressed && preview.some(item => item.ignored === true || item.existing?.id)) {
      return { classification: "actualMatched", reason: "Actual matched an existing transaction but made no addition. An ignored match can be unchanged or reconciled/locked. Review the same-amount candidates before deciding whether this is a separate purchase." };
    }
    return { classification: "actualSkipped", reason: suppressed
      ? "Actual reports a suppressed/deleted row even with deleted reimports enabled. This may involve an Actual rule; no safe restore or separate-import choice was established."
      : "Skipped by Actual — reason unconfirmed. Neither preview established a recoverable deletion or an existing match." };
  } catch (error) {
    return { classification: "actualError", reason: `Reconciliation check failed: ${error.message || "Unknown error"}` };
  }
}

// Recheck immediately before each write. A restore choice never enables
// reimportDeleted for other rows, and a changed classification fails closed.
export async function importCandidate(api, accountId, transaction, expected, restoreSelected) {
  const current = await probeTransaction(api, accountId, transaction);
  const restore = expected === "previouslyDeleted" && restoreSelected &&
    current.classification === "previouslyDeleted";
  const normal = expected === "new" && current.classification === "new";
  if (!restore && !normal) return { added: [], updated: [], errors: [], skipped: true };
  return api.importTransactions(accountId, [{ ...transaction }], {
    ...importOptions, dryRun: false, reimportDeleted: restore
  });
}

function offsetDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function getMatchCandidates(api, accountId, transaction) {
  const [transactions, payees] = await Promise.all([
    api.getTransactions(accountId, offsetDate(transaction.date, -7), offsetDate(transaction.date, 7)),
    api.getPayees()
  ]);
  const names = new Map(payees.map(payee => [payee.id, payee.name]));
  const unique = new Map();
  for (const row of transactions.flatMap(row => [row, ...(row.subtransactions || [])])) {
    if (row.tombstone || row.amount !== transaction.amount) continue;
    const gap = Math.abs((Date.parse(`${row.date}T12:00:00Z`) - Date.parse(`${transaction.date}T12:00:00Z`)) / 86400000);
    if (!Number.isFinite(gap) || gap > 7) continue;
    unique.set(row.id, {
      id: row.id, date: row.date, amount: row.amount / 100,
      payee: row.imported_payee || row.payee_name || names.get(row.payee_id || row.payee) || "(no payee)",
      daysApart: gap, reconciled: !!row.reconciled
    });
  }
  return [...unique.values()].sort((a, b) => a.daysApart - b.daysApart);
}

export function canImportSeparately(transaction, candidates) {
  return !transaction.imported_id && candidates.length > 0 &&
    candidates.every(candidate => candidate.date !== transaction.date);
}

export async function importSeparateCandidate(api, accountId, transaction) {
  const skipped = { added: [], updated: [], errors: [], skipped: true };
  const current = await probeTransaction(api, accountId, transaction);
  if (current.classification !== "actualMatched") return skipped;
  const candidates = await getMatchCandidates(api, accountId, transaction);
  if (!canImportSeparately(transaction, candidates)) return skipped;
  // Per-row path verified in published API 26.9.0: retains rules/transfers,
  // bypasses matching only for this explicitly confirmed transaction.
  const separate = { ...transaction, forceAddTransaction: true };
  const preview = resultCounts(await api.importTransactions(accountId, [{ ...separate }], {
    ...importOptions, dryRun: true, reimportDeleted: false
  }));
  if (preview.added !== 1 || preview.updated !== 0) return skipped;
  return api.importTransactions(accountId, [{ ...separate }], {
    ...importOptions, dryRun: false, reimportDeleted: false
  });
}
