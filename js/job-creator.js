async function loadJobs(){
  try{
    const r = await fetch('/api/jobs');
    if(r.ok) return await r.json();
  }catch(e){}
  return [];
}

async function saveJob(job){
  try{
    const r = await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(job)});
    return r.ok;
  }catch(e){return false;}
}

async function deleteJobApi(code){
  try{
    const r = await fetch(`/api/jobs/${code}`,{method:'DELETE'});
    return r.ok;
  }catch(e){return false;}
}

async function renderJobs(){
  const tbody=document.querySelector('#jobTable tbody');tbody.innerHTML='';
  const jobs = await loadJobs();
  if(!jobs.length){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="4" style="text-align:center;color:#6b7280;">No jobs created</td>`;
    tbody.appendChild(tr);
    return;
  }
  jobs.sort((a,b)=> a.code.localeCompare(b.code));
  jobs.forEach(job=>{
    const tr=document.createElement('tr');
    const date = job.scheduleDate ? new Date(job.scheduleDate).toLocaleDateString() : '—';
    tr.innerHTML=`<td>${job.code}</td><td>${job.name||''}</td><td>${date}</td><td><button class="delete-btn" data-code="${job.code}">Delete</button></td>`;
    tbody.appendChild(tr);
  });
  document.querySelectorAll('.delete-btn').forEach(btn=>{
    btn.addEventListener('click', async ev=>{
      const code = ev.target.dataset.code;
      if(!confirm(`Delete job "${code}"?`)) return;
      const ok = await deleteJobApi(code);
      if(!ok) alert('Failed to delete job');
      else await renderJobs();
    });
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  renderJobs();
  const form=document.getElementById('jobForm');
  form.addEventListener('submit', async ev=>{
    ev.preventDefault();
    const code=document.getElementById('jobCode').value.trim();
    const name=document.getElementById('jobName').value.trim();
    const scheduleDate=document.getElementById('jobDate').value;
    if(!code){alert('Job code required');return}
    const ok = await saveJob({code,name,scheduleDate});
    if(!ok) alert('Failed to save job');
    else{
      form.reset();
      await renderJobs();
    }
  });
  document.getElementById('jobClearBtn').addEventListener('click', ()=>form.reset());
});
