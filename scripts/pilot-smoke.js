const assert = require('node:assert/strict');

const BASE_URL = String(process.env.IMS_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EMAIL = String(process.env.IMS_EMAIL || 'admin@example.com').trim();
const PASSWORD = String(process.env.IMS_PASSWORD || 'ChangeMe123!').trim();
const TENANT_CODE = String(process.env.IMS_TENANT_CODE || '').trim();

const cookieJar = new Map();

function logStep(message) {
  process.stdout.write(`${message}\n`);
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function storeCookies(headers) {
  for (const rawCookie of getSetCookieValues(headers)) {
    const pair = String(rawCookie || '').split(';')[0];
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (!name) continue;
    cookieJar.set(name, value);
  }
}

function cookieHeader() {
  return Array.from(cookieJar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

async function api(path, { method = 'GET', json, expectedStatus } = {}) {
  const headers = {};
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined
  });
  storeCookies(response.headers);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = text;
    }
  }
  if (expectedStatus !== undefined) {
    assert.equal(
      response.status,
      expectedStatus,
      `${method} ${path} expected ${expectedStatus} but got ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`
    );
  } else {
    assert.ok(
      response.ok,
      `${method} ${path} failed with ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`
    );
  }
  return { response, data };
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sX6N7wAAAAASUVORK5CYII=';

async function run() {
  const supplierName = uniqueId('Pilot Supplier');
  const supplierEmailUpdated = `pilot+${Date.now()}@example.com`;
  const itemCode = uniqueId('PILOT').toUpperCase();
  const jobCode = uniqueId('JOB').toUpperCase();
  const purchaseBatchNoPhoto = uniqueId('field-purchase');
  const purchaseBatchWithPhoto = uniqueId('field-purchase');

  logStep(`Base URL: ${BASE_URL}`);
  logStep('1. Logging in');
  const loginPayload = {
    email: EMAIL,
    password: PASSWORD,
    remember: false
  };
  if (TENANT_CODE) loginPayload.tenantCode = TENANT_CODE;
  const login = await api('/api/auth/login', { method: 'POST', json: loginPayload, expectedStatus: 200 });
  assert.ok(login.data?.email, 'login response did not include user data');

  logStep('2. Checking authenticated session');
  const authMe = await api('/api/auth/me', { expectedStatus: 200 });
  assert.equal(String(authMe.data?.role || '').toLowerCase(), 'admin', 'smoke test requires an admin user');

  logStep('3. Creating supplier');
  const createdSupplier = await api('/api/suppliers', {
    method: 'POST',
    expectedStatus: 201,
    json: {
      name: supplierName,
      contact: 'Pilot Runner',
      email: 'pilot-supplier@example.com',
      phone: '555-0100',
      orderMethod: 'email',
      notes: 'Created by pilot smoke test'
    }
  });
  assert.ok(createdSupplier.data?.id, 'supplier create did not return an id');

  logStep('4. Updating supplier');
  const updatedSupplier = await api(`/api/suppliers/${createdSupplier.data.id}`, {
    method: 'PUT',
    expectedStatus: 200,
    json: {
      ...createdSupplier.data,
      email: supplierEmailUpdated,
      phone: '555-0199',
      orderMethod: 'phone'
    }
  });
  assert.equal(updatedSupplier.data?.email, supplierEmailUpdated, 'supplier update did not persist the new email');
  assert.equal(updatedSupplier.data?.orderMethod, 'phone', 'supplier update did not persist the contact method');

  logStep('5. Creating catalog item');
  const createdItem = await api('/api/items', {
    method: 'POST',
    expectedStatus: 201,
    json: {
      code: itemCode,
      name: 'Pilot Smoke Item',
      category: 'Pilot',
      unitPrice: 12.5,
      supplierId: createdSupplier.data.id,
      supplierSku: 'PILOT-001'
    }
  });
  assert.equal(createdItem.data?.code, itemCode, 'item create did not persist the code');

  logStep('6. Creating project with material need');
  const createdJob = await api('/api/jobs', {
    method: 'POST',
    expectedStatus: 201,
    json: {
      code: jobCode,
      name: 'Pilot Smoke Job',
      status: 'planned',
      location: 'Pilot Yard',
      materials: [
        {
          code: itemCode,
          name: 'Pilot Smoke Item',
          supplierId: createdSupplier.data.id,
          qtyRequired: 5,
          qtyOrdered: 0,
          qtyAllocated: 0,
          qtyReceived: 0,
          notes: 'Procurement smoke coverage',
          sortOrder: 1
        }
      ]
    }
  });
  assert.equal(createdJob.data?.code, jobCode, 'job create did not persist the job code');

  logStep('7. Checking procurement open material needs');
  const openNeeds = await api('/api/jobs/open-material-needs', { expectedStatus: 200 });
  assert.ok(
    Array.isArray(openNeeds.data) && openNeeds.data.some((row) => row?.jobId === jobCode),
    'open material needs did not include the smoke-test job'
  );

  logStep('8. Placing procurement order batch');
  const ordered = await api('/api/inventory-order/bulk', {
    method: 'POST',
    expectedStatus: 201,
    json: {
      orders: [
        {
          code: itemCode,
          name: 'Pilot Smoke Item',
          qty: 2,
          jobId: jobCode,
          notes: 'Pilot smoke procurement order'
        }
      ]
    }
  });
  assert.equal(Array.isArray(ordered.data) ? ordered.data.length : ordered.data?.length || 1, 1, 'bulk order did not return one result');

  logStep('9. Posting field purchase without receipt photo');
  const purchaseNoPhoto = await api('/api/field-purchase', {
    method: 'POST',
    expectedStatus: 201,
    json: {
      batchId: purchaseBatchNoPhoto,
      vendor: 'Pilot No Photo Vendor',
      receipt: 'NO-PHOTO-001',
      lines: [
        {
          code: itemCode,
          name: 'Pilot Smoke Item',
          qty: 1,
          location: 'Field',
          notes: 'Pilot no-photo purchase'
        }
      ]
    }
  });
  assert.equal(purchaseNoPhoto.data?.savedReceiptPhotoCount, 0, 'no-photo purchase unexpectedly reported saved receipt photos');

  logStep('10. Posting field purchase with receipt photo');
  const purchaseWithPhoto = await api('/api/field-purchase', {
    method: 'POST',
    expectedStatus: 201,
    json: {
      batchId: purchaseBatchWithPhoto,
      vendor: 'Pilot Photo Vendor',
      receipt: 'PHOTO-001',
      receiptPhotos: [
        {
          name: 'pilot-receipt.png',
          type: 'image/png',
          sizeBytes: 96,
          width: 1,
          height: 1,
          dataUrl: TINY_PNG_DATA_URL
        }
      ],
      lines: [
        {
          code: itemCode,
          name: 'Pilot Smoke Item',
          qty: 1,
          location: 'Field',
          notes: 'Pilot photo purchase'
        }
      ]
    }
  });
  assert.ok(
    Number(purchaseWithPhoto.data?.savedReceiptPhotoCount || 0) >= 1,
    'photo purchase did not confirm any saved receipt photos'
  );
  assert.ok(
    Array.isArray(purchaseWithPhoto.data?.savedReceiptPhotos) && purchaseWithPhoto.data.savedReceiptPhotos.some((photo) => photo?.url || photo?.dataUrl),
    'photo purchase response did not include direct saved receipt links'
  );

  logStep('11. Loading field purchase batches');
  const fieldPurchases = await api('/api/field-purchases', { expectedStatus: 200 });
  assert.ok(
    Array.isArray(fieldPurchases.data) && fieldPurchases.data.some((row) => {
      const meta = row?.sourceMeta || row?.sourcemeta || {};
      return String(meta.batchId || meta.batchid || '') === purchaseBatchWithPhoto;
    }),
    'field purchase list did not include the saved photo batch'
  );

  logStep('12. Loading inventory');
  const inventory = await api('/api/inventory', { expectedStatus: 200 });
  assert.ok(
    Array.isArray(inventory.data) && inventory.data.some((row) => String(row?.code || '') === itemCode),
    'inventory load did not include the smoke-test item activity'
  );

  logStep('Pilot smoke checks passed.');
}

run().catch((error) => {
  process.stderr.write(`Pilot smoke checks failed: ${error.stack || error.message || error}\n`);
  process.exit(1);
});
