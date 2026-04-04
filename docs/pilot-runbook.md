# Pilot Runbook

## Purpose

Use this during pilot week to:
- start the app cleanly
- confirm the database is connected
- verify page access by role
- take backups before and after live use
- recover quickly from stale browsers or receipt-photo issues

## Start The App

1. Open PowerShell in `d:\IMS`.
2. Confirm environment values if you use overrides:

```powershell
$env:PORT
$env:DATABASE_URL
$env:IMS_TENANT_CODE
```

3. Start the server:

```powershell
npm start
```

4. Wait for startup to complete. Do not open the app until the server finishes schema/bootstrap work.

## Confirm DB Connection

Use one or more of these checks:

1. Watch server startup. It should complete without schema or database errors.
2. Open the admin dashboard and confirm metrics load.
3. Open `Settings > Pilot Tools` and click `Refresh`.
4. Run the smoke test against the running server:

```powershell
$env:IMS_BASE_URL='http://127.0.0.1:3000'
$env:IMS_EMAIL='admin@example.com'
$env:IMS_PASSWORD='ChangeMe123!'
npm run smoke:pilot
```

If startup fails or pilot tools do not load, stop and resolve the database issue before users transact.

## Page Access Matrix

Expected access before pilot:

- `dashboard.html`: admin only
- `analytics.html`: admin only
- `job-creator.html`: admin only
- `item-master.html`: admin only
- `order-register.html`: admin only
- `settings.html`: admin only
- `ops-dashboard.html`: manager only
- `employee-dashboard.html`: employee only
- `inventory-list.html`: any signed-in user can view; only admin can save cycle counts or make historical adjustments
- `inventory-operations.html`: signed-in operational users
- `field-purchase.html`: signed-in operational users
- `settings-employee.html`: signed-in non-admin user settings
- `support.html`: signed-in users

Permission focus areas:

- suppliers: admin only
- procurement and allocation: admin only
- catalog edits: admin only
- historical inventory edits, count saves, manual adjustments, and transfers: admin only

## Backup Routine

Before open:
1. `Settings > Pilot Tools`
2. Download:
   - Full Snapshot
   - Inventory CSV
   - Purchase History CSV
   - Suppliers CSV
   - Locations CSV

After close:
1. Repeat the same export set.
2. Save both sets in dated folders.

For Postgres backups, use the DB backup routine in [pilot-readiness.md](/d:/IMS/docs/pilot-readiness.md#L71).

## Hard Refresh Clients

Use this when a browser still shows stale code or stale cached data.

Desktop Chrome or Edge:
1. Open the page.
2. Press `Ctrl+Shift+R`.
3. If that fails, open DevTools and long-press refresh, then choose empty cache and hard reload.

iPhone Safari:
1. Close the tab.
2. Reopen the page.
3. If still stale, clear website data for the site and sign in again.

Android Chrome:
1. Tap the browser menu.
2. Refresh once.
3. If still stale, clear site storage for the app origin and sign in again.

After a hard refresh, confirm the page shows current sync status and the latest data.

## If Receipt Photos Fail

When a user says a receipt photo did not save:

1. Do not assume the image exists just because upload was attempted.
2. Check the save verification panel on `field-purchase.html`.
3. Confirm:
   - batch id exists
   - saved receipt photo count is greater than `0`
   - receipt link opens
4. Refresh the Field Purchases log.
5. Confirm the new batch shows a thumbnail.
6. Download the receipt pack and verify the image is present.

If the save verification panel shows `0` photos:
- retry with a smaller image
- retry with `Take Receipt Photo` and then `Add From Gallery`
- hard refresh the page and test again
- if it still fails, stop pilot receipt capture on that device and log the device/browser combination

## Real Pilot Rehearsal

This must be done on live devices before pilot signoff.

Use:
- Browser A on desktop
- Browser B on a second desktop or an incognito window
- One phone

Run 10 to 15 transactions:

1. Login on all three clients.
2. Create one procurement batch.
3. Reserve stock for one project.
4. Receive one open order.
5. Perform one checkout from operations.
6. Perform one return.
7. Log at least three field purchases.
8. Include at least two field purchases with receipt photos from the phone.
9. Open the same inventory item on two clients and confirm quantities match after refresh.
10. Confirm the receipt table, modal, and receipt pack all show the same photos.
11. Export pilot CSVs from settings.
12. Confirm no duplicate rows were created after retries or double-clicks.

Record:
- exact date and time
- users and roles used
- devices and browsers used
- any mismatch between clients
- any receipt photo failures
- any duplicate transactions

## Stop Conditions

Do not proceed with pilot if any of these happen:
- admin pages open for non-admin users
- procurement or supplier edits succeed for the wrong role
- cycle counts or historical adjustments succeed for the wrong role
- smoke test fails
- receipt photo save verification returns `0` for a newly submitted photo
- two clients disagree after refresh on a just-completed transaction
