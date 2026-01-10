(function(){
  function setMode(mode){
    document.querySelectorAll('.mode-btn').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.querySelectorAll('.mode-content').forEach(panel=>{
      panel.classList.toggle('active', panel.id === `${mode}-mode`);
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const hash = (window.location.hash || '').replace('#','').toLowerCase();
    const initial = hash === 'audit' ? 'audit' : 'overview';
    setMode(initial);

    document.querySelectorAll('.mode-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const mode = btn.dataset.mode;
        setMode(mode);
        if(mode === 'audit'){
          window.location.hash = 'audit';
        }else{
          history.replaceState(null, '', window.location.pathname);
        }
      });
    });
  });
})();
