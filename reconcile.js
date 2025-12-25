// Simple per-tenant reconciliation script.
// Usage: node reconcile.js
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ims';
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function reconcileTenant(tenantId) {
  const events = await pool.query('SELECT code,type,qty FROM inventory WHERE tenantId=$1', [tenantId]);
  const totals = {};
  events.rows.forEach(r=>{
    const code = r.code;
    const qty = Number(r.qty)||0;
    const t = r.type;
    if(!totals[code]) totals[code] = 0;
    if(t === 'in' || t === 'return') totals[code] += qty;
    if(t === 'reserve' || t === 'out' || t === 'consume') totals[code] -= qty;
  });
  return totals;
}

(async ()=>{
  const tenants = await pool.query('SELECT id, code FROM tenants');
  for(const t of tenants.rows){
    const totals = await reconcileTenant(t.id);
    console.log(`Tenant ${t.code}:`, totals);
  }
  await pool.end();
})().catch(e=>{ console.error(e); process.exit(1); });
