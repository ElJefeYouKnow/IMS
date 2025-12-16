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
npm start
# or use the setup script:
.\start.ps1
```

3. **Open in browser**:
- Dashboard: http://localhost:8000/dashboard.html
- Check-In: http://localhost:8000/inventory.html
- Check-Out: http://localhost:8000/inventory-checkout.html
- Inventory List: http://localhost:8000/inventory-list.html
- Reservations: http://localhost:8000/inventory-reserve.html
- Job Report: http://localhost:8000/job-report.html
- Item Master (Admin): http://localhost:8000/item-master.html
- Job Creator: http://localhost:8000/job-creator.html

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
- `GET /api/inventory` - Get all transactions (check-in, check-out, reserve)
- `POST /api/inventory` - Check in (type: 'in')
- `POST /api/inventory-checkout` - Check out (type: 'out')
- `POST /api/inventory-reserve` - Reserve (type: 'reserve')

### Data Storage
- Items stored in: `data/items.json`
- Transactions stored in: `data/inventory.json`
