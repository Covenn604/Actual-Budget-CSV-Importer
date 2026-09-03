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
    const normal = resultCounts(await api.importTransactions(
      accountId, [{ ...transaction }],
      { ...importOptions, dryRun: true, reimportDeleted: false }
    ));
    if (normal.added === 1 && normal.updated === 0) {
      return { classification: "new", reason: "Actual dry run: ready to add." };
    }
    if (normal.updated > 0) {
      return { classification: "actualMatched", reason: "Actual would reconcile this with an existing transaction; skipped to avoid modifying that match." };
    }
    if (normal.added !== 0) throw new Error("Unexpected number of additions in a single-row dry run.");

    const restored = resultCounts(await api.importTransactions(
      accountId, [{ ...transaction }],
      { ...importOptions, dryRun: true, reimportDeleted: true }
    ));
    if (restored.added === 1 && restored.updated === 0) {
      return {
        classification: "previouslyDeleted",
        reason: "Previously deleted — skipped. Actual would add this row only with reimporting deleted transactions enabled."
      };
    }
    return { classification: "actualSkipped", reason: "Skipped by Actual — reason unconfirmed. The comparison did not identify a recoverable deleted import." };
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
