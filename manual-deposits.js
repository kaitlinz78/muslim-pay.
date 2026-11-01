'use strict';
// Pending TXID reports never credit funds. Owner approval requires on-chain verification.
const crypto=require('node:crypto');
const {Pool}=require('pg');
const durable=require('./durable-auth');
const {verifyTx}=require('./tron-verify');
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:8000,statement_timeout:18000}):null;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash=/^[0-9a-f]{64}$/i;
const fail=(status,message)=>Object.assign(new Error(message),{status});
let ready=null;
async function ensure(){
 if(!pool||!durable.isReady())throw fail(503,'Приём заявок временно недоступен. Повторите попытку позже.');
 if(!ready)ready=(async()=>{
  await pool.query("CREATE TABLE IF NOT EXISTS onlymatch_manual_deposits (id UUID PRIMARY KEY,account_id UUID NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('working','insurance')),amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN 1 AND 10000000),txid TEXT NOT NULL UNIQUE CHECK(txid ~ '^[0-9a-f]{64}$'),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','credited','rejected')),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),decided_at TIMESTAMPTZ,decided_by UUID)");
  await pool.query('CREATE INDEX IF NOT EXISTS onlymatch_manual_account_idx ON onlymatch_manual_deposits(account_id,created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS onlymatch_manual_status_idx ON onlymatch_manual_deposits(status,created_at DESC)');
 })().catch(e=>{ready=null;throw e});
 await ready;
 return true;
}
function amountCents(value){
 const s=String(value??'').trim();
 if(!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(s))throw fail(400,'Некорректная сумма USDT');
 const [a,b='']=s.split('.');
 const cents=Number(a)*100+Number(b.padEnd(2,'0'));
 if(!Number.isSafeInteger(cents)||cents<1||cents>10000000)throw fail(400,'Сумма от 0,01 до 100 000 USDT');
 return cents;
}
function show(row){
 return {id:row.id,accountId:row.account_id,purpose:row.purpose,
   amountUSDT:(Number(row.amount_cents)/100).toFixed(2),txid:row.txid,
   status:row.status,createdAt:row.created_at,decidedAt:row.decided_at||null};
}
async function legacyUsed(db,txid){
 const table=await db.query("SELECT to_regclass('public.onlymatch_trc20_deposits') AS table_name");
 if(!table.rows[0].table_name)return false;
 const used=await db.query('SELECT 1 FROM onlymatch_trc20_deposits WHERE txid=$1 LIMIT 1',[txid]);
 return used.rowCount>0;
}
async function create(accountId,purpose,amount,txid){
 await ensure();
 if(!uuid.test(accountId)||!['working','insurance'].includes(purpose))throw fail(400,'Неверный тип депозита');
 const normalized=String(txid||'').trim().toLowerCase();
 if(!hash.test(normalized))throw fail(400,'Введите корректный TXID из 64 символов');
 const cents=amountCents(amount);
 if(await legacyUsed(pool,normalized))throw fail(409,'Этот TXID уже зарегистрирован');
 try{
  const {rows}=await pool.query('INSERT INTO onlymatch_manual_deposits(id,account_id,purpose,amount_cents,txid) VALUES($1,$2,$3,$4,$5) RETURNING *',[crypto.randomUUID(),accountId,purpose,cents,normalized]);
  return show(rows[0]);
 }catch(e){if(e.code==='23505')throw fail(409,'Заявка с этим TXID уже существует');throw e}
}
async function balances(accountId){
 await ensure();
 const {rows}=await pool.query("SELECT purpose,COALESCE(SUM(amount_cents),0)::text amount FROM onlymatch_manual_deposits WHERE account_id=$1 AND status='credited' GROUP BY purpose",[accountId]);
 const totals=Object.fromEntries(rows.map(r=>[r.purpose,Number(r.amount)/100]));
 return {mainUSDT:totals.working||0,insuranceUSDT:totals.insurance||0};
}
async function list(accountId){
 await ensure();
 const {rows}=await pool.query('SELECT * FROM onlymatch_manual_deposits WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',[accountId]);
 return rows.map(show);
}
async function ownerList(){
 await ensure();
 const {rows}=await pool.query('SELECT * FROM onlymatch_manual_deposits ORDER BY created_at DESC LIMIT 200');
 return rows.map(show);
}
async function decide(id,ownerId,decision){
 await ensure();
 if(!uuid.test(id)||!uuid.test(ownerId)||!['credited','rejected'].includes(decision))throw fail(400,'Некорректная операция');
 const {rows}=await pool.query('SELECT * FROM onlymatch_manual_deposits WHERE id=$1',[id]);
 if(!rows.length)throw fail(404,'Заявка не найдена');
 if(rows[0].status!=='pending')throw fail(409,'Заявка уже обработана');
 if(decision==='credited'){
  let proof;
  try{proof=await verifyTx(rows[0].txid,(Number(rows[0].amount_cents)/100).toFixed(2))}
  catch(e){throw fail(503,'Проверка сети TRON недоступна: '+e.message)}
  if(proof.status!=='confirmed')throw fail(409,proof.message||'Перевод не подтверждён');
 }
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const locked=await client.query('SELECT * FROM onlymatch_manual_deposits WHERE id=$1 FOR UPDATE',[id]);
  if(!locked.rowCount||locked.rows[0].status!=='pending')throw fail(409,'Заявка уже обработана');
  if(decision==='credited'&&await legacyUsed(client,locked.rows[0].txid))throw fail(409,'Этот перевод уже был учтён ранее');
  const updated=await client.query("UPDATE onlymatch_manual_deposits SET status=$2,decided_at=now(),decided_by=$3 WHERE id=$1 AND status='pending' RETURNING *",[id,decision,ownerId]);
  await client.query('COMMIT');
  return show(updated.rows[0]);
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}
 finally{client.release()}
}
// Owner may credit a trader directly using a real TXID, with the same
// unique-hash protection and network verification as submitted orders.
async function ownerCredit(accountId,purpose,amount,txid,ownerId){
 await ensure();
 if(!uuid.test(accountId)||!uuid.test(ownerId)||!['working','insurance'].includes(purpose))
  throw fail(400,'Некорректные данные зачисления');
 const normalized=String(txid||'').trim().toLowerCase();
 if(!hash.test(normalized))throw fail(400,'Укажите действительный TXID (64 символа)');
 const cents=amountCents(amount);
 const previous=await pool.query('SELECT * FROM onlymatch_manual_deposits WHERE txid=$1',[normalized]);
 if(previous.rowCount){
  const record=previous.rows[0];
  if(record.account_id!==accountId||record.purpose!==purpose||Number(record.amount_cents)!==cents)
   throw fail(409,'TXID уже принадлежит другой заявке. Проверьте тип депозита и сумму.');
  return decide(record.id,ownerId,'credited');
 }
 if(await legacyUsed(pool,normalized))throw fail(409,'Перевод уже был зачислен ранее');
 // Check the network before saving an Owner-created application.
 let proof;
 try{proof=await verifyTx(normalized,(cents/100).toFixed(2))}
 catch(e){throw fail(503,'Проверка TRON временно недоступна: '+e.message)}
 if(proof.status!=='confirmed')throw fail(409,proof.message||'Перевод не подтверждён');
 const order=await create(accountId,purpose,(cents/100).toFixed(2),normalized);
 return decide(order.id,ownerId,'credited');
}
module.exports={create,balances,list,ownerList,decide,ownerCredit,ensure};
