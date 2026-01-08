function escapeHtml(value){
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts){
  if(window.utils && utils.formatDateTime) return utils.formatDateTime(ts);
  return ts ? new Date(ts).toLocaleString() : '';
}

function setTableMessage(tbody, message){
  if(!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;">${message}</td></tr>`;
}

async function loadTickets(){
  const tbody = document.querySelector('#supportTable tbody');
  if(!tbody) return;
  setTableMessage(tbody, 'Loading...');
  try{
    const res = await fetch('/api/support/tickets', { credentials: 'include' });
    if(!res.ok){
      const data = await res.json().catch(()=>({}));
      throw new Error(data.error || 'Failed to load tickets');
    }
    const rows = await res.json();
    tbody.innerHTML = '';
    if(!rows.length){
      setTableMessage(tbody, 'No tickets yet.');
      return;
    }
    rows.forEach(ticket=>{
      const tr = document.createElement('tr');
      const subject = escapeHtml(ticket.subject || '');
      const body = escapeHtml(ticket.body || '');
      const summary = body ? `<div class="ticket-body">${body}</div>` : '';
      const priority = (ticket.priority || 'medium').toLowerCase();
      const status = (ticket.status || 'open').toLowerCase();
      tr.innerHTML = `
        <td>
          <div class="ticket-subject">${subject}</div>
          ${summary}
        </td>
        <td><span class="status-pill ${priority}">${priority}</span></td>
        <td><span class="status-pill ${status}">${status.replace('_',' ')}</span></td>
        <td>${formatTime(ticket.updatedAt || ticket.updatedat || ticket.createdAt || ticket.createdat)}</td>
      `;
      tbody.appendChild(tr);
    });
  }catch(e){
    setTableMessage(tbody, e.message || 'Failed to load tickets');
  }
}

function initForm(){
  const form = document.getElementById('supportForm');
  const msg = document.getElementById('supportMsg');
  const clearBtn = document.getElementById('ticketClear');
  if(!form) return;
  const resetForm = ()=>{
    form.reset();
    if(msg) msg.textContent = '';
  };
  clearBtn?.addEventListener('click', resetForm);
  form.addEventListener('submit', async (event)=>{
    event.preventDefault();
    const subject = document.getElementById('ticketSubject').value.trim();
    const priority = document.getElementById('ticketPriority').value;
    const body = document.getElementById('ticketBody').value.trim();
    if(!subject){
      msg.style.color = '#b91c1c';
      msg.textContent = 'Subject is required.';
      return;
    }
    try{
      const res = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ subject, priority, body })
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){
        msg.style.color = '#b91c1c';
        msg.textContent = data.error || 'Failed to submit ticket';
        return;
      }
      msg.style.color = '#15803d';
      msg.textContent = 'Ticket submitted.';
      resetForm();
      await loadTickets();
    }catch(e){
      msg.style.color = '#b91c1c';
      msg.textContent = e.message || 'Failed to submit ticket';
    }
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  const session = window.utils?.getSession?.();
  if(session){
    const title = document.getElementById('ticketListTitle');
    if(title) title.textContent = session.role === 'admin' || session.role === 'dev' ? 'Tenant Tickets' : 'My Tickets';
  }
  initForm();
  loadTickets();
});
