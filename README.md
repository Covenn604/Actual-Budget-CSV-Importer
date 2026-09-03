# Actual Budget CSV Importer

A self-hosted, profile-driven CSV converter and importer for [Actual Budget](https://actualbudget.org/).

The application is designed for banks and credit-card providers that export CSV files in different formats. Each user can create reusable mapping profiles in the browser, preview normalized transactions, download an Actual-compatible CSV, or optionally import directly into a self-hosted Actual Budget server.

## Features

- Drag-and-drop one or more CSV statements
- One output/import per source account — files are never merged together
- Create reusable CSV profiles from unknown formats
- Automatic recognition of previously configured profiles
- Date, description, amount, debit, and credit field mapping
- Separate downloadable-CSV and direct-Actual amount-sign rules
- Optional stable imported-ID mapping
- Persistent JSON profile storage
- Import/export profile JSON for sharing
- Direct connection to self-hosted Actual Budget
- Actual compatibility display for importer, bundled API, and detected server versions
- Automatic Actual budget discovery
- Persistent selected-budget and profile-to-account mappings
- Duplicate-safety preflight before direct imports
- Actual `importTransactions` dry-run before confirmation
- Explicit confirmation before a real import

## How it works

```text
CSV statement
      |
      v
Detect saved profile
      |
      +-- unknown --> Configure profile --> Save JSON profile
      |
      v
Normalize transactions
      |
      v
Preview
   /     \
  v       v
Download  Duplicate safety analysis
CSV             |
                v
          Actual dry run
                |
                v
          Confirm safe import
```

## Requirements

For CSV conversion only:

- Docker / Docker Compose, Portainer, or another container manager
- A modern web browser

For direct Actual imports:

- A self-hosted Actual Budget server reachable from the importer container
- Actual server password
- An Actual budget selected through the application's **Actual setup** screen
- If Actual uses a self-signed/private certificate, the importer must trust that certificate

---

# Installation

## Option 1 — Docker Compose

Create a directory for the application:

```bash
mkdir actual-budget-csv-importer
cd actual-budget-csv-importer
```

Copy these files from the repository into it:

```text
docker-compose.yml
.env.example
```

Create your environment file:

```bash
cp .env.example .env
```

Edit `.env` for your system.

A simple Linux example:

```env
IMPORTER_PORT=8080
IMPORTER_DATA_PATH=/opt/actual-budget-csv-importer/data
```

A TrueNAS example might be:

```env
IMPORTER_PORT=8080
IMPORTER_DATA_PATH=/mnt/tank/apps/actual-budget-csv-importer
```

Then deploy:

```bash
docker compose up -d
```

Open:

```text
http://YOUR-SERVER-IP:8080
```

## Option 2 — Portainer Stack

In Portainer:

1. Open **Stacks**.
2. Select **Add stack**.
3. Choose **Web editor** or **Git repository**.
4. Use the repository's `docker-compose.yml`.
5. Add stack environment variables matching the values described below.
6. Deploy the stack.

Recommended Portainer environment variables:

```text
IMPORTER_PORT=8080
IMPORTER_DATA_PATH=/path/on/your/docker/host/actual-budget-csv-importer
```

If Actual uses a private/self-signed HTTPS certificate:

```text
ACTUAL_CA_CERT_PATH=/path/on/your/docker/host/server.crt
NODE_EXTRA_CA_CERTS=/certs/actual-server.crt
```

The importer stores persistent application data under `/app/data` inside the container.

---

# Docker Compose configuration

The supplied compose file is intentionally host-agnostic:

```yaml
services:
  actual-budget-csv-importer:
    image: ${IMPORTER_IMAGE:-ghcr.io/covenn604/actual-budget-csv-importer:latest}
    container_name: ${IMPORTER_CONTAINER_NAME:-actual-budget-csv-importer}

    ports:
      - "${IMPORTER_PORT:-8080}:3000"

    volumes:
      - ${IMPORTER_DATA_PATH:-./data}:/app/data
      - ${ACTUAL_CA_CERT_PATH:-./certs/actual-server.crt}:/certs/actual-server.crt:ro

    environment:
      NODE_EXTRA_CA_CERTS: ${NODE_EXTRA_CA_CERTS:-/certs/actual-server.crt}

    restart: unless-stopped
```

Nothing in the compose file is tied to a particular TrueNAS pool or host path.

## Persistent data

The host path configured by `IMPORTER_DATA_PATH` contains:

```text
profiles/
  my-bank.json
  my-credit-card.json

settings.json
```

`profiles/*.json` contains portable CSV mapping rules.

`settings.json` contains private local configuration such as:

- Actual server URL
- Actual server password
- selected budget
- profile-to-Actual-account mappings

Do not commit the persistent data directory to Git.

---

# HTTPS and self-signed certificates

If your Actual server uses a certificate signed by a public CA, no special trust configuration may be necessary.

If Actual uses a self-signed/private certificate, set:

```env
ACTUAL_CA_CERT_PATH=/host/path/to/server.crt
NODE_EXTRA_CA_CERTS=/certs/actual-server.crt
```

The certificate should be valid for the hostname or IP address used in the Actual server URL.

For example, if the importer connects to:

```text
https://192.168.1.10:5006
```

the certificate should include:

```text
subjectAltName = IP:192.168.1.10
```

Do not solve certificate problems by globally disabling TLS verification.

---

# First-run CSV profile setup

A fresh installation intentionally contains no institution-specific profiles.

Upload a CSV.

If the format is unknown, click **Configure profile**.

Configure:

- Profile name
- Date format
- Date column
- Description/payee column
- Amount layout
  - single amount column, or
  - separate debit/credit columns
- CSV conversion sign
- Direct Actual import sign
- Optional imported-ID column

Test the mapping and save it.

The profile is written to:

```text
/app/data/profiles/<profile-name>.json
```

Future CSVs containing the profile's required headers are recognized automatically.

## Amount signs

The application intentionally separates two concepts.

### CSV conversion sign

Controls the amount written to the downloadable CSV.

### Direct Actual import sign

Controls the amount sent through the Actual API and used for duplicate analysis.

This is useful for credit cards where a source CSV may contain:

```text
60.00
```

but Actual internally stores the purchase as:

```text
-60.00
```

Choose **Invert amount** for the direct Actual import rule in that case.

---

# Connecting to Actual Budget

Open **Actual setup**.

At the top of the page, **Actual compatibility** shows:

- importer version
- bundled `@actual-app/api` version
- Actual Server version detected with `getServerVersion()`

The bundled API and server should use the same version. A red warning appears when they differ because version mismatches can cause database migration errors or an unexpected `No budget file is open` error. If the server version cannot be detected, save the connection details, verify that the importer container can reach the server, and click **Check versions**.

## 1. Connect to Actual Server

Enter:

- Actual server URL
- server password
- encryption password only if the budget uses Actual E2E encryption

Click **Save connection**.

The password is saved only in the server-side persistent settings file and is never returned to the browser.

## 2. Select a budget

Click **Discover budgets** on first setup.

The importer calls Actual's `getBudgets()` and displays budgets by name. Duplicate local/remote entries are deduplicated by Sync ID.

Select a budget and click **Use selected budget**.

The selected budget is persisted. On future page loads, the saved budget appears immediately in the dropdown; the application also refreshes budget discovery automatically when the Actual setup page is opened.

You do not need to manually enter a Sync ID.

## 3. Map profiles to Actual accounts

Once a budget has been selected, the importer loads its accounts.

Example:

```text
Bank CSV profile        -> Chequing
Mastercard CSV profile  -> Credit Card
```

These mappings remain local and are not included in exported profile JSON.

---

# Troubleshooting Actual setup

## API and server versions differ

Update the older component so **Bundled Actual API** and **Detected Actual Server** show the same version. This release intentionally pins the importer to `@actual-app/api` `26.9.0`, so it is intended to connect to Actual Server `26.9.0`. After updating, restart/redeploy the importer and click **Check versions**.

## `No budget file is open`

Confirm that the intended budget is selected, then check the compatibility display before testing the budget again. This message can appear when a version mismatch prevents Actual's local working copy from opening or finishing its migrations. If the versions already match, use **Discover budgets** to refresh the list and select the budget again.

## Migration error

Do not repeatedly retry imports. First make the API and server versions match, redeploy the importer to clear its temporary working copy, and test the selected budget again. Your source CSVs, profiles, and persistent settings are not stored in that temporary copy.

## Server version cannot be detected

- Verify the URL and password, then click **Save connection**.
- Confirm that the Actual Server is reachable from inside the importer container.
- For a private/self-signed certificate, configure `ACTUAL_CA_CERT_PATH` and `NODE_EXTRA_CA_CERTS` as described above.
- Click **Check versions** again after correcting the connection.

---

# Duplicate safety

Direct imports do not rely only on Actual's reconciliation result.

Before importing, the application fetches existing transactions from the mapped account and classifies incoming rows.

## Definite duplicate

Same `imported_id` already exists.

## Likely duplicate

Same:

- date
- amount
- normalized payee

## Possible match

Same amount and a similar payee within three days.

## New

No matching existing transaction was found.

Safe mode sends only transactions classified as **New** to Actual.

Definite, likely, and possible duplicates are skipped.

The duplicate analysis is run again on the server immediately before the confirmed import so the browser cannot submit a stale safety result.

Actual's own `importTransactions` reconciliation then runs on the safe subset.

This approach is intentionally conservative. It is preferable to skip a questionable transaction for manual review than silently create a duplicate financial transaction.

---

# Imported IDs

If your bank provides a stable transaction identifier such as:

- transaction ID
- reference number
- FITID
- unique ID

map it to **Imported ID**.

Actual provides its strongest duplicate protection when the same `imported_id` is supplied on subsequent imports.

---

# Updating

If using the `latest` image:

```bash
docker compose pull
docker compose up -d
```

In Portainer, use **Pull latest image and redeploy**.

Persistent profiles/settings survive container replacement because `/app/data` is mounted from the host.

For more controlled deployments, use a versioned image tag instead of `latest`, for example:

```text
ghcr.io/covenn604/actual-budget-csv-importer:3.3.2
```

## Updating the repository with the replacement ZIP

The release ZIP contains complete replacement files, not a command-line patch:

1. Extract the ZIP on your computer.
2. Open the repository on GitHub and choose **Add file → Upload files**.
3. Drag the extracted files and folders into the upload area. Include the `.github` folder so the Docker workflow receives the new version tag.
4. Commit the upload to `main`.
5. Wait for **Build and Publish Docker Image** to finish, then pull/redeploy `latest` or set `IMPORTER_IMAGE` to the `3.3.2` tag.

The upload replaces application files but does not touch the persistent `/app/data` volume, so saved settings and profiles remain intact.

---

# GitHub / GHCR

The included GitHub Actions workflow builds the Docker image when changes are pushed to `main`.

Images are published to:

```text
ghcr.io/covenn604/actual-budget-csv-importer:latest
ghcr.io/covenn604/actual-budget-csv-importer:3.3.2
```

---

# Privacy

Uploaded bank/credit-card CSV files are processed in memory and are not intentionally persisted by the application.

Persistent storage contains configuration, mappings, and the Actual API local cache.

For security:

- keep the application LAN-only unless you add authentication/reverse-proxy protection
- use HTTPS when exposing it beyond a trusted network
- do not publish your persistent data directory
- do not put bank statements into the Git repository

---

# Current version

**3.3.2**

## 3.3.2

- Changed duplicate/safe-import review to show the exact signed amount sent to Actual
- Added the converted source amount beside the final Actual amount for comparison
- Added a prominent warning when Force negative/positive collapses a mixed-sign statement into one direction
- Repeats the amount-direction warning in the final confirmation and labels the action **Import anyway**
- Clarified that Force negative creates payments only and Force positive creates deposits only
- Documented that mixed-sign credit-card statements commonly require **Invert amount**

## 3.3.1

- Added an Actual setup compatibility display for importer, bundled API, and detected server versions
- Detects the server version through Actual's `getServerVersion()` API
- Clearly warns when the bundled Actual API and server versions differ
- Improved migration, `No budget file is open`, network, and certificate error guidance
- Pinned `@actual-app/api` to `26.9.0`
- Updated Docker image workflow tagging to `3.3.1`

## 3.2.2

- generalized Docker Compose paths using environment variables
- added `.env.example`
- comprehensive installation/Portainer documentation
- persisted budget now appears immediately after page reload
- Actual setup automatically refreshes discovered budgets when opened
- saved budget remains visible if discovery temporarily fails


# Temporary Actual API cache

Actual's API uses a local working copy of the selected budget. Because that working copy can contain financial data, version 3.3 no longer stores it in the persistent `/app/data` volume.

The working copy now lives at:

```text
/tmp/actual-budget-csv-importer
```

Only configuration remains persistent:

```text
/app/data/profiles/
/app/data/settings.json
```

## Configurable idle cleanup

Set the cache inactivity timeout with:

```env
ACTUAL_CACHE_IDLE_MINUTES=20
```

The default is 20 minutes and the minimum is 1 minute. For a short personal import workflow, for example:

```env
ACTUAL_CACHE_IDLE_MINUTES=5
```

Actual-related activity resets the inactivity timer. After the configured idle period, the temporary Actual working directory is deleted. Because it is also outside the persistent Docker volume, recreating the container discards it as well.

## Upgrading from 3.2.x

Previous versions used `/app/data/actual-cache`. Version 3.3 no longer uses that directory. After upgrading and confirming the new version works, you may remove the old `actual-cache` directory from the importer's persistent host-data directory.

## 3.3.0

- Moved Actual's working copy from persistent storage to container `/tmp`
- Added `ACTUAL_CACHE_IDLE_MINUTES`
- Automatic cleanup after Actual API inactivity
- Default timeout: 20 minutes
- Container recreation also discards the working copy
