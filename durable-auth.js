'use strict';
// Persistent source of truth for OnlyMatch account credentials and account IDs.
// Existing Redis accounts are imported once, then restored after Redis restarts.
const {Pool}=require('pg');
const pool=process.env.DATABASE_URL?new Pool({
 connectionString:process.env.DATABASE_URL,max:5,
 connectionTimeoutMillis:8000,statement_timeout:15000
}):null;
const hasDatabase=!!pool;
let ready=false,starting=null;
function fail(code,message){return Object.assign(new Error(message),{status:code})}
function safeId(s){return typeof s==='string'&&/^[0-9a-f-]{36}$/i.test(s)}
function memoKey(a){return String(a.memo||'').toUpperCase()}
async function put(account){
 if(!pool)return;
 if(!ready)throw fail(503,'Постоянное хранилище аккаунтов не готово');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const memo=memoKey(account);
  if(memo){
   const {rows}=await c.query('SELECT account_id FROM onlymatch_reserved_memos WHERE memo=$1 FOR UPDATE',[memo]);
   if(rows.length&&rows[0].account_id!==account.id)throw fail(409,'Memo уже используется');
   await c.query('INSERT INTO onlymatch_reserved_memos(memo,account_id) VALUES($1,$2) ON CONFLICT(memo) DO NOTHING',[memo,account.id]);
  }
  await c.query("INSERT INTO onlymatch_auth_accounts(id,login,payload,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(id) DO UPDATE SET login=EXCLUDED.login,payload=EXCLUDED.payload,updated_at=now()",[
    account.id,String(account.username).toLowerCase(),JSON.stringify(account)
  ]);
  await c.query('COMMIT');
 }catch(e){
  await c.query('ROLLBACK').catch(()=>{});
  if(e.code==='23505')throw fail(409,'Логин или Memo уже заняты');
  throw e;
 }finally{c.release()}
}
async function initialize(redis,prefix){
 if(!hasDatabase)return false;
 if(starting)return starting;
 starting=(async()=>{
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   await c.query("CREATE TABLE IF NOT EXISTS onlymatch_auth_accounts(id UUID PRIMARY KEY,login TEXT UNIQUE NOT NULL,payload JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
   await c.query("CREATE TABLE IF NOT EXISTS onlymatch_reserved_memos(memo TEXT PRIMARY KEY,account_id UUID NOT NULL)");
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
  finally{c.release()}
  const count=await pool.query('SELECT count(*)::int count FROM onlymatch_auth_accounts');
  if(count.rows[0].count===0){
   // Bootstrap from current Redis on the first durable migration.
   const ids=await redis.sMembers(prefix+'trader-ids');
   const ownerKeys=String(process.env.OWNER_INITIAL_USERNAME||'owner').toLowerCase();
   const ownerId=await redis.get(prefix+'username:'+ownerKeys);
   if(ownerId)ids.push(ownerId);
   for(const id of [...new Set(ids)]){
    if(!safeId(id))continue;
    const raw=await redis.get(prefix+'account:'+id);
    if(!raw)continue;
    const a=JSON.parse(raw);
    if(!a.id||!a.username||!a.passwordHash)continue;
    const memo=memoKey(a);
    const c=await pool.connect();
    try{
     await c.query('BEGIN');
     await c.query('INSERT INTO onlymatch_auth_accounts(id,login,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[a.id,a.username.toLowerCase(),JSON.stringify(a)]);
     if(memo)await c.query('INSERT INTO onlymatch_reserved_memos(memo,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[memo,a.id]);
     await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}
    finally{c.release()}
   }
  }
  const {rows}=await pool.query('SELECT payload FROM onlymatch_auth_accounts');
  // Repopulate Redis login indexes; sessions can be recreated by normal login.
  for(const r of rows){
   const a=r.payload;
   await redis.set(prefix+'account:'+a.id,JSON.stringify(a));
   await redis.set(prefix+'username:'+String(a.username).toLowerCase(),a.id);
   if(a.role==='trader')await redis.sAdd(prefix+'trader-ids',a.id);
   if(a.memo)await redis.set(prefix+'memo:'+String(a.memo).toUpperCase(),a.id);
  }
  const reserved=await pool.query('SELECT memo,account_id FROM onlymatch_reserved_memos');
  for(const m of reserved.rows)await redis.set(prefix+'memo:'+m.memo,m.account_id);
  ready=true;
  console.info('[OnlyMatch] persistent accounts ready',rows.length);
  return true;
 })().catch(e=>{ready=false;starting=null;throw e});
 return starting;
}
async function get(id){
 if(!hasDatabase)return null;
 if(!ready)throw fail(503,'Постоянное хранилище недоступно');
 const q=await pool.query('SELECT payload FROM onlymatch_auth_accounts WHERE id=$1',[id]);
 return q.rows[0]?.payload||null;
}
async function byLogin(login){
 if(!hasDatabase)return null;
 if(!ready)throw fail(503,'Постоянное хранилище недоступно');
 const q=await pool.query('SELECT payload FROM onlymatch_auth_accounts WHERE login=$1',[String(login).toLowerCase()]);
 return q.rows[0]?.payload||null;
}
async function traders(){
 if(!hasDatabase)return null;
 if(!ready)throw fail(503,'Постоянное хранилище недоступно');
 const q=await pool.query("SELECT payload FROM onlymatch_auth_accounts WHERE payload->>'role'='trader' ORDER BY (payload->>'createdAt') DESC");
 return q.rows.map(r=>r.payload);
}
async function memoExists(memo){
 if(!hasDatabase)return false;
 if(!ready)throw fail(503,'Постоянное хранилище недоступно');
 const q=await pool.query('SELECT 1 FROM onlymatch_reserved_memos WHERE memo=$1',[memo.toUpperCase()]);
 return !!q.rowCount;
}
module.exports={hasDatabase,isReady:()=>ready,initialize,put,get,byLogin,traders,memoExists};
