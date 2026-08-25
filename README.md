# Actual CSV Converter 2.1

A self-hosted, profile-driven CSV converter for Actual Budget.

## Profile-first design

Version 2.1 intentionally ships with **no built-in CSV profiles**.

On a fresh installation:

1. Upload a CSV statement.
2. The app reports that the format is unknown.
3. Click **Configure profile**.
4. Map the source fields.
5. Test the mapping.
6. Save the profile.
7. Download the Actual-compatible CSV.

That saved profile is then reused automatically for future files with the same identifying headers.

This means every bank or card format is configured through the same user-facing workflow. There are no institution-specific mappings baked into the application.

## Persistent profile storage

Profiles are stored as JSON files in:

    /app/data/profiles

With the included TrueNAS/Portainer compose file, that maps to:

    /mnt/array/appsdata/actual_csv_converter/data/profiles

They survive Docker image updates and container recreation.

A typical installation may eventually look like:

    /mnt/array/appsdata/actual_csv_converter/data/
      profiles/
        my-bank.json
        my-mastercard.json
        another-card.json

## Current mapping features

- Date column
- Description column
- Common source date formats
- Single amount column
- Separate debit and credit columns
- Preserve/invert/force amount signs
- Mapping test before saving
- Profile export to JSON
- Profile import from JSON
- Automatic recognition of previously configured formats
- Separate converted CSV output for each uploaded source file

## Sharing

The application can be shared without any bank-specific configuration.

Individual users create their own profiles. If they want to share a profile for a particular institution, they can export its JSON file separately.

Profiles contain mapping rules, not transaction history.

## Privacy

Uploaded CSV files are processed in memory by the self-hosted application and are not written to persistent storage.

Only profile configuration JSON is persisted.

## TrueNAS / Portainer

The compose file uses:

    ghcr.io/covenn604/actual-csv-converter:latest

Port mapping:

    8080:3000

Persistent data:

    /mnt/array/appsdata/actual_csv_converter/data:/app/data

After pushing this version to GitHub, allow GitHub Actions to build the new image and then pull/redeploy the stack in Portainer.

## Future Actual Budget integration

The intended next stage uses Actual Budget's official Node API.

The target workflow is:

    CSV
      ↓
    detect/create profile
      ↓
    normalize
      ↓
    preview
      ↓
    choose Actual account
      ↓
    dry run / duplicate check
      ↓
    confirm
      ↓
    import

Shareable CSV profiles should remain separate from private local Actual server credentials and account associations.
