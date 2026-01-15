const MAX_ACTIVITY = 8;
let clients = [];
let tickets = [];
let activities = [];

async function apiRequest(url, options = {}){
  const opts = { ...options };
  if(opts.body && !opts.headers){
    opts.headers = { 'Content-Type': 'application/json' };
  }else if(opts.body && opts.headers && !opts.headers['Content-Type']){
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, opts);
  if(res.status === 204) return null;
  const data = await res.json().catch(()=> ({}));
  if(!res.ok){
    const err = data?.error || res.statusText || 'Request failed';
    throw new Error(err);
  }
  return data;
}

async function loadData(){
  const data = await apiRequest('/api/seller/data');
  clients = data.clients || [];
  tickets = data.tickets || [];
  activities = data.activities || [];
}

function fmtTime(ts){
  if(window.utils?.formatDateTime) return utils.formatDateTime(ts);
  if(!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

function statusPill(status){
  const label = (status || '').replace('_', ' ');
  return `<span class="status-pill ${status}">${label}</span>`;
}

function renderMetrics(){
  const activeClients = clients.filter(c=> c.status === 'active').length;
  const activeUsers = clients.reduce((sum,c)=> sum + (Number(c.activeUsers) || 0), 0);
  const recentActivity = activities.filter(a=> (Date.now() - a.ts) <= 7 * 86400000).length;
  const openTickets = tickets.filter(t=> t.status !== 'closed').length;

  const metricClients = document.getElementById('metricClients');
  const metricUsers = document.getElementById('metricUsers');
  const metricActivity = document.getElementById('metricActivity');
  const metricTickets = document.getElementById('metricTickets');
  if(metricClients) metricClients.textContent = activeClients;
  if(metricUsers) metricUsers.textContent = activeUsers;
  if(metricActivity) metricActivity.textContent = recentActivity;
  if(metricTickets) metricTickets.textContent = openTickets;

  const activityList = document.getElementById('activityList');
  if(activityList){
    activityList.innerHTML = '';
    if(!activities.length){
      activityList.textContent = 'No recent activity.';
    }else{
      activities.slice(0, MAX_ACTIVITY).forEach(act=>{
        const row = document.createElement('div');
        row.className = 'summary-row';
        row.innerHTML = `<span>${act.message}</span><span>${fmtTime(act.ts)}</span>`;
        activityList.appendChild(row);
      });
    }
  }

  const alertList = document.getElementById('alertList');
  if(alertList){
    alertList.innerHTML = '';
    const alerts = [];
    clients.forEach(c=>{
      if(c.status === 'past_due') alerts.push(`${c.name} is past due`);
      if(c.status === 'trial') alerts.push(`${c.name} trial ending soon`);
    });
    if(!alerts.length){
      alertList.textContent = 'No alerts.';
    }else{
      alerts.slice(0, 6).forEach(msg=>{
        const row = document.createElement('div');
        row.className = 'summary-row';
        row.innerHTML = `<span>${msg}</span><span>Action</span>`;
        alertList.appendChild(row);
      });
    }
  }
}

function renderClientTable(){
  const tbody = document.querySelector('#clientTable tbody');
  if(!tbody) return;
  const filter = (document.getElementById('clientFilter')?.value || '').toLowerCase();
  tbody.innerHTML = '';
  const rows = clients.filter(c=>{
    if(!filter) return true;
    return c.name.toLowerCase().includes(filter) || c.email.toLowerCase().includes(filter) || (c.code || '').toLowerCase().includes(filter);
  });
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="8" style="text-align:center;color:#6b7280;">No clients</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(client=>{
    const tr = document.createElement('tr');
    const seatLimit = client.seatLimit ?? null;
    const userLabel = seatLimit ? `${client.activeUsers} / ${seatLimit}` : `${client.activeUsers}`;
    tr.innerHTML = `
      <td>${client.code || ''}</td>
      <td>${client.name}</td>
      <td>${client.email}</td>
      <td>${client.plan}</td>
      <td>${statusPill(client.status)}</td>
      <td>${userLabel}</td>
      <td>${fmtTime(client.updatedAt)}</td>
      <td>
        <button class="muted" data-action="edit" data-id="${client.id}">Edit</button>
        <button class="muted" data-action="delete" data-id="${client.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderSubscriptionTable(){
  const tbody = document.querySelector('#subscriptionTable tbody');
  if(!tbody) return;
  tbody.innerHTML = '';
  clients.forEach(client=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${client.name}</td>
      <td>${client.plan}</td>
      <td>${statusPill(client.status)}</td>
      <td>
        <select disabled>
          <option>Upgrade (soon)</option>
          <option>Downgrade (soon)</option>
          <option>Cancel (soon)</option>
        </select>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderTicketTable(){
  const tbody = document.querySelector('#ticketTable tbody');
  if(!tbody) return;
  const filter = (document.getElementById('ticketFilter')?.value || '').toLowerCase();
  tbody.innerHTML = '';
  const rows = tickets.filter(t=>{
    const tenantId = t.tenantId || t.clientId;
    const client = clients.find(c=> c.id === tenantId);
    const clientName = client?.name || '';
    return !filter || clientName.toLowerCase().includes(filter) || t.subject.toLowerCase().includes(filter);
  });
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" style="text-align:center;color:#6b7280;">No tickets</td>`;
    tbody.appendChild(tr);
    return;
  }
  rows.forEach(ticket=>{
    const tenantId = ticket.tenantId || ticket.clientId;
    const client = clients.find(c=> c.id === tenantId);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${client?.name || 'Unknown'}</td>
      <td>${ticket.subject}</td>
      <td>${statusPill(ticket.priority)}</td>
      <td>${statusPill(ticket.status)}</td>
      <td>${fmtTime(ticket.updatedAt || ticket.updatedat)}</td>
      <td>
        <button class="muted" data-action="edit-ticket" data-id="${ticket.id}">Edit</button>
        <button class="muted" data-action="close-ticket" data-id="${ticket.id}">Close</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function refreshTicketClientOptions(){
  const select = document.getElementById('ticket-client');
  if(!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Select client...</option>';
  clients.forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.code ? `${c.code} - ${c.name}` : c.name;
    select.appendChild(opt);
  });
  if(current) select.value = current;
}

function resetClientForm(){
  document.getElementById('client-id').value = '';
  const codeInput = document.getElementById('client-code');
  if(codeInput) codeInput.disabled = false;
  const passwordInput = document.getElementById('client-password');
  if(passwordInput) passwordInput.disabled = false;
  document.getElementById('clientForm').reset();
  document.getElementById('clientMsg').textContent = '';
}

function resetTicketForm(){
  document.getElementById('ticket-id').value = '';
  document.getElementById('ticketForm').reset();
  document.getElementById('ticketMsg').textContent = '';
}

function initClientForm(){
  const form = document.getElementById('clientForm');
  const msg = document.getElementById('clientMsg');
  const clearBtn = document.getElementById('clientClearBtn');
  if(!form) return;
  form.addEventListener('submit', async (event)=>{
    event.preventDefault();
    const id = document.getElementById('client-id').value;
    const code = document.getElementById('client-code').value.trim();
    const name = document.getElementById('client-name').value.trim();
    const email = document.getElementById('client-email').value.trim();
    const plan = document.getElementById('client-plan').value;
    const status = document.getElementById('client-status').value;
    const seatsRaw = document.getElementById('client-users').value;
    const activeUsers = seatsRaw === '' ? null : Number(seatsRaw);
    const notes = document.getElementById('client-notes').value.trim();
    const adminPassword = document.getElementById('client-password').value;
    if(!name || !email){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Name and email are required.';
      return;
    }
    if(!id && !code){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Tenant code is required for new clients.';
      return;
    }
    try{
      let savedMessage = '';
      if(id){
        await apiRequest(`/api/seller/clients/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, email, plan, status, activeUsers, notes })
        });
      }else{
        const result = await apiRequest('/api/seller/clients', {
          method: 'POST',
          body: JSON.stringify({ name, email, plan, status, activeUsers, notes, code, adminPassword })
        });
        if(result?.tempPassword){
          savedMessage = `Saved. Temp password: ${result.tempPassword}`;
        }
      }
      msg.style.color = '#15803d';
      if(!savedMessage) savedMessage = 'Saved.';
      resetClientForm();
      msg.textContent = savedMessage;
      await refreshData();
    }catch(e){
      msg.style.color = '#b91c1c';
      msg.textContent = e.message || 'Failed to save client';
    }
  });
  clearBtn?.addEventListener('click', resetClientForm);
}

function initTicketForm(){
  const form = document.getElementById('ticketForm');
  const msg = document.getElementById('ticketMsg');
  const clearBtn = document.getElementById('ticketClearBtn');
  if(!form) return;
  form.addEventListener('submit', async (event)=>{
    event.preventDefault();
    const id = document.getElementById('ticket-id').value;
    const clientId = document.getElementById('ticket-client').value;
    const subject = document.getElementById('ticket-subject').value.trim();
    const priority = document.getElementById('ticket-priority').value;
    const status = document.getElementById('ticket-status').value;
    if(!clientId || !subject){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Client and subject are required.';
      return;
    }
    try{
      if(id){
        await apiRequest(`/api/seller/tickets/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ clientId, subject, priority, status })
        });
      }else{
        await apiRequest('/api/seller/tickets', {
          method: 'POST',
          body: JSON.stringify({ clientId, subject, priority, status })
        });
      }
      msg.style.color = '#15803d';
      msg.textContent = 'Saved.';
      resetTicketForm();
      await refreshData();
    }catch(e){
      msg.style.color = '#b91c1c';
      msg.textContent = e.message || 'Failed to save ticket';
    }
  });
  clearBtn?.addEventListener('click', resetTicketForm);
}

function attachTableHandlers(){
  document.getElementById('clientTable')?.addEventListener('click', (event)=>{
    const btn = event.target.closest('button[data-action]');
    if(!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const client = clients.find(c=> c.id === id);
    if(!client) return;
    if(action === 'edit'){
      document.getElementById('client-id').value = client.id;
      const codeInput = document.getElementById('client-code');
      if(codeInput){
        codeInput.value = client.code || '';
        codeInput.disabled = true;
      }
      document.getElementById('client-name').value = client.name;
      document.getElementById('client-email').value = client.email;
      document.getElementById('client-plan').value = client.plan;
      document.getElementById('client-status').value = client.status;
      document.getElementById('client-users').value = client.seatLimit ?? '';
      document.getElementById('client-notes').value = client.notes || '';
      const passwordInput = document.getElementById('client-password');
      if(passwordInput){
        passwordInput.value = '';
        passwordInput.disabled = true;
      }
      document.getElementById('clientMsg').textContent = 'Editing client.';
      return;
    }
    if(action === 'delete'){
      const label = client.code ? `${client.code} (${client.name})` : client.name;
      if(!confirm(`Delete tenant ${label}? This removes all tenant data.`)) return;
      apiRequest(`/api/seller/clients/${id}`, { method: 'DELETE' })
        .then(refreshData)
        .catch(err=>{
          const msg = document.getElementById('clientMsg');
          if(msg){
            msg.style.color = '#b91c1c';
            msg.textContent = err.message || 'Failed to delete client';
          }
        });
    }
  });

  document.getElementById('ticketTable')?.addEventListener('click', (event)=>{
    const btn = event.target.closest('button[data-action]');
    if(!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const ticket = tickets.find(t=> t.id === id);
    if(!ticket) return;
    const tenantId = ticket.tenantId || ticket.clientId;
    if(action === 'edit-ticket'){
      document.getElementById('ticket-id').value = ticket.id;
      document.getElementById('ticket-client').value = tenantId || '';
      document.getElementById('ticket-subject').value = ticket.subject;
      document.getElementById('ticket-priority').value = ticket.priority;
      document.getElementById('ticket-status').value = ticket.status;
      document.getElementById('ticketMsg').textContent = 'Editing ticket.';
      return;
    }
    if(action === 'close-ticket'){
      apiRequest(`/api/seller/tickets/${ticket.id}/close`, { method: 'POST' })
        .then(refreshData)
        .catch(err=>{
          const msg = document.getElementById('ticketMsg');
          if(msg){
            msg.style.color = '#b91c1c';
            msg.textContent = err.message || 'Failed to close ticket';
          }
        });
    }
  });
}

function renderAll(){
  renderClientTable();
  renderSubscriptionTable();
  renderTicketTable();
  renderMetrics();
}

function setTableMessage(tbody, colspan, message){
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;color:#6b7280;">${message}</td></tr>`;
}

function initDevControls(){
  const devEmail = document.getElementById('devUserEmail');
  if(!devEmail) return;
  const user = window.utils?.getSession?.();
  if(!user) return;
  devEmail.textContent = user.email || 'Unknown';
  const tenant = user.tenantId || user.tenantid || 'default';
  const devTenant = document.getElementById('devTenant');
  if(devTenant) devTenant.textContent = tenant;

  const delUserTenant = document.getElementById('delUserTenant');
  const listUsersTenant = document.getElementById('listUsersTenant');
  if(delUserTenant && tenant) delUserTenant.value = tenant;
  if(listUsersTenant && tenant) listUsersTenant.value = tenant;

  const tokenInput = document.getElementById('devToken');
  const getToken = ()=> (tokenInput?.value || '').trim();

  document.getElementById('devResetBtn')?.addEventListener('click', async ()=>{
    const token = prompt('Enter dev reset token (this will wipe all data).');
    if(!token) return;
    if(!confirm('This will TRUNCATE all data for this environment. Continue?')) return;
    try{
      await apiRequest('/api/dev/reset', {
        method: 'POST',
        headers: {
          'x-dev-reset': token,
          'x-dev-token': getToken()
        }
      });
      alert('Reset complete. You will be logged out.');
      localStorage.removeItem('sessionUser');
      await fetch('/api/auth/logout', { method: 'POST' }).catch(()=>{});
      window.location.href = 'login.html';
    }catch(e){
      alert(e.message || 'Reset failed');
    }
  });

  document.getElementById('deleteUserBtn')?.addEventListener('click', async ()=>{
    const tcode = delUserTenant?.value.trim();
    const email = document.getElementById('delUserEmail')?.value.trim();
    if(!tcode || !email) return alert('Tenant code and email required');
    if(!confirm(`Delete user ${email} in tenant ${tcode}? This cannot be undone.`)) return;
    try{
      await apiRequest('/api/dev/delete-user', {
        method: 'POST',
        headers: { 'x-dev-token': getToken() },
        body: JSON.stringify({ tenantCode: tcode, email })
      });
      alert('User deleted.');
    }catch(e){
      alert(e.message || 'Delete failed');
    }
  });

  document.getElementById('deleteTenantBtn')?.addEventListener('click', async ()=>{
    const tcode = document.getElementById('delTenantCode')?.value.trim();
    if(!tcode) return alert('Tenant code required');
    if(!confirm(`Delete tenant ${tcode} and ALL its data? This cannot be undone.`)) return;
    try{
      await apiRequest('/api/dev/delete-tenant', {
        method: 'POST',
        headers: { 'x-dev-token': getToken() },
        body: JSON.stringify({ tenantCode: tcode })
      });
      alert('Tenant deleted.');
    }catch(e){
      alert(e.message || 'Delete failed');
    }
  });

  const tenantsTableBody = document.querySelector('#tenantsTable tbody');
  document.getElementById('loadTenantsBtn')?.addEventListener('click', async ()=>{
    setTableMessage(tenantsTableBody, 3, 'Loading...');
    try{
      const data = await apiRequest('/api/dev/tenants', {
        headers: { 'x-dev-token': getToken() }
      });
      if(!Array.isArray(data) || !data.length){
        setTableMessage(tenantsTableBody, 3, 'None');
        return;
      }
      tenantsTableBody.innerHTML = '';
      data.forEach(t=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${t.code}</td><td>${t.name}</td><td>${t.id}</td>`;
        tenantsTableBody.appendChild(tr);
      });
    }catch(e){
      setTableMessage(tenantsTableBody, 3, 'Error');
    }
  });

  const usersTableBody = document.querySelector('#usersTable tbody');
  document.getElementById('loadUsersBtn')?.addEventListener('click', async ()=>{
    const tcode = listUsersTenant?.value.trim();
    if(!tcode) return alert('Tenant code required');
    setTableMessage(usersTableBody, 4, 'Loading...');
    try{
      const data = await apiRequest(`/api/dev/users?tenantCode=${encodeURIComponent(tcode)}`, {
        headers: { 'x-dev-token': getToken() }
      });
      if(!Array.isArray(data) || !data.length){
        setTableMessage(usersTableBody, 4, 'None');
        return;
      }
      usersTableBody.innerHTML = '';
      data.forEach(u=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${u.email}</td><td>${u.name || ''}</td><td>${u.role}</td><td>${u.tenantid || u.tenantId || ''}</td>`;
        usersTableBody.appendChild(tr);
      });
    }catch(e){
      setTableMessage(usersTableBody, 4, 'Error');
    }
  });
}

async function refreshData(){
  try{
    await loadData();
    refreshTicketClientOptions();
    renderAll();
  }catch(e){
    const metricClients = document.getElementById('metricClients');
    if(metricClients) metricClients.textContent = '-';
    const msg = document.getElementById('clientMsg');
    if(msg){
      msg.style.color = '#b91c1c';
      msg.textContent = e.message || 'Failed to load seller data';
    }else{
      alert(e.message || 'Failed to load seller data');
    }
  }
}

document.addEventListener('DOMContentLoaded', async ()=>{
  initClientForm();
  initTicketForm();
  attachTableHandlers();
  initDevControls();
  await refreshData();
  document.getElementById('clientFilter')?.addEventListener('input', renderAll);
  document.getElementById('ticketFilter')?.addEventListener('input', renderAll);
});
