# Actual Budget CSV Importer 3.0

Adds optional direct import into self-hosted Actual Budget while keeping CSV download support.

## New
- Actual server URL / Sync ID / password setup
- Account discovery
- Local profile-to-Actual-account mapping
- Mapping is excluded from exported profile JSON
- Optional Imported ID source column
- Actual `importTransactions` dry run
- Explicit confirmation before real import
- `reimportDeleted: false`
- Persistent Actual API cache

## Persistent data
`/mnt/array/appsdata/actual_csv_converter/data:/app/data`

Contains:
- `profiles/*.json`
- `settings.json` (private Actual connection + account mappings)
- `actual-cache/`

Do not commit this data directory.

## Actual connection
Get your budget Sync ID from Actual Settings → Advanced / Show advanced settings.

Then open **Actual setup**:
1. Enter Actual server URL.
2. Enter Sync ID.
3. Enter server password.
4. Enter encryption password only if your budget uses E2E encryption.
5. Save and test.
6. Map each CSV profile to an Actual account.

## Import safety
A direct import always starts with Actual's dry-run reconciliation. The real import is a separate confirmed action.

If a bank CSV exposes a stable reference/transaction ID, map it as **Imported ID**. This gives Actual the strongest duplicate protection.

## Deployment
GitHub Actions publishes:
`ghcr.io/covenn604/actual-budget-csv-importer:latest`

Portainer mapping:
`8080:3000`
