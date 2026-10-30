'use strict';
/* Ice Pay accounts: authenticated owner/trader access only.
 * No real-money ledger or payment crediting exists in this service.
 * Never use browser-local balances as payable funds.
 */
const http=require('node:http');
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const {Pool}=require('pg');
const scrypt=promisify(crypto.scrypt);
const PORT=Number(process.env.PORT||10000);
const ALLOWED=new Set(['https://muslim-pay.onrender.com','https://ice-pay-owner.onrender.com']);
const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const hasDatabase=Boolean(process.env.DATABASE_URL);
const pool=hasDatabase?new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:7000,statement_timeout:10000}):null;
const attempts=new Map();
let ready=false;
function send(res,status,data,origin){
 res.statusCode=status;
 if(origin&&ALLOWED.has(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.end(JSON.stringify(data));
}
async function body(req){
 const chunks=[];let len=0;
 for await(const c of req){len+=c.length;if(len>16384)throw Object.assign(new Error('Слишком большой запрос'),{status:413});chunks.push(c)}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(new Error('Неверный формат запроса'),{status:400})}
}
function validatePassword(p){return typeof p==='string'&&Buffer.byteLength(p,'utf8')>=12&&Buffer.byteLength(p,'utf8')<=128}
function validateLogin(s){return typeof s==='string'&&/^[a-z][a-z0-9_.-]{3,31}$/.test(s)}
async function makeHash(password){
 const salt=crypto.randomBytes(16).toString('hex');
 return salt+':'+(await scrypt(password,salt,64)).toString('hex');
}
async function verifyPassword(password,stored){
 if(!stored||typeof password!=='string'||password.length>128)return false;
 const [salt,hex]=stored.split(':');
 if(!/^[a-f0-9]{32}$/.test(salt||'')||!/^[a-f0-9]{128}$/.test(hex||''))return false;
 const actual=await scrypt(password,salt,64);
 return crypto.timingSafeEqual(actual,Buffer.from(hex,'hex'));
}
function sessionKey(token){return crypto.createHash('sha256').update(token).digest('hex')}
function memoCandidate(){
 return 'ICE-'+Array.from(crypto.randomBytes(14),x=>alphabet[x%alphabet.length]).join('');
}
async function uniqueMemo(client){
 for(let i=0;i<20;i++){
  const memo=memoCandidate();
  const used=await client.query('SELECT 1 FROM reserved_memos WHERE memo=$1',[memo]);
  if(!used.rowCount)return memo;
 }
 throw new Error('Cannot allocate memo');
}
function summary(a){
 return {id:a.id,username:a.username,role:a.role,note:a.note||'',memo:a.memo||null,active:a.active,createdAt:a.created_at,updatedAt:a.updated_at};
}
async function init(){
 if(!pool){console.warn('DATABASE_URL missing; account API disabled');return}
 await pool.query('SELECT 1');
 await pool.query("CREATE TABLE IF NOT EXISTS accounts (id UUID PRIMARY KEY, username VARCHAR(32) UNIQUE NOT NULL, role VARCHAR(10) NOT NULL CHECK(role IN ('owner','trader')), password_hash TEXT NOT NULL, note VARCHAR(500) DEFAULT '', memo VARCHAR(40) UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
 await pool.query('CREATE TABLE IF NOT EXISTS reserved_memos (memo VARCHAR(40) PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id), reserved_at TIMESTAMPTZ NOT NULL DEFAULT now())');
 await pool.query('CREATE TABLE IF NOT EXISTS sessions (token_hash CHAR(64) PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
 await pool.query('CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at)');
 await pool.query('CREATE TABLE IF NOT EXISTS memo_history (id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id), old_memo VARCHAR(40) NOT NULL, new_memo VARCHAR(40) NOT NULL, reason VARCHAR(120) DEFAULT \'\', changed_at TIMESTAMPTZ NOT NULL DEFAULT now())');
 const count=await pool.query("SELECT COUNT(*)::int AS count FROM accounts WHERE role='owner'");
 if(count.rows[0].count===0 && process.env.OWNER_INITIAL_PASSWORD){
   if(!validatePassword(process.env.OWNER_INITIAL_PASSWORD))throw new Error('OWNER_INITIAL_PASSWORD must have at least 12 characters');
   const user=(process.env.OWNER_INITIAL_USERNAME||'owner').toLowerCase().trim();
   if(!validateLogin(user))throw new Error('OWNER_INITIAL_USERNAME invalid');
   await pool.query("INSERT INTO accounts (id,username,role,password_hash) VALUES($1,$2,'owner',$3) ON CONFLICT(username) DO NOTHING",[crypto.randomUUID(),user,await makeHash(process.env.OWNER_INITIAL_PASSWORD)]);
   console.log('Initial Owner account created');
 }
 ready=true;console.log('Ice Pay authenticated accounts ready');
}
async function authentication(req){
 const auth=String(req.headers.authorization||'');
 if(!auth.startsWith('Bearer '))return null;
 const token=auth.slice(7);
 if(!/^[a-f0-9]{64}$/.test(token))return null;
 const record=await pool.query("SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active=true LIMIT 1",[sessionKey(token)]);
 return record.rows[0]||null;
}
function throttle(req){
 const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
 const now=Date.now();
 if(attempts.size>5000)attempts.clear();
 const v=attempts.get(ip)||{count:0,until:now+900000};
 if(now>v.until){v.count=0;v.until=now+900000;}
 v.count++;attempts.set(ip,v);
 return v.count<=14;
}
async function issueToken(accountId,role){
 const token=crypto.randomBytes(32).toString('hex');
 const hours=role==='owner'?8:24;
 await pool.query("INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+($3::text||' hours')::interval)",[sessionKey(token),accountId,String(hours)]);
 return {token,expiresInHours:hours};
}
function checkMemo(m){return typeof m==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{5,39}$/.test(m)}
async function handler(req,res){
 const origin=String(req.headers.origin||'');
 if(req.method==='OPTIONS'){
   if(!ALLOWED.has(origin))return send(res,403,{error:'Origin blocked'});
   res.statusCode=204;
   res.setHeader('Access-Control-Allow-Origin',origin);
   res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
   res.setHeader('Access-Control-Max-Age','600');
   return res.end();
 }
 if(origin&&!ALLOWED.has(origin))return send(res,403,{error:'Недопустимый источник'});
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/health')return send(res,ready?200:503,{ok:ready,dbConfigured:hasDatabase,authEnabled:ready,ownerConfigured:Boolean(process.env.OWNER_INITIAL_PASSWORD)},origin);
 if(url.pathname==='/')return send(res,200,{service:'Ice Pay authenticated accounts API',state:ready?'ready':'not_configured'},origin);
 if(!ready)return send(res,503,{error:'Сервер авторизации ещё не настроен. Требуется подключить PostgreSQL.'},origin);
 if(req.method==='POST'&&url.pathname==='/v1/auth/login'){
   if(!throttle(req))return send(res,429,{error:'Слишком много попыток входа. Повторите позже.'},origin);
   const b=await body(req);
   const user=String(b.username||'').trim().toLowerCase(),password=b.password;
   if(!validateLogin(user)||typeof password!=='string'||password.length>128)return send(res,401,{error:'Неверный логин или пароль'},origin);
   const result=await pool.query('SELECT * FROM accounts WHERE username=$1 AND active=true LIMIT 1',[user]);
   if(!result.rowCount||!(await verifyPassword(password,result.rows[0].password_hash)))return send(res,401,{error:'Неверный логин или пароль'},origin);
   const a=result.rows[0];
   if(b.role && b.role!==a.role)return send(res,403,{error:'Недостаточно прав доступа'},origin);
   const session=await issueToken(a.id,a.role);
   await pool.query('DELETE FROM sessions WHERE expires_at<now()');
   return send(res,200,{...session,account:summary(a)},origin);
 }
 const account=await authentication(req);
 if(!account)return send(res,401,{error:'Сессия завершена. Войдите снова.'},origin);
 if(req.method==='GET'&&url.pathname==='/v1/auth/me')return send(res,200,{account:summary(account)},origin);
 if(req.method==='POST'&&url.pathname==='/v1/auth/logout'){
   await pool.query('DELETE FROM sessions WHERE token_hash=$1',[sessionKey(req.headers.authorization.slice(7))]);
   return send(res,200,{ok:true},origin);
 }
 if(req.method==='POST'&&url.pathname==='/v1/auth/change-password'){
   const b=await body(req);
   if(!(await verifyPassword(b.currentPassword,account.password_hash)))return send(res,403,{error:'Текущий пароль неверный'},origin);
   if(!validatePassword(b.newPassword))return send(res,400,{error:'Новый пароль: от 12 до 128 байт'},origin);
   await pool.query('UPDATE accounts SET password_hash=$1,updated_at=now() WHERE id=$2',[await makeHash(b.newPassword),account.id]);
   await pool.query('DELETE FROM sessions WHERE account_id=$1',[account.id]);
   return send(res,200,{ok:true,reauth:true},origin);
 }
 if(account.role!=='owner')return send(res,403,{error:'Разрешено только владельцу'},origin);
 if(req.method==='GET'&&url.pathname==='/v1/admin/traders'){
   const rows=await pool.query("SELECT id,username,role,note,memo,active,created_at,updated_at FROM accounts WHERE role='trader' ORDER BY created_at DESC");
   return send(res,200,{traders:rows.rows.map(summary)},origin);
 }
 if(req.method==='POST'&&url.pathname==='/v1/admin/traders'){
   const b=await body(req);
   const username=String(b.username||'').trim().toLowerCase();
   if(!validateLogin(username))return send(res,400,{error:'Логин: 4–32 символа, латиница, цифры, точка, - или _'},origin);
   if(!validatePassword(b.password))return send(res,400,{error:'Пароль: не менее 12 символов'},origin);
   const note=String(b.note||'').trim();
   if(note.length>500)return send(res,400,{error:'Заметка: до 500 символов'},origin);
   const c=await pool.connect();
   try{
     await c.query('BEGIN');
     const memo=await uniqueMemo(c),id=crypto.randomUUID();
     const insert=await c.query("INSERT INTO accounts(id,username,role,password_hash,note,memo) VALUES ($1,$2,'trader',$3,$4,$5) RETURNING id,username,role,note,memo,active,created_at,updated_at",[id,username,await makeHash(b.password),note,memo]);
     await c.query('INSERT INTO reserved_memos(memo,account_id) VALUES($1,$2)',[memo,id]);
     await c.query('COMMIT');
     return send(res,201,{trader:summary(insert.rows[0]),message:'Трейдер создан. Он может войти под указанным логином и паролем.'},origin);
   }catch(e){
     await c.query('ROLLBACK');
     if(e.code==='23505')return send(res,409,{error:'Такой логин уже используется'},origin);
     throw e;
   }finally{c.release()}
 }
 const match=url.pathname.match(/^\/v1\/admin\/traders\/([0-9a-f-]{36})\/(memo|password|status)$/);
 if(match&&req.method==='PATCH'){
   const [,id,task]=match,b=await body(req);
   const c=await pool.connect();
   try{
    await c.query('BEGIN');
    const found=await c.query("SELECT * FROM accounts WHERE id=$1 AND role='trader' FOR UPDATE",[id]);
    if(!found.rowCount){await c.query('ROLLBACK');return send(res,404,{error:'Трейдер не найден'},origin)}
    const a=found.rows[0];let changed;
    if(task==='memo'){
      const memo=String(b.memo||'').trim(),reason=String(b.reason||'').trim();
      if(!checkMemo(memo)||reason.length>120){await c.query('ROLLBACK');return send(res,400,{error:'Memo: 6–40 символов; латиница, цифры, - и _'},origin)}
      if(memo.toUpperCase()===a.memo.toUpperCase()){await c.query('ROLLBACK');return send(res,400,{error:'Новый Memo совпадает с текущим'},origin)}
      const taken=await c.query('SELECT 1 FROM reserved_memos WHERE upper(memo)=upper($1)',[memo]);
      if(taken.rowCount){await c.query('ROLLBACK');return send(res,409,{error:'Memo уже используется или был использован ранее'},origin)}
      await c.query('INSERT INTO reserved_memos(memo,account_id) VALUES($1,$2)',[memo,id]);
      await c.query('INSERT INTO memo_history(id,account_id,old_memo,new_memo,reason) VALUES($1,$2,$3,$4,$5)',[crypto.randomUUID(),id,a.memo,memo,reason]);
      changed=await c.query("UPDATE accounts SET memo=$1,updated_at=now() WHERE id=$2 RETURNING id,username,role,note,memo,active,created_at,updated_at",[memo,id]);
    }else if(task==='password'){
      if(!validatePassword(b.password)){await c.query('ROLLBACK');return send(res,400,{error:'Пароль: не менее 12 символов'},origin)}
      changed=await c.query("UPDATE accounts SET password_hash=$1,updated_at=now() WHERE id=$2 RETURNING id,username,role,note,memo,active,created_at,updated_at",[await makeHash(b.password),id]);
      await c.query('DELETE FROM sessions WHERE account_id=$1',[id]);
    }else{
      if(typeof b.active!=='boolean'){await c.query('ROLLBACK');return send(res,400,{error:'Ожидается active=true/false'},origin)}
      changed=await c.query("UPDATE accounts SET active=$1,updated_at=now() WHERE id=$2 RETURNING id,username,role,note,memo,active,created_at,updated_at",[b.active,id]);
      if(!b.active)await c.query('DELETE FROM sessions WHERE account_id=$1',[id]);
    }
    await c.query('COMMIT');
    return send(res,200,{trader:summary(changed.rows[0]),ok:true},origin);
   }catch(e){
    await c.query('ROLLBACK');
    if(e.code==='23505')return send(res,409,{error:'Уже используется'},origin);
    throw e;
   }finally{c.release()}
 }
 if(req.method==='GET'&&url.pathname==='/v1/admin/memo-history'){
   const rows=await pool.query('SELECT m.*,a.username FROM memo_history m JOIN accounts a ON a.id=m.account_id ORDER BY m.changed_at DESC LIMIT 100');
   return send(res,200,{history:rows.rows.map(x=>({username:x.username,oldMemo:x.old_memo,newMemo:x.new_memo,reason:x.reason,changedAt:x.changed_at}))},origin);
 }
 return send(res,404,{error:'Маршрут не найден'},origin);
}
http.createServer((req,res)=>handler(req,res).catch(e=>{
 console.error('Ice Pay auth error',e.code||e.message);
 if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Ошибка сервера'},req.headers.origin);
})).listen(PORT,'0.0.0.0',()=>{
 console.log('Ice Pay auth API listening',PORT);
 init().catch(e=>console.error('Ice Pay accounts initialization failed',e.message));
});
