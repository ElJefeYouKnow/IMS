(function(global){
  const utils = {
    async fetchJsonSafe(url, options = {}, fallback = null){
      try{
        const res = await fetch(url, options);
        if(!res.ok) throw new Error(res.statusText);
        return await res.json();
      }catch(e){
        return fallback;
      }
    },
    attachItemLookup({ getItems, codeInputId, nameInputId, categoryInputId, priceInputId, suggestionsId }){
      const codeInput = document.getElementById(codeInputId);
      const suggestionsDiv = document.getElementById(suggestionsId);
      if(!codeInput || !suggestionsDiv) return;
      const fillFields = (item)=>{
        if(nameInputId) document.getElementById(nameInputId).value = item.name || '';
        if(categoryInputId) document.getElementById(categoryInputId).value = item.category || '';
        if(priceInputId) document.getElementById(priceInputId).value = item.unitPrice || '';
      };
      codeInput.addEventListener('input', ()=>{
        const val = codeInput.value.trim().toLowerCase();
        suggestionsDiv.innerHTML = '';
        if(!val) return;
        const items = (typeof getItems === 'function' ? getItems() : []) || [];
        const matches = items.filter(i=> i.code.toLowerCase().includes(val)).slice(0,5);
        matches.forEach(item=>{
          const div = document.createElement('div');
          div.textContent = item.code;
          div.style.padding = '8px';
          div.style.cursor = 'pointer';
          div.style.borderBottom = '1px solid #eee';
          div.addEventListener('click', ()=>{
            codeInput.value = item.code;
            fillFields(item);
            suggestionsDiv.innerHTML = '';
          });
          suggestionsDiv.appendChild(div);
        });
      });
    }
  };
  global.utils = utils;
})(window);
