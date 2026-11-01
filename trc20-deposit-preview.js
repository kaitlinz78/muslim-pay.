/* OnlyMatch TRC20 server invoices: exact amount, confirmed hash, automatic status refresh. */
(()=>{
'use strict';
const API='https://ice-pay-auth.onrender.com';
const root=document.getElementById('modal-root');
const title={working:'Рабочий депозит',insurance:'Страховой депозит'};
let purpose='',order=null,refreshTimer=null;
if(!root)return;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=()=>sessionStorage.getItem('ice-pay-trader-token');
function close(){
 if(refreshTimer){clearInterval(refreshTimer);refreshTimer=null}
 order=null;root.replaceChildren();document.body.style.overflow='';
}
function show(html){
 root.innerHTML='<div class="ice-deposit-overlay"><section class="ice-deposit-dialog" role="dialog" aria-modal="true" aria-label="Пополнение USDT"><div class="ice-deposit-title"><div><span class="ice-network-chip">USDT · TRC20</span><h2>Пополнить депозит</h2></div><button class="ice-deposit-close" type="button" data-ice-close aria-label="Закрыть">×</button></div>'+html+'</section></div>';
 document.body.style.overflow='hidden';
}
function warning(message){show('<div class="ice-deposit-warning"><strong>Пополнение недоступно</strong><span>'+esc(message)+'</span></div><button type="button" class="ice-deposit-secondary" data-ice-close>Закрыть</button>')}
async function call(path,method,body){
 const authorization=token();
 if(!authorization)throw Error('Войдите в аккаунт трейдера');
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),17000);
 try{
  const response=await fetch(API+path,{method:method||'GET',cache:'no-store',signal:ctl.signal,
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+authorization},
   body:body?JSON.stringify(body):undefined});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(payload.error||'Не удалось связаться с сервисом');
  return payload;
 }finally{clearTimeout(timer)}
}
async function begin(){
 close();
 show('<p class="ice-deposit-hint">Проверяем возможность пополнения…</p>');
 try{
  const cfg=await call('/v1/trader/trc20/config');
  if(!root.querySelector('.ice-deposit-overlay'))return;
  if(!cfg.enabled||!cfg.autoCreditEnabled||!cfg.address)throw Error('Сервис пополнений пока не готов. Не отправляйте USDT.');
  selectPurpose();
 }catch(e){warning(e.message)}
}
function selectPurpose(){
 purpose='';
 show('<p class="ice-deposit-hint">Выберите тип депозита</p><div class="ice-deposit-purpose-options">'+
  '<button type="button" class="ice-deposit-purpose" data-ice-purpose="working"><strong>Рабочий депозит</strong><small>Пополнение основного баланса USDT</small></button>'+
  '<button type="button" class="ice-deposit-purpose" data-ice-purpose="insurance"><strong>Страховой депозит</strong><small>Установленный Owner минимум: '+esc(Number(window.onlyMatchInsuranceMinimumUSDT??500).toLocaleString('ru-RU',{maximumFractionDigits:2}))+' USDT</small></button>'+
  '</div><button class="ice-deposit-back" data-ice-history type="button">История пополнений</button>');
}
function amountStep(){
 show('<div class="ice-deposit-selected"><small>Тип депозита</small><strong>'+esc(title[purpose])+'</strong></div>'+
  '<form id="ice-deposit-form"><label class="ice-deposit-label" for="ice-deposit-amount">Сумма в USDT</label>'+
  '<div class="ice-deposit-money"><input id="ice-deposit-amount" name="amount" type="number" min="0.01" max="100000" step="0.01" required placeholder="100.00"><span>USDT</span></div>'+
  '<p class="ice-deposit-hint">После создания заявки будет сформирована уникальная точная сумма перевода. Переводите её без округления, только USDT TRC20.</p>'+
  '<button class="ice-deposit-primary" type="submit">Создать заявку</button><div id="ice-deposit-result" role="alert"></div></form>'+
  '<button class="ice-deposit-back" data-ice-back="purpose" type="button">← Назад</button>');
}
function showOrder(item,message){
 order=item;
 const state=item.status==='credited'?'Оплачено':item.status==='expired'?'Время заявки истекло':'Ожидается перевод';
 const note=item.status==='credited'?'Перевод подтверждён, средства зачислены в баланс.':item.status==='expired'?'Если перевод выполнен, обратитесь в поддержку с хэшем транзакции.':'Отправьте ровно указанную сумму до окончания срока заявки.';
 show('<div class="ice-deposit-selected"><small>'+esc(title[item.purpose])+' · '+esc(state)+'</small><strong>'+esc(item.amountUSDT)+' USDT</strong></div>'+
  '<div class="ice-deposit-summary"><div><small>Сеть</small><strong>TRON · TRC20</strong></div><div><small>Срок заявки</small><strong>'+esc(new Date(item.expiresAt).toLocaleString('ru-RU'))+'</strong></div></div>'+
  '<label class="ice-deposit-label">Адрес USDT TRC20</label><div class="ice-deposit-address">'+esc(item.address)+'</div>'+
  '<button type="button" class="ice-deposit-secondary" data-ice-copy="'+esc(item.address)+'">Скопировать адрес</button>'+
  '<button type="button" class="ice-deposit-secondary" data-ice-copy="'+esc(item.amountUSDT)+'">Скопировать сумму</button>'+
  '<p class="ice-deposit-hint">'+esc(note)+'</p>'+
  (item.status!=='credited'?'<div class="ice-deposit-check"><h3>Проверка перевода</h3><label class="ice-deposit-label" for="ice-deposit-txid">TxID (необязательно)</label>'+
   '<input id="ice-deposit-txid" maxlength="64" placeholder="Хэш транзакции"><button class="ice-deposit-primary" data-ice-verify type="button">Проверить перевод</button></div>':'')+
  '<div id="ice-deposit-result" role="status" aria-live="polite">'+esc(message||'')+'</div>'+
  '<button class="ice-deposit-back" data-ice-history type="button">Все заявки</button>');
 if(item.status==='credited'){
  window.dispatchEvent(new Event('onlymatch:trader-authenticated'));
 }
}
async function refresh(){
 if(!order||!root.querySelector('.ice-deposit-overlay'))return;
 try{
  const result=await call('/v1/trader/trc20/orders');
  const fresh=(result.orders||[]).find(i=>i.id===order.id);
  if(fresh&&fresh.status!==order.status)showOrder(fresh);
 }catch(e){console.warn('TRC20 refresh:',e.message)}
}
function startRefresh(){
 if(refreshTimer)clearInterval(refreshTimer);
 refreshTimer=setInterval(()=>{if(!document.hidden)refresh()},12000);
}
async function history(){
 try{
  const data=await call('/v1/trader/trc20/orders');
  show('<h3>Заявки TRC20</h3>'+
   ((data.orders||[]).map(i=>'<button class="ice-deposit-purpose" type="button" data-ice-order="'+esc(i.id)+'"><strong>'+esc(i.amountUSDT)+' USDT · '+esc(i.purpose==='insurance'?'Страховой':'Рабочий')+'</strong><small>'+esc(i.status==='credited'?'Оплачено':i.status==='expired'?'Истекло':'Ожидает оплаты')+'</small></button>').join('')||'<p class="ice-deposit-hint">Заявок пока нет</p>')+
   '<button class="ice-deposit-back" data-ice-back="purpose" type="button">← Назад</button>');
  window.__omTrc20Orders=(data.orders||[]);
 }catch(e){warning(e.message)}
}
document.addEventListener('click',async e=>{
 if(e.target.closest('[data-action=deposit]')){e.preventDefault();e.stopPropagation();begin();return}
 if(e.target.closest('[data-ice-close]')){close();return}
 const choice=e.target.closest('[data-ice-purpose]');
 if(choice){purpose=choice.dataset.icePurpose;amountStep();return}
 if(e.target.closest('[data-ice-back]')){selectPurpose();return}
 if(e.target.closest('[data-ice-history]')){history();return}
 const selected=e.target.closest('[data-ice-order]');
 if(selected){const old=(window.__omTrc20Orders||[]).find(o=>o.id===selected.dataset.iceOrder);if(old){showOrder(old);startRefresh()}return}
 const copy=e.target.closest('[data-ice-copy]');
 if(copy){
  try{await navigator.clipboard.writeText(copy.dataset.iceCopy);const x=root.querySelector('#ice-deposit-result');if(x)x.textContent='Скопировано'}catch{alert('Не удалось скопировать')}
  return;
 }
 const confirm=e.target.closest('[data-ice-verify]');
 if(!confirm||!order)return;
 const txid=root.querySelector('#ice-deposit-txid')?.value.trim()||'';
 const result=root.querySelector('#ice-deposit-result');
 if(!/^[a-f0-9]{64}$/i.test(txid)){if(result)result.textContent='Введите корректный TxID';return}
 confirm.disabled=true;
 try{
  const data=await call('/v1/trader/trc20/orders/'+encodeURIComponent(order.id)+'/verify','POST',{txid});
  showOrder(data.order,'Перевод успешно подтверждён');
 }catch(err){if(result)result.textContent=err.message}
 finally{confirm.disabled=false}
},true);
document.addEventListener('submit',async e=>{
 if(e.target.id!=='ice-deposit-form')return;
 e.preventDefault();e.stopPropagation();
 const form=e.target,amount=form.elements.amount.value;
 const button=form.querySelector('button[type=submit]'),result=form.querySelector('#ice-deposit-result');
 button.disabled=true;
 try{
  const data=await call('/v1/trader/trc20/orders','POST',{purpose,amount});
  showOrder(data.order);startRefresh();
 }catch(err){if(result)result.textContent=err.message;button.disabled=false}
},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&root.querySelector('.ice-deposit-overlay'))close()});
})();