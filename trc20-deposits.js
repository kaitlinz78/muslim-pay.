'use strict';
// OnlyMatch persistent TRC20 accounting. Disabled until both durable auth and PostgreSQL are configured.
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {verifyTx,TREASURY,USDT_CONTRACT}=require('./tron-verify');
const durable=require('./durable-auth');
const LIVE=process.env.ONLYMATCH_TRC20_LIVE==='true' &&
 Boolean(process.env.DATABASE_URL && process.env.TRONGRID_API_KEY);
const pool=LIVE?new Pool({connectionString:process.env.DATABASE_URL,
 max:4,connectionTimeoutMillis:8000,statement_timeout:18000}):null;
const validId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let schema=null,working=false;
const issue=(status,message)=>Object.assign(new Error(message),{status});
function toMicro(amount,scale=2){
 const text=String(amount??'');
 const re=scale===2?/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/:/^\d{1,9}\.\d{6}$/;
 if(!re.test(text))throw issue(400,'Сумма должна иметь верный формат');
 const [a,b='']=text.split('.');
 const value=BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));
 if(scale===2&&(value<10000n||value>100000000000n))throw issue(400,'Сумма от 0,01 до 100 000 USDT');
 return value;
}
function fmt(value){
 const n=BigInt(value);
 return (n/1000000n).toString()+'.'+(n%1000000n).toString().padStart(6,'0');
}
function expose(row){
 return {id:row.id,purpose:row.purpose,status:row.status,
  amountUSDT:fmt(row.due_micro),requestedUSDT:fmt(row.requested_micro),
  network:'TRON',asset:'USDT',address:TREASURY,contract:USDT_CONTRACT,
  createdAt:row.created_at,expiresAt:row.expires_at,
  creditedAt:row.credited_at||null,txid:row.txid||null};
}
async function ensure(){
 if(!LIVE||!durable.isReady())return false;
 if(!schema)schema=(async()=>{
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   await c.query("CREATE TABLE IF NOT EXISTS onlymatch_trc20_deposits (id UUID PRIMARY KEY,account_id UUID NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('working','insurance')),requested_micro BIGINT NOT NULL CHECK(requested_micro>0),due_micro BIGINT NOT NULL UNIQUE CHECK(due_micro>0),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','credited','expired')),txid CHAR(64) UNIQUE,event_index INTEGER,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL,credited_at TIMESTAMPTZ)");
   await c.query('CREATE INDEX IF NOT EXISTS onlymatch_trc20_account_idx ON onlymatch_trc20_deposits(account_id,created_at DESC)');
   await c.query('CREATE INDEX IF NOT EXISTS onlymatch_trc20_pending_idx ON onlymatch_trc20_deposits(status,created_at)');
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
  finally{c.release()}
 })().catch(e=>{schema=null;throw e});
 await schema;
 return true;
}
async function enabled(){return await ensure()}
async function config(){
 let available=false;
 try{available=await ensure()}catch(e){console.error('[OnlyMatch TRC20] DB:',e.message)}
 return {enabled:available,autoCreditEnabled:available,
  network:'TRON',asset:'USDT',contract:USDT_CONTRACT,
  address:available?TREASURY:null,exactAmountRequired:true};
}
async function requireLive(){
 if(!await ensure())throw issue(503,'Пополнение временно недоступно. Не отправляйте USDT.');
}
async function balances(accountId){
 if(!await ensure())return {enabled:false,mainUSDT:0,insuranceUSDT:0};
 const {rows}=await pool.query("SELECT purpose,COALESCE(SUM(due_micro),0)::text AS total FROM onlymatch_trc20_deposits WHERE account_id=$1 AND status='credited' GROUP BY purpose",[accountId]);
 const totals=Object.fromEntries(rows.map(r=>[r.purpose,Number(r.total)/1000000]));
 return {enabled:true,mainUSDT:totals.working||0,insuranceUSDT:totals.insurance||0};
}
async function list(accountId){
 await requireLive();
 const {rows}=await pool.query('SELECT * FROM onlymatch_trc20_deposits WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50',[accountId]);
 return rows.map(expose);
}
async function create(accountId,purpose,amount){
 await requireLive();
 if(!validId.test(accountId)||!['working','insurance'].includes(purpose))throw issue(400,'Недопустимая заявка');
 const requested=toMicro(amount);
 for(let i=0;i<25;i++){
  const due=requested+BigInt(crypto.randomInt(1,10000));
  try{
   const {rows}=await pool.query("INSERT INTO onlymatch_trc20_deposits(id,account_id,purpose,requested_micro,due_micro,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes') RETURNING *",[
    crypto.randomUUID(),accountId,purpose,requested.toString(),due.toString()]);
   return expose(rows[0]);
  }catch(e){if(e.code!=='23505')throw e}
 }
 throw issue(503,'Не удалось выделить уникальную сумму, повторите попытку');
}
async function apply(txid,blockTime,eventIndex,amountMicro){
 const timestamp=Number(blockTime);
 if(!Number.isFinite(timestamp)||timestamp<1000000000000)throw issue(409,'Неизвестно время блока');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const {rows}=await c.query("SELECT * FROM onlymatch_trc20_deposits WHERE due_micro=$1 AND status IN ('pending','expired') FOR UPDATE",[amountMicro.toString()]);
  const matched=rows.filter(r=>timestamp>=Date.parse(r.created_at)-30000&&timestamp<=Date.parse(r.expires_at)+30000);
  if(matched.length!==1){await c.query('ROLLBACK');return null}
  const invoice=matched[0];
  const updated=await c.query("UPDATE onlymatch_trc20_deposits SET status='credited',txid=$2,event_index=$3,credited_at=now() WHERE id=$1 AND status IN ('pending','expired') RETURNING *",[invoice.id,txid.toLowerCase(),eventIndex]);
  await c.query('COMMIT');
  return updated.rowCount?expose(updated.rows[0]):null;
 }catch(e){
  await c.query('ROLLBACK').catch(()=>{});
  if(e.code==='23505')return null;
  throw e;
 }finally{c.release()}
}
async function confirm(accountId,id,txid){
 await requireLive();
 if(!validId.test(id)||!/^[a-f0-9]{64}$/i.test(String(txid)))throw issue(400,'Неверный ID заявки или хэш');
 const {rows}=await pool.query('SELECT * FROM onlymatch_trc20_deposits WHERE id=$1 AND account_id=$2',[id,accountId]);
 if(!rows.length)throw issue(404,'Заявка не найдена');
 if(rows[0].status==='credited')return expose(rows[0]);
 const result=await verifyTx(txid,fmt(rows[0].due_micro));
 if(result.status!=='confirmed')throw issue(409,result.message||'Транзакция не подтверждена');
 for(const event of result.transfers){
  const credited=await apply(txid,result.blockTimeStamp,event.eventIndex,toMicro(event.amount,6));
  if(credited?.id===id)return credited;
 }
 throw issue(409,'Сумма или время перевода не соответствуют заявке');
}
async function scan(){
 if(!LIVE||working)return;
 working=true;
 try{
  await ensure();
  const {rows}=await pool.query("SELECT MIN(created_at) AS earliest FROM onlymatch_trc20_deposits WHERE status IN ('pending','expired') AND created_at>now()-interval '7 days'");
  if(!rows[0]?.earliest)return;
  let cursor='',page=0;
  do{
   const url=new URL('https://api.trongrid.io/v1/accounts/'+TREASURY+'/transactions/trc20');
   url.searchParams.set('only_confirmed','true');
   url.searchParams.set('only_to','true');
   url.searchParams.set('contract_address',USDT_CONTRACT);
   url.searchParams.set('min_timestamp',String(Date.parse(rows[0].earliest)-60000));
   url.searchParams.set('limit','200');
   if(cursor)url.searchParams.set('fingerprint',cursor);
   const response=await fetch(url,{headers:{'TRON-PRO-API-KEY':process.env.TRONGRID_API_KEY},signal:AbortSignal.timeout(16000)});
   if(!response.ok)throw Error('TronGrid HTTP '+response.status);
   const payload=await response.json();
   if(payload.success!==true||!Array.isArray(payload.data))throw Error('Incorrect TronGrid response');
   for(const tx of payload.data){
    if(tx.token_info?.address!==USDT_CONTRACT||tx.to!==TREASURY||!/^[a-f0-9]{64}$/i.test(String(tx.transaction_id||'')))continue;
    let amount;try{amount=BigInt(String(tx.value))}catch{continue}
    const known=await pool.query("SELECT 1 FROM onlymatch_trc20_deposits WHERE due_micro=$1 AND status IN ('pending','expired') LIMIT 1",[amount.toString()]);
    if(!known.rowCount)continue;
    const receipt=await verifyTx(tx.transaction_id,fmt(amount));
    if(receipt.status!=='confirmed')continue;
    for(const event of receipt.transfers){
     if(toMicro(event.amount,6)===amount)await apply(tx.transaction_id,receipt.blockTimeStamp,event.eventIndex,amount);
    }
   }
   cursor=String(payload.meta?.fingerprint||'');
   page++;
  }while(cursor&&page<10);
  if(cursor)console.warn('[OnlyMatch TRC20] More receipts than scan limit: manual reconciliation required');
 }catch(e){console.warn('[OnlyMatch TRC20] scan:',e.message)}
 finally{working=false}
}
function start(){
 if(!LIVE)return;
 setInterval(()=>scan().catch(e=>console.warn(e.message)),20000).unref?.();
 setTimeout(()=>scan().catch(e=>console.warn(e.message)),4000).unref?.();
}
async function ownerList(){
 await requireLive();
 const {rows}=await pool.query('SELECT * FROM onlymatch_trc20_deposits ORDER BY created_at DESC LIMIT 100');
 return rows.map(row=>({...expose(row),accountId:row.account_id}));
}
module.exports={config,enabled,balances,list,create,confirm,ownerList,start};
