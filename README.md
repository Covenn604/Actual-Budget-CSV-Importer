# Actual Budget CSV Importer 3.1.1

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
