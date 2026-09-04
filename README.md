# Actual Budget CSV Importer

A self-hosted web app for converting bank and credit-card CSV statements into an Actual Budget-friendly format. Download a converted CSV or review and import transactions directly into Actual.

**Current version:** 3.3.4 · **Bundled Actual API:** 26.9.0

## Contents

- [Install](#install)
- [Set up CSV profiles](#set-up-csv-profiles)
- [Connect to Actual](#connect-to-actual)
- [Review and import transactions](#review-and-import-transactions)
- [Update an existing installation](#update-an-existing-installation)
- [Troubleshooting](#troubleshooting)
- [Data storage and privacy](#data-storage-and-privacy)
- [Changelog](#changelog)

## Install

You need Docker with Docker Compose, or Portainer. An Actual Server is needed only for direct imports; CSV conversion works without it.

The default browser address is `http://YOUR-SERVER:8080`.

### Option 1: Portainer

1. Download this repository using **Code → Download ZIP** and extract it.
2. Create a persistent data folder on your Docker host, such as `/opt/actual-budget-csv-importer/data` or `/mnt/tank/apps/actual-budget-csv-importer`.
3. In Portainer, choose **Stacks → Add stack** and paste the contents of [docker-compose.yml](docker-compose.yml).
4. Add the environment variables you need from the table below. Set `IMPORTER_DATA_PATH` to the host folder you created.
5. Follow the certificate instructions below if needed, then deploy the stack.
6. Open the importer in your browser.

### Option 2: Docker Compose

Download and extract this repository. Copy [.env.example](.env.example) to `.env`, adjust the values, and review the certificate instructions below.

From the extracted project folder:

```bash
docker compose up -d
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `IMPORTER_IMAGE` | `ghcr.io/covenn604/actual-budget-csv-importer:latest` | Container image; use `:3.3.4` to pin this version. |
| `IMPORTER_CONTAINER_NAME` | `actual-budget-csv-importer` | Container name. |
| `IMPORTER_PORT` | `8080` | Browser access port on the host. |
| `IMPORTER_DATA_PATH` | `./data` | Host folder for saved settings and profiles. Use an absolute host path in Portainer. |
| `ACTUAL_CACHE_IDLE_MINUTES` | `20` | Minutes of Actual API inactivity before temporary budget-cache cleanup; minimum 1. |
| `ACTUAL_CA_CERT_PATH` | `./certs/actual-server.crt` | Host path to a trusted custom CA/server certificate, if required. |
| `NODE_EXTRA_CA_CERTS` | `/certs/actual-server.crt` | Certificate path inside the importer container. |

### HTTPS and custom certificates

If your Actual Server uses a private or self-signed certificate:

1. Put the trusted certificate on the Docker host.
2. Set `ACTUAL_CA_CERT_PATH` to that file's host path.
3. Keep the certificate volume mount and `NODE_EXTRA_CA_CERTS` entry in the Compose file.
4. Use an Actual Server URL whose hostname matches the certificate.

**If you do not need a custom certificate**, remove both the certificate volume mount and the `NODE_EXTRA_CA_CERTS` entry from [docker-compose.yml](docker-compose.yml) or your Portainer stack. The supplied configuration includes them by default.

Do not disable TLS verification to work around certificate errors.

## Set up CSV profiles

No institution-specific profiles are bundled. Create a profile for each statement format you use:

1. Upload a sample statement.
2. Map its date and description/payee columns.
3. Map either a single amount column or separate debit and credit columns.
4. If available, map a stable transaction reference to **Imported ID**.
5. Check the date format, amount signs, and preview, then save the profile.

Profiles can be exported, imported, and deleted. Use the preview to verify a profile before importing a full statement.

### Amount signs: payments versus deposits

Actual uses **negative amounts for payments/outflows** and **positive amounts for deposits/inflows**.

There are two stages: CSV conversion first, then the direct-import sign setting. The safe-import review shows the final signed amount that will be sent to Actual alongside the converted source amount.

For a credit-card statement where purchases are positive and payments received are negative, preserve those source signs during conversion and use **Invert amount** for direct import. For example:

- A purchase of `2.32` becomes `-2.32`: a payment in Actual.
- A payment received of `-4982.88` becomes `4982.88`: a deposit in Actual.

**Force negative** makes every transaction a payment. **Force positive** makes every transaction a deposit. Neither is suitable for a statement that needs both directions. Mixed-sign statements using either setting trigger an additional warning and an **Import anyway** confirmation.

## Connect to Actual

Skip this section if you only want to download converted CSV files.

1. Open **Actual setup**.
2. Enter your Actual Server URL and password. Add the budget encryption password if your budget requires one.
3. Save the connection settings.
4. Discover budgets, select the correct budget, and use it.
5. Test the budget connection.
6. Map each CSV profile to its destination Actual account.

The compatibility display shows the importer version, bundled Actual API version, and detected Actual Server version using `getServerVersion()`.

**The bundled API and Actual Server versions should match.** Version differences can cause migration errors or **“No budget file is open”**. Resolve a mismatch before importing; see [Troubleshooting](#troubleshooting).

Your saved budget selection persists across reloads and remains visible if budget discovery temporarily fails.

## Review and import transactions

Upload a statement, select its profile and destination account, and review the safe-import preview before confirming.

The importer checks its own duplicate rules and Actual's import preview. A transaction being absent from the visible account does **not** automatically mean Actual will accept it as new.

### What the review statuses mean

| Status | Meaning and next step |
| --- | --- |
| New | No blocking match was found by the checks. Review the amount and account before importing. |
| Definite duplicate | The imported ID matches an existing transaction. Skipped by default. |
| Likely duplicate | Same date, amount, and normalized payee as an existing transaction. Skipped by default. |
| Possible match | Same amount and a similar payee within three days. Review carefully; skipped by default. |
| Previously deleted | Comparing Actual previews indicates a recoverable deleted import. Restore only if you intentionally want it back. |
| Matched by Actual | Actual matched or ignored the row under its own reconciliation rules. Review the displayed evidence and candidates. |
| Skipped by Actual — reason unconfirmed | Actual did not accept the row, but the checks could not establish a safe reason or recovery route. No override is offered for an unexplained skip. |
| Actual check failed — skipped | The preview check failed. Resolve the error before proceeding. |

### Previously deleted transactions

Actual can remember an imported transaction after you delete it. Importing the same statement again may therefore skip that transaction.

The importer compares dry runs with and without deleted-import recovery. When that comparison identifies a recoverable deleted import, an **unchecked, per-row restore choice** is offered. Only selected rows are restored, and each is checked again before writing.

An uncertain skip is not labelled as deleted merely because you previously deleted transactions.

### Separate purchases with the same amount

Actual can reconcile transactions with the same amount within seven days, even when they are separate purchases. The review shows nearby same-amount candidates to help you decide.

**Candidates are possibilities, not proof of the exact transaction Actual matched.**

For eligible rows, you can explicitly choose to import the incoming transaction as a separate purchase. This choice:

- Starts unchecked and requires an additional confirmation.
- Is not offered when the incoming row has an imported ID or a same-day, same-amount candidate.
- Rechecks the candidates and runs another preview before adding the transaction.
- Leaves the earlier transaction unchanged.

Use this only when you have confirmed that the purchases really are separate. It is not a blanket duplicate override.

### Imported IDs

If your bank supplies a stable, unique transaction ID, reference, or FITID, map it to **Imported ID**. This provides stronger duplicate detection across repeated imports than date, amount, and payee alone.

Do not use a value shared by multiple transactions as their imported ID.

## Update an existing installation

**Updating files on GitHub does not update a running container.** Pull and redeploy the container image separately.

Back up your persistent data folder before updating, and keep its volume mapping unchanged.

### Portainer

1. Open the existing stack and check its image tag.
2. Use `latest` for the current build, or `3.3.4` to pin this version.
3. Update/redeploy the stack with the option to pull the image again enabled.
4. Refresh the browser and check the importer version in **Actual setup**.
5. Check API/server compatibility and test the budget connection before importing.

### Docker Compose

From your existing project folder:

```bash
docker compose pull
docker compose up -d
```

Refresh the browser, confirm the importer version, and test the Actual connection.

### Upgrading from 3.2.x

Version 3.3 moved the Actual working cache out of persistent storage. After confirming the upgrade works, you may remove the old `actual-cache` folder from your importer's persistent host-data directory.

Do **not** delete `settings.json` or `profiles/`; they hold your saved configuration.

### Publishing replacement files to GitHub

When applying a complete replacement ZIP, extract it and upload the files into the repository root, not an extra enclosing folder. Include the `.github` directory, `tests`, and helper files such as `import-reconciliation.js`.

The GitHub workflow runs regression tests before publishing the container to GHCR with `latest`, `3.3.4`, and commit-specific tags. Wait for the build to succeed, then pull/redeploy your installation as described above.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| API/server version warning | Compare the versions in Actual setup. Use an importer build whose bundled API matches your server, or update the server to the matching version. Back up before changing versions. |
| “No budget file is open” | Check compatibility first, rediscover/select the budget, and test the connection. Also verify any budget encryption password. |
| Migration error | Stop repeated import attempts. Check API/server compatibility, align the versions, then recreate the importer container to discard its temporary working cache and test again. Do not delete the server budget or persistent importer settings. |
| Server unreachable or authentication failed | Check the URL, password, and network access from the importer container. The browser being able to reach Actual does not prove the container can. |
| Certificate error | Check the trusted certificate mount and the URL hostname against the certificate. Do not disable certificate verification. |
| Payment received imported as a payment | Check the final signed amount in the review. Mixed-sign credit-card statements commonly need **Invert amount**, not **Force negative**. |
| Transaction skipped after deleting it in Actual | Review the deleted-import status and restore choice. Not all skips are caused by deletion. |
| Separate purchase skipped | Review Actual's nearby same-amount candidates. Use the separate-purchase choice only if available and you have confirmed they are distinct transactions. |
| Old importer version after an update | Confirm the image tag, pull the image again, redeploy the container, and refresh the browser. A GitHub file update alone is not enough. |

## Data storage and privacy

Uploaded CSV files are processed in memory. Saved configuration and Actual's temporary working budget have different storage locations:

| Location inside the container | Contents | Lifetime |
| --- | --- | --- |
| `/app/data/profiles/` | Saved CSV profiles | Persistent host volume |
| `/app/data/settings.json` | Connection settings, passwords, selected budget, and account mappings | Persistent host volume |
| `/tmp/actual-budget-csv-importer` | Actual API working copy of the budget; may contain financial data | Temporary container storage |

Saved passwords are not returned to the browser, but they are stored in the settings file. Protect the persistent folder and its backups, and restrict access to the importer.

The temporary budget cache is deleted after `ACTUAL_CACHE_IDLE_MINUTES` of Actual API inactivity (default **20 minutes**, minimum **1 minute**). Actual-related activity resets the timer. Recreating the container also discards this cache.

### Testing and API upgrades

The repository includes mocked-API regression tests for reconciliation, deleted-import recovery, and separate-purchase safeguards. These do not replace testing against your own Actual installation.

The separate-purchase path relies on behavior in the pinned `@actual-app/api` version, including its internal `forceAddTransaction` flag. Re-test that path before changing the API dependency.

## Changelog

Newest releases appear first. The application remains on **3.3.4**; documentation-only edits do not change its version.

### 3.3.4 — Separate-purchase review

- Distinguishes Actual matches from uncertain skips using Actual preview details.
- Shows same-amount candidate transactions within seven days.
- Adds explicit, unchecked separate-purchase choices with additional confirmation and pre-import revalidation.
- Retains deleted-import recovery and duplicate safeguards; API remains 26.9.0.

### 3.3.3 — Deleted-import recovery

- Compares Actual dry runs to identify recoverable previously deleted imports.
- Adds unchecked, per-row restore choices and revalidates selected rows before importing.
- Separates uncertain skips, Actual matches, and check errors from new transactions.
- Adds mocked-API regression tests; API remains pinned to 26.9.0.

### 3.3.2 — Clearer payment and deposit signs

- Shows the exact signed amount sent to Actual beside the converted source amount.
- Warns when a force-sign setting turns a mixed-sign statement into payments only or deposits only.
- Repeats the warning at final confirmation and clarifies when to use **Invert amount**.

### 3.3.1 — Actual version compatibility

- Displays importer, bundled API, and detected Actual Server versions.
- Warns about mismatches and improves migration, budget-open, network, and certificate guidance.
- Pins the Actual API to 26.9.0 and updates Docker publishing version tags.

### 3.3.0 — Temporary budget cache

- Moves Actual's working copy from persistent storage to container temporary storage.
- Adds configurable idle cleanup through `ACTUAL_CACHE_IDLE_MINUTES`, defaulting to 20 minutes.
- Discards the temporary working copy when the container is recreated.

### 3.2.2 — Easier deployment and saved-budget setup

- Adds environment-based Compose paths, `.env.example`, and installation/Portainer guidance.
- Shows the saved budget immediately after reload and refreshes budget discovery when setup opens.
- Keeps the saved budget visible when discovery temporarily fails.
