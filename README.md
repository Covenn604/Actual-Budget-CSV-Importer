# Actual Budget CSV Importer 3.2.1

V3.1 fixes Actual Budget connection setup and adds automatic budget discovery.

## Fixes

The Actual API expects the Sync ID positionally:

```js
await api.downloadBudget(syncId);
```

For E2E-encrypted budgets:

```js
await api.downloadBudget(syncId, { password: encryptionPassword });
```

V3.1 uses this call shape directly.

## Actual setup

1. Enter the Actual server URL.
2. Enter the server password.
3. Save the connection.
4. Click **Discover budgets**.
5. Select a budget by name.
6. Click **Use selected budget**.
7. Click **Test selected budget**.
8. Map each CSV profile to an Actual account.

The importer obtains the Sync ID from `getBudgets()` using the returned `groupId`, which matches the Sync ID shown in Actual Advanced Settings.

## Direct import safety

Direct imports still follow:

CSV → profile → normalize → preview → dry run → explicit confirmation → import

Imports use Actual `importTransactions` with:

- `dryRun: true` before a real import
- `reimportDeleted: false`
- `defaultCleared: true`
- `payeeNameNormalization: "original"`

If a bank CSV provides a stable transaction/reference ID, map it as **Imported ID** for stronger duplicate protection.

## Persistent storage

```text
/mnt/array/appsdata/actual_csv_converter/data:/app/data
```

Contains:

- `profiles/*.json`
- `settings.json`
- `actual-cache/`

Exported profile JSON does not contain Actual credentials or account mappings.

## Custom HTTPS certificate

The included compose file trusts:

```text
/mnt/array/appsdata/actual_budget/server.crt
```

through:

```yaml
NODE_EXTRA_CA_CERTS: /certs/actual-server.crt
```

## Deployment

GitHub Actions publishes:

```text
ghcr.io/covenn604/actual-budget-csv-importer:latest
ghcr.io/covenn604/actual-budget-csv-importer:3.1.0
```

Portainer exposes:

```text
8080:3000
```


## 3.1.1 patch

Budget discovery now deduplicates local/cached and remote copies of the same Actual budget.

Actual can return the same budget more than once from `getBudgets()`. The importer now groups entries by `groupId` / Sync ID and prefers the entry whose `state` is `remote`.

As a result, a budget such as `My Finances` should now appear only once in the selection dropdown.


## 3.2 — Duplicate Safety

Direct import now performs an independent duplicate preflight against the mapped Actual account before any real import is allowed.

The importer fetches existing transactions for the source statement's date range plus a seven-day buffer and classifies every incoming row:

- **Definite duplicate** — the same `imported_id` already exists.
- **Likely duplicate** — same date, same amount, and same normalized payee.
- **Possible match** — same amount with a similar payee within three days.
- **New** — no existing match was found.

Safe mode only sends **New** rows to Actual's `importTransactions`.

Definite, likely, and possible duplicates are skipped by the importer. The analysis is re-run server-side immediately before a confirmed import, so a stale browser preview cannot bypass the safety check.

Actual's own reconciliation/deduplication still runs on the safe subset.

This is intentionally conservative. A legitimate repeated purchase that looks identical to an existing transaction may be classified as a likely/possible duplicate and skipped. The review table makes these decisions visible before import.


## 3.2.1 — Per-profile Actual amount sign

Profiles now include a separate **Direct Actual import sign** setting.

This does not change the downloadable CSV. It only changes the amount used for:

- duplicate analysis against the Actual account
- Actual dry-run reconciliation
- direct Actual API imports

Available options:

- Preserve converted amount
- Invert amount
- Force negative
- Force positive

For a credit card profile where the source CSV contains `60.00` but Actual stores the purchase internally as `-60.00`, choose **Invert amount**.

Legacy profiles without this property default to `preserve`.
