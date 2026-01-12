# Inventory Management System

Full-stack inventory management with dashboard, check-in/check-out, reservations, job tracking, and item master catalog.

## Prerequisites

- **Node.js 14+** (download from https://nodejs.org/)
- Windows PowerShell or Command Prompt

## Quick Start

1. **Install dependencies** (first time only):
```powershell
cd D:\IMS
npm install
```

2. **Start the server**:
```powershell
# set your DB connection
set DATABASE_URL=postgres://user:pass@host:5432/ims
set DATABASE_SSL=true   # use false only for local non-TLS
npm start
# or use the setup script:
.\start.ps1
```

3. **Open in browser**:
- Admin Dashboard: http://localhost:8000/dashboard.html
- Employee Dashboard: http://localhost:8000/employee-dashboard.html
- Operations (all modes: check-in/out/reserve/return): http://localhost:8000/inventory-operations.html
- Inventory List: http://localhost:8000/inventory-list.html
- Project Report: http://localhost:8000/job-creator.html#report
- Item Master (Admin): http://localhost:8000/item-master.html
- Job Creator (Admin): http://localhost:8000/job-creator.html
- Register Order (Admin): http://localhost:8000/order-register.html
- Settings: http://localhost:8000/settings.html (admin) or http://localhost:8000/settings-employee.html
- Auth: http://localhost:8000/login.html and http://localhost:8000/register.html

> The first registered user becomes an admin by default.

## Production (Modulr.pro)

Set these environment variables for the single-domain deployment:

```powershell
set NODE_ENV=production
set BASE_DOMAIN=modulr.pro
set PUBLIC_BASE_URL=https://modulr.pro
set COOKIE_SECURE=true
set SESSION_STORE=db
set SESSION_SECRET=<strong-random-secret>
```

## Features

### Item Master (Admin)
- Add, edit, delete items in catalog
- Define SKU, name, category, unit price
- Employees use SKU to quickly access item info

### Check-In
- Receive inventory with optional job assignment
- Auto-lookup item details by SKU
- Track location and notes

### Check-Out
- Remove inventory for jobs
- Specify reason (sale, damage, return, etc.)
- Track which job used what inventory

### Reservations
- Reserve items for specific jobs with expected return dates

### Inventory List
- View all items with current stock levels
- Columns: In, Out, Reserved, Available
- Search by code or name

### Job Report
- See inventory usage by job
- Track what was checked in/out/reserved per job
- Export to CSV

## API Endpoints

### Items (Master Catalog)
- `GET /api/items` - List all items
- `POST /api/items` - Add/update item
- `DELETE /api/items/:code` - Delete item by code

### Inventory Transactions
- `GET /api/inventory` - Get all transactions
- `POST /api/inventory` - Check in (type: 'in')
- `POST /api/inventory-checkout` - Check out (type: 'out')
- `POST /api/inventory-reserve` - Reserve (type: 'reserve')
- `POST /api/inventory-return` - Return checked-out items

### Data Storage
- PostgreSQL (configured via `DATABASE_URL`); tables auto-create on startup
