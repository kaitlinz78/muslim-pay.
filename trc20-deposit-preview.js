/* OnlyMatch: deposit-purpose selection and read-only TRC20 transaction preview */
(()=>{
'use strict';
// Deposit purpose and amount are preview-only: no server ledger allocation or crediting.
const address='TGfwabyvWcCC9wHJLbqiE7x9P5GDsnD63J';
const token='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const api='https://ice-pay-rates.onrender.com/trc20/verify';
const root=document.getElementById('modal-root');
if(!root)return;
const purposes={working:'Рабочий депозит',insurance:'Страховой депозит'};
let purpose='',amount='';
function close(){root.replaceChildren();document.body.style.overflow='';}
function render(inner){
 root.innerHTML='<div class="ice-deposit-overlay"><section class="ice-deposit-dialog" role="dialog" aria-modal="true" aria-label="Пополнение USDT"><div class="ice-deposit-title"><div><span class="ice-network-chip">USDT · TRC20</span><h2>Пополнить депозит</h2></div><button class="ice-deposit-close" data-ice-close type="button" aria-label="Закрыть">×</button></div>'+inner+'</section></div>';
 document.body.style.overflow='hidden';
}
const notice='<div class="ice-deposit-warning" role="alert"><strong>Автозачисление пока не подключено</strong><span>Выбор типа, ввод суммы и проверка TxID не создают депозит и не зачисляют USDT. До подключения серверного учёта не переводите средства через эту форму.</span></div>';
function selectPurpose(){
 purpose='';amount='';
 render(notice+'<p class="ice-deposit-hint">Сначала выберите, какой депозит хотите пополнить:</p><div class="ice-deposit-purpose-options"><button type="button" class="ice-deposit-purpose" data-ice-purpose="working"><strong>Рабочий депозит</strong><small>Средства для рабочего баланса трейдера</small></button><button type="button" class="ice-deposit-purpose" data-ice-purpose="insurance"><strong>Страховой депозит</strong><small>Для доступа к работе требуется 500 USDT подтверждённого страхового депозита</small></button></div>');
}
function amountStep(){
 if(!purposes[purpose])return selectPurpose();
 render(notice+'<div class="ice-deposit-selected"><small>Выбранный тип</small><strong>'+purposes[purpose]+'</strong></div><form id="ice-deposit-form"><label class="ice-deposit-label" for="ice-deposit-amount">Сумма в USDT</label><div class="ice-deposit-money"><input id="ice-deposit-amount" name="amount" type="number" min="0.01" max="100000" step="0.01" inputmode="decimal" required value="'+amount+'"><span>USDT</span></div><p class="ice-deposit-hint">Точность до 0,01 USDT. Уникальные депозитные заявки пока не создаются.</p><button class="ice-deposit-primary" type="submit">Продолжить</button></form><button class="ice-deposit-back" data-ice-back="purpose" type="button">← Изменить тип депозита</button>');
}
function summaryStep(){
 if(!purposes[purpose]||!amount)return amountStep();
 render(notice+'<div class="ice-deposit-selected"><small>Тип депозита</small><strong>'+purposes[purpose]+'</strong></div><div class="ice-deposit-summary"><div><small>Сумма</small><strong>'+amount+' USDT</strong></div><div><small>Сеть</small><strong>TRC20</strong></div></div><label class="ice-deposit-label">Адрес для предварительной проверки</label><div class="ice-deposit-address">'+address+'</div><details class="ice-deposit-contract"><summary>Контракт токена USDT</summary><code>'+token+'</code></details><div class="ice-deposit-check"><h3>Проверить транзакцию</h3><p>Введите TxID уже существующего перевода. Проверка сети не подтверждает зачисление в выбранный депозит OnlyMatch.</p><label class="ice-deposit-label" for="ice-deposit-txid">TxID</label><input id="ice-deposit-txid" maxlength="64" placeholder="64 символа хэша" autocomplete="off"><button class="ice-deposit-primary" data-ice-verify type="button">Проверить перевод</button><div id="ice-deposit-result" role="status" aria-live="polite"></div></div><button class="ice-deposit-back" data-ice-back="amount" type="button">← Изменить сумму</button>');
}
document.addEventListener('click',async e=>{
 if(e.target.closest('[data-action=deposit]')){e.preventDefault();e.stopPropagation();selectPurpose();return;}
 if(e.target.closest('[data-ice-close]')){close();return;}
 const choose=e.target.closest('[data-ice-purpose]');
 if(choose){const value=choose.dataset.icePurpose;if(!purposes[value])return;purpose=value;amount='';amountStep();return;}
 const back=e.target.closest('[data-ice-back]');
 if(back){if(back.dataset.iceBack==='purpose')selectPurpose();else amountStep();return;}
 const button=e.target.closest('[data-ice-verify]');
 if(!button)return;
 const txid=root.querySelector('#ice-deposit-txid')?.value.trim()||'';
 const result=root.querySelector('#ice-deposit-result');
 if(!result)return;
 if(!/^[a-f0-9]{64}$/i.test(txid)){result.textContent='Укажите корректный TxID из 64 символов.';result.className='ice-deposit-result error';return;}
 result.className='ice-deposit-result';result.textContent='Проверяем сеть TRON…';button.disabled=true;
 try{
  const response=await fetch(api+'?txid='+encodeURIComponent(txid)+'&amount='+encodeURIComponent(amount),{cache:'no-store'});
  const data=await response.json();
  if(!root.contains(result))return;
  result.textContent=(data.message||'Нет данных о транзакции')+' Проверка не зачисляет депозит.';
  result.className='ice-deposit-result '+(data.status==='confirmed'?'success':'error');
 }catch{
  if(root.contains(result)){result.textContent='Сеть проверки сейчас недоступна. Повторите позже.';result.className='ice-deposit-result error';}
 }finally{button.disabled=false;}
},true);
document.addEventListener('submit',e=>{
 if(e.target.id!=='ice-deposit-form')return;
 e.preventDefault();e.stopPropagation();
 const n=Number(e.target.elements.amount.value);
 if(!purposes[purpose]||!Number.isFinite(n)||n<0.01||n>100000||Math.abs(Math.round(n*100)-n*100)>0.000001)return;
 amount=n.toFixed(2);summaryStep();
},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&root.querySelector('.ice-deposit-overlay'))close()});
})();
