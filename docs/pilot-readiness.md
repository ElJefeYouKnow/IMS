# Pilot Readiness Checklist

## Real Device Receipt Capture

Run this on:
- iPhone Safari
- Android Chrome
- Desktop Chrome or Edge

For each device:
1. Open `field-purchase.html`.
2. Log one purchase with `Take Receipt Photo`.
3. Confirm the submit succeeds.
4. Confirm the saved verification panel shows:
   - batch id
   - saved receipt photo count greater than `0`
   - direct receipt link buttons
5. Confirm the new batch appears in the receipt table with a thumbnail.
6. Open the thumbnail and confirm the full receipt image loads.
7. Download the receipt pack and confirm the same receipt image is present.
8. Repeat once using `Add From Gallery`.

Record:
- device
- browser
- whether camera capture worked
- whether gallery upload worked
- whether receipt pack included the image
- any latency or sizing issues

## Live Smoke Test

Run against a live local or staging server:

```powershell
$env:IMS_BASE_URL='http://127.0.0.1:3000'
$env:IMS_EMAIL='admin@example.com'
$env:IMS_PASSWORD='ChangeMe123!'
npm run smoke:pilot
```

Optional:
- set `IMS_TENANT_CODE` if your login requires a business code

The smoke runner covers:
- login
- session check
- supplier create and update
- item create
- project material need creation
- procurement order batch
- field purchase without receipt photo
- field purchase with receipt photo
- field purchase list load
- inventory load

## Admin Export Routine

Before pilot open and after pilot close, use `Settings > Pilot Tools` and download:
- Full Snapshot
- Inventory CSV
- Purchase History CSV
- Suppliers CSV
- Locations CSV

Recommended habit:
1. Export once before the team starts work.
2. Export again after close.
3. Save both export sets in a dated folder, for example `pilot-backups/2026-04-04-open` and `pilot-backups/2026-04-04-close`.

## DB Backup Routine

Use this when you want an actual Postgres backup in addition to the in-app exports.

Default local connection in this repo:

```powershell
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5432/ims'
```

Create a compressed backup:

```powershell
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
pg_dump --format=custom --file "backups\\ims_$stamp.dump" $env:DATABASE_URL
```

Create a plain SQL backup:

```powershell
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
pg_dump --file "backups\\ims_$stamp.sql" $env:DATABASE_URL
```

Restore a custom-format backup:

```powershell
pg_restore --clean --if-exists --dbname $env:DATABASE_URL "backups\\ims_YYYY-MM-DD_HH-mm.dump"
```

Restore a plain SQL backup:

```powershell
psql $env:DATABASE_URL -f "backups\\ims_YYYY-MM-DD_HH-mm.sql"
```

Minimum pilot rule:
- take one DB backup before the first live day
- take one DB backup after any schema or server update
- take one DB backup at the end of each pilot day if transactions matter

## Go / No-Go

Pilot ready means:
- all smoke checks pass
- all three device receipt checks pass
- no field purchase shows a confirmed save with `0` saved photos when a photo was submitted
- server startup completes without schema errors before it begins accepting requests
