/* OnlyMatch: submit a TRC20 transaction ID to the secured Owner review queue. */
(()=>{
'use strict';
const address='TGfwabyvWcCC9wHJLbqiE7x9P5GDsnD63J';
const contract='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const root=document.getElementById('modal-root');
if(!root)return;
const labels={working:'Рабочий депозит',insurance:'Страховой депозит'};
let purpose='',amount='';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const username=()=>sessionStorage.getItem('ice-pay-trader-username')||'Трейдер';
const statusEl=()=>root.querySelector('#ice-deposit-result');
function close(){root.replaceChildren();document.body.style.overflow='';}
function show(inner){
 root.innerHTML='<div class="ice-deposit-overlay"><section class="ice-deposit-dialog" role="dialog" aria-modal="true" aria-label="Пополнение USDT"><div class="ice-deposit-title"><div><span class="ice-network-chip">USDT · TRC20</span><h2>Пополнение USDT</h2></div><button type="button" class="ice-deposit-close" data-ice-close aria-label="Закрыть">×</button></div>'+inner+'</section></div>';
 document.body.style.overflow='hidden';
}
function selectPurpose(){
 purpose='';amount='';
 show('<p class="ice-deposit-hint">Выберите тип пополнения.</p><div class="ice-deposit-purpose-options">'+
 '<button type="button" class="ice-deposit-purpose" data-ice-purpose="working"><strong>Рабочий депозит</strong><small>Пополнение рабочего баланса USDT</small></button>'+
 '<button type="button" class="ice-deposit-purpose" data-ice-purpose="insurance"><strong>Страховой депозит</strong><small>Страховое обеспечение для допуска к работе</small></button></div>');
}
function amountStep(){
 if(!labels[purpose])return selectPurpose();
 show('<div class="ice-deposit-selected"><small>Тип пополнения</small><strong>'+esc(labels[purpose])+'</strong></div>'+
 '<form id="ice-deposit-form"><label class="ice-deposit-label" for="ice-deposit-amount">Сумма USDT</label><div class="ice-deposit-money">'+
 '<input id="ice-deposit-amount" name="amount" type="number" min="0.01" max="100000" step="0.01" inputmode="decimal" value="'+esc(amount)+'" required placeholder="100.00"><span>USDT</span></div>'+
 '<button class="ice-deposit-primary" type="submit">Продолжить</button><div id="ice-deposit-result" role="alert"></div></form>'+
 '<button class="ice-deposit-back" data-ice-back="purpose" type="button">← Назад</button>');
}
function summaryStep(){
 if(!labels[purpose]||!amount)return amountStep();
 show('<div class="ice-deposit-selected"><small>Тип депозита</small><strong>'+esc(labels[purpose])+'</strong></div>'+
 '<div class="ice-deposit-summary"><div><small>Сумма</small><strong>'+esc(amount)+' USDT</strong></div><div><small>Сеть</small><strong>TRON · TRC20</strong></div></div>'+
 '<label class="ice-deposit-label">Адрес для перевода USDT TRC20</label><div class="ice-deposit-address">'+esc(address)+'</div>'+
 '<button type="button" class="ice-deposit-secondary" data-ice-copy="address">Скопировать адрес</button>'+
 '<div class="ice-deposit-check"><h3>Проверка перевода</h3>'+
 '<p class="ice-deposit-hint">Прикрепите TXID перевода и дождитесь зачисления.</p>'+
 '<label class="ice-deposit-label" for="ice-deposit-txid">TxID перевода</label>'+
 '<input id="ice-deposit-txid" maxlength="64" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="64 символа хэша">'+
 '<button class="ice-deposit-primary" type="button" data-ice-submit-txid>Прикрепить TXID</button>'+

 '<div id="ice-deposit-result" role="status" aria-live="polite"></div></div>'+
 '<details class="ice-deposit-contract"><summary>Контракт USDT TRC20</summary><code>'+esc(contract)+'</code></details>'+
 '<button class="ice-deposit-back" data-ice-back="amount" type="button">← Изменить сумму</button>');
}
async function copyText(value){
 if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return;}
 const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';
 document.body.appendChild(area);area.select();
 const ok=document.execCommand('copy');area.remove();
 if(!ok)throw Error('Копирование недоступно. Выделите текст вручную.');
}
document.addEventListener('click',async e=>{
 if(e.target.closest('[data-action="deposit"]')){e.preventDefault();e.stopPropagation();selectPurpose();return;}
 if(e.target.closest('[data-ice-close]')){close();return;}
 const choice=e.target.closest('[data-ice-purpose]');
 if(choice){purpose=choice.dataset.icePurpose;amount='';amountStep();return;}
 const back=e.target.closest('[data-ice-back]');
 if(back){if(back.dataset.iceBack==='purpose')selectPurpose();else amountStep();return;}
 const copy=e.target.closest('[data-ice-copy="address"]');
 if(copy){
  try{await copyText(address);if(statusEl())statusEl().textContent='Адрес скопирован.';}
  catch(err){if(statusEl())statusEl().textContent=err.message;}
  return;
 }
 const submit=e.target.closest('[data-ice-submit-txid]');
 if(submit){
  const status=statusEl(),txid=root.querySelector('#ice-deposit-txid')?.value.trim()||'';
  if(!/^[0-9a-f]{64}$/i.test(txid)){if(status)status.textContent='Введите корректный TXID из 64 символов.';return;}
  const token=sessionStorage.getItem('ice-pay-trader-token');
  if(!token){if(status)status.textContent='Войдите в аккаунт, чтобы отправить TXID.';return;}
  submit.disabled=true;
  if(status)status.textContent='Отправляем заявку…';
  try{
   const res=await fetch('https://ice-pay-auth.onrender.com/v1/trader/deposit-requests',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    cache:'no-store',body:JSON.stringify({purpose,amount,txid})});
   const data=await res.json().catch(()=>({}));
   if(!res.ok)throw Error(data.error||'Не удалось отправить заявку');
   if(status){status.classList.add('success');status.textContent='TXID прикреплён. Ожидайте зачисления.';}
   root.querySelector('#ice-deposit-txid').readOnly=true;
   window.dispatchEvent(new Event('onlymatch:deposit-submitted'));
  }catch(err){submit.disabled=false;if(status){status.classList.add('error');status.textContent=err.message||'Ошибка отправки';}}
  return;
 }
},true);
document.addEventListener('submit',e=>{
 if(e.target.id!=='ice-deposit-form')return;
 e.preventDefault();e.stopPropagation();
 const v=Number(e.target.elements.amount.value);
 if(!Number.isFinite(v)||v<0.01||v>100000||Math.abs(Math.round(v*100)-v*100)>1e-7){
  const result=e.target.querySelector('#ice-deposit-result');if(result)result.textContent='Укажите сумму от 0,01 до 100 000 USDT с точностью 0,01.';return;
 }
 amount=v.toFixed(2);summaryStep();
},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&root.querySelector('.ice-deposit-overlay'))close()});
})();