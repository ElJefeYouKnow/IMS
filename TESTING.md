# Manual Test Procedure (10 Steps)

1) Start the server and log in as admin.
- Do: Run `node server.js`, open the app, log in with an admin account.
- Expect: You land on the admin dashboard with no auth errors.

2) Create a new project.
- Do: Go to Project Manager and create a project with a unique code.
- Expect: The project appears in the projects list and the report card view.

3) Edit the project.
- Do: Open the edit modal, change status/dates/notes, and save.
- Expect: Updates persist and show on the project list/report card.

4) Add a procurement order.
- Do: Procurement & Allocation -> add an order line, submit, confirm in the review modal.
- Expect: The order appears in the "Recently Registered Orders" table with open quantity.

5) Check in the order.
- Do: Operations -> check in the order line you just created.
- Expect: Available inventory increases and the order open qty decreases.

6) Reserve stock to the project.
- Do: Allocation -> reserve the item for your project.
- Expect: The reservation appears in the reservation table for that project.

7) Check out items to the project.
- Do: Operations -> check out some quantity for that project.
- Expect: Project Report shows checked out quantity and status updates.

8) Reassign reserved stock.
- Do: Allocation -> reassign reserved stock from your project to another project or General.
- Expect: The original project reserved count goes down; the destination reflects the change.

9) Submit and view support tickets.
- Do: Open Support page and submit a ticket with subject + details.
- Expect: Ticket appears in "My Tickets"; admin/dev sees it in Seller Admin -> Support Tools.

10) Verify Seller Admin tenant management.
- Do: Seller Admin -> create a new tenant, then refresh the client table.
- Expect: New tenant shows with code, status, plan, and user count.
