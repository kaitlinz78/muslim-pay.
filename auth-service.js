'use strict';
/**
 * Ice Pay: interim authenticated account API.
 * Render Free Key Value is VOLATILE: state can vanish on any restart.
 * This API must NOT be used as a durable payment ledger or for real customer funds.
 * Production replacement: auth-service-postgres.js with a permanent PostgreSQL database.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { createClient } = require('redis');
const dns = require('node:dns').promises;
const net = require('node:net');
const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 10000);
const REDIS_URL = process.env.REDIS_URL || '';
const OWNER_USERNAME = (process.env.OWNER_INITIAL_USERNAME || 'owner').toLowerCase();
const ORIGINS = new Set(['https://muslim-pay.onrender.com', 'https://ice-pay-owner.onrender.com']);
const ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PREFIX = 'ice:auth:v1:';
const LIMIT = 16384;
const MIN_INSURANCE_USDT = 500;
// Only a verified server-side insurance ledger may unlock work. Never trust browser balances.
// No payment verification integration is connected yet, so new accounts begin at 0.

let ready = false;
let storage = null;
function key(s) { return PREFIX + s; }
function reply(res, status, obj, origin) {
  res.statusCode = status;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}
function issue(status, message) { return Object.assign(new Error(message), { status }); }
function loginValid(x) { return typeof x === 'string' && /^[a-z][a-z0-9_.-]{3,31}$/.test(x); }
function passValid(x) { return typeof x === 'string' && Buffer.byteLength(x) >= 12 && Buffer.byteLength(x) <= 128; }
function traderLoginValid(x) { return typeof x === 'string' && x.length >= 1 && x.length <= 64 && !/[\x00-\x1f\x7f]/.test(x); }
function traderPassValid(x) { return typeof x === 'string' && x.length >= 1 && x.length <= 128 && Buffer.byteLength(x,'utf8') <= 512; }
function memoValid(x) { return typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{5,39}$/.test(x); }
function normalizeMemo(x) { return x.toUpperCase(); }
async function pwHash(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + (await scrypt(pass, salt, 64)).toString('hex');
}
async function pwCheck(pass, stored) {
  if (typeof pass !== 'string' || pass.length > 128 || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (!/^[a-f0-9]{32}$/.test(parts[0] || '') || !/^[a-f0-9]{128}$/.test(parts[1] || '')) return false;
  const digest = await scrypt(pass, parts[0], 64);
  return crypto.timingSafeEqual(digest, Buffer.from(parts[1], 'hex'));
}
function tokenHash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function toPublic(a) {
  return { id:a.id, username:a.username, role:a.role, note:a.note||'', memo:a.memo||null,
    active:!!a.active, working:!!a.working, createdAt:a.createdAt||null, updatedAt:a.updatedAt||null };
}
function assertStorage() {
  if (!ready || !storage || !storage.isReady) throw issue(503, 'Хранилище аккаунтов недоступно');
}
async function getAcc(id) {
  const raw = await storage.get(key('account:' + id));
  return raw ? JSON.parse(raw) : null;
}
async function saveAcc(a) {
  a.updatedAt = new Date().toISOString();
  await storage.set(key('account:' + a.id), JSON.stringify(a));
}
async function financeOf(account) {
  // This is intentionally read-only: payment integration must verify and credit funds independently.
  // An absent verified ledger is zero; no client-supplied amounts can enter this calculation.
  const raw = await storage.get(key('finance:verified-insurance:' + account.id));
  const parsed = typeof raw==='string' && /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(raw) ? Number(raw) : 0;
  const confirmedInsuranceUSDT = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  const workEligible = confirmedInsuranceUSDT >= MIN_INSURANCE_USDT;
  return {
    accountId: account.id,
    confirmedInsuranceUSDT,
    minimumInsuranceUSDT: MIN_INSURANCE_USDT,
    shortfallUSDT: Math.max(0, Math.round((MIN_INSURANCE_USDT-confirmedInsuranceUSDT)*100)/100),
    workEligible,
    working: workEligible && !!account.working,
    verification: raw === null ? 'not_connected' : 'server_verified',
    autoCreditEnabled: false,
    note: raw === null ? 'Нет подтверждённого поступления страхового депозита. Автозачисление не подключено.' : 'Баланс по серверному учёту подтверждённых поступлений.'
  };
}
async function allocateMemo() {
  for (let tries=0;tries<50;tries++) {
    const random=crypto.randomBytes(14);
    const memo='ICE-'+Array.from(random, i => ABC[i % ABC.length]).join('');
    if (!(await storage.exists(key('memo:'+normalizeMemo(memo))))) return memo;
  }
  throw issue(503, 'Не удалось создать уникальный Memo');
}
async function ensureOwner() {
  if (!storage?.isReady) return;
  const password=process.env.OWNER_INITIAL_PASSWORD;
  if (!passValid(password)) {ready=false;console.warn('OWNER_INITIAL_PASSWORD not configured or too short');return;}
  if (!loginValid(OWNER_USERNAME)) {ready=false;console.warn('OWNER_INITIAL_USERNAME invalid');return;}
  const usernameKey=key('username:'+OWNER_USERNAME);
  let id=await storage.get(usernameKey);
  if (id && await getAcc(id)) {ready=true;return;}
  // Free Redis may have lost all keys on restart. The Owner bootstrap is restored.
  const owner={id:crypto.randomUUID(),username:OWNER_USERNAME,role:'owner',
    passwordHash:await pwHash(password),note:'',memo:null,active:true,sessionVersion:1,
    createdAt:new Date().toISOString()};
  await storage.set(usernameKey,owner.id);
  await saveAcc(owner);
  ready=true;
  console.log('Owner ready; storage=volatile free Redis. Trader data does not survive Redis resets.');
}
async function initialize() {
  if (!REDIS_URL) {console.warn('REDIS_URL missing; account API disabled');return;}
  const redisHost=new URL(REDIS_URL).hostname;
  dns.lookup(redisHost).then(x=>console.log('Internal KV DNS:',x.address,x.family)).catch(e=>console.error('Internal KV DNS error:',e.code,e.message));
  const probe=net.connect({host:redisHost,port:6379,timeout:5000});
  probe.once('connect',()=>{console.log('Internal KV TCP reachable');probe.destroy()});
  probe.once('error',e=>console.error('Internal KV TCP error:',e.code,e.message));
  probe.once('timeout',()=>{console.error('Internal KV TCP timeout');probe.destroy()});
  storage=createClient({url:REDIS_URL, socket:{connectTimeout:10000,reconnectStrategy:attempt => Math.min(500*attempt,8000)}});
  storage.on('error', e => {ready=false;console.error('Redis connection error:',e.message)});
  storage.on('ready', () => {ensureOwner().catch(e=>{ready=false;console.error('Owner recovery:',e.message)})});
  await storage.connect();
  await ensureOwner();
  const timer=setInterval(()=>ensureOwner().catch(e=>console.error('Owner check:',e.message)),60000);
  timer.unref();
  console.log('Ice Pay authorization API listening on Redis (VOLATILE, DEMO ONLY)');
  try {
    // Verify the actual login, bearer-token, and logout HTTP routes once on startup.
    // No passwords or tokens are logged.
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    try {
      const origin='https://ice-pay-owner.onrender.com';
      const base='http://127.0.0.1:'+PORT;
      const login=await fetch(base+'/v1/auth/login',{
        method:'POST',headers:{'Origin':origin,'Content-Type':'application/json'},
        body:JSON.stringify({username:OWNER_USERNAME,password:process.env.OWNER_INITIAL_PASSWORD,role:'owner'}),
        signal:controller.signal
      });
      const session=await login.json();
      if(!login.ok||!session.token||session.account?.role!=='owner')throw new Error('Login endpoint rejected Owner: '+login.status);
      const me=await fetch(base+'/v1/auth/me',{headers:{'Origin':origin,'Authorization':'Bearer '+session.token},signal:controller.signal});
      const current=await me.json();
      if(!me.ok||current.account?.id!==session.account.id)throw new Error('Token validation failed');
      const logout=await fetch(base+'/v1/auth/logout',{method:'POST',headers:{'Origin':origin,'Authorization':'Bearer '+session.token},signal:controller.signal});
      if(!logout.ok)throw new Error('Logout endpoint failed');
      console.log('OWNER AUTH HTTP SELF-TEST PASSED: login, bearer token, logout');
    }finally{clearTimeout(timer)}
  }catch(err){
    console.error('Owner auth smoke test failed:',err.message);
  }
}
async function parseBody(req) {
  const chunks=[];let length=0;
  for await(const c of req) { length+=c.length;if(length>LIMIT)throw issue(413,'Слишком большой запрос');chunks.push(c); }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  catch{throw issue(400,'Неверный формат запроса');}
}
async function auth(req) {
  const header=String(req.headers.authorization||'');
  if (!header.startsWith('Bearer ')) return null;
  const token=header.slice(7);
  if(!/^[0-9a-f]{64}$/.test(token))return null;
  const raw=await storage.get(key('session:'+tokenHash(token)));
  if(!raw)return null;
  const session=JSON.parse(raw);
  const account=await getAcc(session.accountId);
  if(!account||!account.active||account.sessionVersion!==session.version)return null;
  return {account,token};
}
async function rateLimit(req) {
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
  const hashed=crypto.createHash('sha256').update(ip).digest('hex');
  const k=key('rate:'+hashed);
  const count=await storage.incr(k);
  if(count===1)await storage.expire(k,900);
  return count<=12;
}
async function newSession(account) {
  const token=crypto.randomBytes(32).toString('hex');
  const hours=account.role==='owner'?8:24;
  const raw=JSON.stringify({accountId:account.id,version:account.sessionVersion});
  await storage.set(key('session:'+tokenHash(token)),raw,{EX:hours*3600});
  return {token,expiresInHours:hours};
}
async function recordAudit(action,details={}) {
  try {
    const entry={action,details,actor:'owner',at:new Date().toISOString()};
    await storage.lPush(key('owner-audit'),JSON.stringify(entry));
    await storage.lTrim(key('owner-audit'),0,199);
  } catch(e){console.error('Owner audit append failed',e.message);}
}
async function listTraders() {
  const ids=await storage.sMembers(key('trader-ids'));
  const accounts=(await Promise.all(ids.map(getAcc))).filter(Boolean);
  const sorted=accounts.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return Promise.all(sorted.map(async a => ({...toPublic(a),finance:await financeOf(a)})));
}
function validateMemoChange(a,memo) {
  if(!memoValid(memo))throw issue(400,'Memo: от 6 до 40 символов, латиница, цифры, дефис или _');
  if(normalizeMemo(memo)===normalizeMemo(a.memo))throw issue(400,'Этот Memo уже назначен');
}
async function handle(req,res) {
  const origin=String(req.headers.origin||'');
  if(req.method==='OPTIONS') {
    if(!ORIGINS.has(origin))return reply(res,403,{error:'Источник запрещён'},origin);
    res.statusCode=204;
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
    res.setHeader('Access-Control-Max-Age','600');
    return res.end();
  }
  if(origin&&!ORIGINS.has(origin))return reply(res,403,{error:'Источник запрещён'},origin);
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/health') {
    return reply(res,ready?200:503,{ok:ready,authEnabled:ready,storage:'volatile-free-redis',persistent:false,ownerConfigured:ready},origin);
  }
  if(url.pathname==='/')return reply(res,200,{service:'Ice Pay account API',authEnabled:ready,persistent:false},origin);
  assertStorage();
  if(req.method==='POST'&&url.pathname==='/v1/auth/login') {
    if(!(await rateLimit(req)))throw issue(429,'Слишком много попыток входа. Повторите через 15 минут');
    const data=await parseBody(req);
    const username=String(data.username||'').trim().toLowerCase();
    const password=data.password;
    if(!traderLoginValid(username)||!traderPassValid(password))throw issue(401,'Неверный логин или пароль');
    const id=await storage.get(key('username:'+username));
    const account=id?await getAcc(id):null;
    if(!account||!account.active||!(await pwCheck(password,account.passwordHash)))
      throw issue(401,'Неверный логин или пароль');
    if(data.role&&data.role!==account.role)throw issue(403,'Недостаточно прав доступа');
    const session=await newSession(account);
    return reply(res,200,{...session,account:toPublic(account),storageVolatile:true},origin);
  }
  const cred=await auth(req);
  if(!cred)throw issue(401,'Сессия завершена. Войдите снова');
  const {account,token}=cred;
  if(req.method==='GET'&&url.pathname==='/v1/auth/me')
    return reply(res,200,{account:toPublic(account),storageVolatile:true},origin);
  if(req.method==='GET'&&url.pathname==='/v1/trader/ton-deposit') {
    if(account.role!=='trader')throw issue(403,'Доступ только трейдеру');
    if(!memoValid(account.memo))throw issue(409,'Для трейдера ещё не назначен корректный Memo');
    return reply(res,200,{
      network:'TON Mainnet',
      asset:'TON',
      address:'UQAgFVjnzg6AVfcEyGHdlxldESgjfoos2I8Nn42sU4f_0ViE',
      memo:account.memo,
      accountId:account.id,
      status:'preview_only',
      autoCreditEnabled:false,
      depositLedgerEnabled:false,
      note:'Реквизиты для предварительной проверки. Автозачисление и реальный учёт депозитов пока отключены.'
    },origin);
  }
  if(req.method==='GET'&&url.pathname==='/v1/trader/finance') {
    if(account.role!=='trader')throw issue(403,'Доступ только трейдеру');
    return reply(res,200,{finance:await financeOf(account)},origin);
  }
  if(req.method==='POST'&&url.pathname==='/v1/trader/work-status') {
    if(account.role!=='trader')throw issue(403,'Доступ только трейдеру');
    const data=await parseBody(req);
    if(typeof data.working!=='boolean')throw issue(400,'Передайте working=true или false');
    const finance=await financeOf(account);
    if(data.working && !finance.workEligible)
      throw issue(403,'Для начала работы нужен подтверждённый страховой депозит от 500 USDT');
    account.working=data.working;
    await saveAcc(account);
    return reply(res,200,{ok:true,finance:await financeOf(account)},origin);
  }
  // A trader can request removal of a locally archived requisite only after
  // its deletion snapshot has been accepted by the Owner-visible server audit.
  // Snapshot status is trader-reported because local requisites aren't server-managed.
  if(req.method==='POST'&&url.pathname==='/v1/trader/requisites/deletions') {
    if(account.role!=='trader')throw issue(403,'Доступ только трейдеру');
    const b=await parseBody(req);
    const r=b?.requisite;
    if(!r||typeof r!=='object'||Array.isArray(r)||r.status!=='archived')
      throw issue(400,'Удалять можно только архивные реквизиты');
    const txt=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
    const id=txt(r.id,80),name=txt(r.name,80),type=txt(r.type,64);
    if(!/^[A-Za-z0-9_-]{2,80}$/.test(id)||!name||name.length>80||!type)
      throw issue(400,'Некорректные данные реквизита');
    let detail=txt(r.detail,100);
    // Never send or retain a full bank-card PAN in the audit.
    if(/^(?:[\d\s-]{16,30})$/.test(detail)&&detail.replace(/\D/g,'').length>=16)detail='•••• '+detail.replace(/\D/g,'').slice(-4);
    const onlySafeAmount=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000000000?value:null;
    const entry={
      auditId:crypto.randomUUID(),requisiteId:id,accountId:account.id,
      username:account.username, name,type,detail,
      holder:txt(r.holder,90),createdAt:txt(r.createdAt,36),
      archivedAt:txt(r.archivedAt,36),
      minPaymentRub:onlySafeAmount(r.minPaymentRub),
      maxPaymentRub:onlySafeAmount(r.maxPaymentRub),
      totalLimitRub:onlySafeAmount(r.totalLimitRub),
      maxActiveOrders:Number.isSafeInteger(r.maxActiveOrders)&&r.maxActiveOrders>=0&&r.maxActiveOrders<=1000?r.maxActiveOrders:null,
      deletedAt:new Date().toISOString(),source:'trader_local_archive'
    };
    // Store both the detailed record and activity marker in one Redis transaction.
    // This storage is volatile: production retention needs persistent PostgreSQL.
    const event={action:'requisite.deleted',actor:account.username,at:entry.deletedAt,
      details:{username:account.username,requisiteId:id,name,type,detail,
       holder:entry.holder,totalLimitRub:entry.totalLimitRub,accountId:account.id}};
    await storage.multi()
      .lPush(key('requisite-deletion-history'),JSON.stringify(entry))
      .lTrim(key('requisite-deletion-history'),0,499)
      .lPush(key('owner-audit'),JSON.stringify(event))
      .lTrim(key('owner-audit'),0,199)
      .exec();
    return reply(res,201,{ok:true,auditId:entry.auditId,deletedAt:entry.deletedAt},origin);
  }
  if(req.method==='POST'&&url.pathname==='/v1/auth/logout') {
    await storage.del(key('session:'+tokenHash(token)));
    return reply(res,200,{ok:true},origin);
  }
  if(req.method==='POST'&&url.pathname==='/v1/auth/change-password'){
    const data=await parseBody(req);
    if(!(await pwCheck(data.currentPassword,account.passwordHash)))throw issue(403,'Текущий пароль неверный');
    if(!passValid(data.newPassword))throw issue(400,'Новый пароль: минимум 12 символов');
    account.passwordHash=await pwHash(data.newPassword);
    account.sessionVersion++;
    await saveAcc(account);
    return reply(res,200,{ok:true,reauth:true},origin);
  }
  if(account.role!=='owner')throw issue(403,'Разрешено только владельцу');
  // Merchant registry: owner-controlled configuration ONLY; no payment processing is enabled.
  if(req.method==='GET'&&url.pathname==='/v1/admin/merchants') {
    const ids=await storage.sMembers(key('merchant-ids'));
    const merchants=(await Promise.all(ids.map(async id=>{
      const raw=await storage.get(key('merchant:'+id));
      return raw?JSON.parse(raw):null;
    }))).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return reply(res,200,{merchants,storageVolatile:true,paymentProcessingEnabled:false},origin);
  }
  if(req.method==='POST'&&url.pathname==='/v1/admin/merchants') {
    const data=await parseBody(req);
    const name=typeof data.name==='string'?data.name.trim():'';
    const website=typeof data.website==='string'?data.website.trim():'';
    const note=typeof data.note==='string'?data.note.trim():'';
    if(!name||name.length>80||/[\x00-\x1f\x7f]/.test(name))throw issue(400,'Название мерчанта: от 1 до 80 символов');
    if(note.length>500)throw issue(400,'Заметка: не более 500 символов');
    if(website && (website.length>255||!/^(https:\/\/)[^\s]+$/i.test(website)))throw issue(400,'Сайт мерчанта должен быть ссылкой HTTPS');
    const merchant={id:crypto.randomUUID(),name,website,note,status:'draft',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await storage.set(key('merchant:'+merchant.id),JSON.stringify(merchant));
    await storage.sAdd(key('merchant-ids'),merchant.id);
    await recordAudit('merchant.created',{id:merchant.id,name});
    return reply(res,201,{merchant,paymentProcessingEnabled:false},origin);
  }
  const merchantRoute=url.pathname.match(/^\/v1\/admin\/merchants\/([a-f0-9-]{36})$/);
  if(req.method==='PATCH'&&merchantRoute) {
    const raw=await storage.get(key('merchant:'+merchantRoute[1]));
    if(!raw)throw issue(404,'Мерчант не найден');
    const merchant=JSON.parse(raw),data=await parseBody(req);
    const name=typeof data.name==='string'?data.name.trim():'';
    const website=typeof data.website==='string'?data.website.trim():'';
    const note=typeof data.note==='string'?data.note.trim():'';
    const status=data.status;
    if(!name||name.length>80||/[\x00-\x1f\x7f]/.test(name))throw issue(400,'Название мерчанта: от 1 до 80 символов');
    if(note.length>500)throw issue(400,'Заметка: не более 500 символов');
    if(website && (website.length>255||!/^(https:\/\/)[^\s]+$/i.test(website)))throw issue(400,'Сайт мерчанта должен быть ссылкой HTTPS');
    if(!['draft','paused'].includes(status))throw issue(400,'Доступны только статусы черновик или приостановлен');
    Object.assign(merchant,{name,website,note,status,updatedAt:new Date().toISOString()});
    await storage.set(key('merchant:'+merchant.id),JSON.stringify(merchant));
    await recordAudit('merchant.updated',{id:merchant.id,name,status});
    return reply(res,200,{merchant,paymentProcessingEnabled:false},origin);
  }
  if(req.method==='GET'&&url.pathname==='/v1/admin/activity') {
    const values=await storage.lRange(key('owner-audit'),0,99);
    return reply(res,200,{events:values.map(x=>JSON.parse(x)),storageVolatile:true},origin);
  }
  if(req.method==='GET'&&url.pathname==='/v1/admin/requisite-deletions') {
    const values=await storage.lRange(key('requisite-deletion-history'),0,199);
    return reply(res,200,{deletions:values.map(x=>JSON.parse(x)),storageVolatile:true},origin);
  }
  if(req.method==='GET'&&url.pathname==='/v1/admin/overview') {
    const users=await listTraders();
    const valid=users.filter(u=>u.active);
    return reply(res,200,{traders:users.length,activeTraders:valid.length,
      blockedTraders:users.length-valid.length,registeredMemos:users.filter(u=>u.memo).length,
      verifiedInsuranceUSDT:users.reduce((sum,u)=>sum+Number(u.finance?.confirmedInsuranceUSDT||0),0),
      paymentLedgerEnabled:false,realPayoutsEnabled:false,paymentOrdersConnected:false,
      storage:'temporary',financialSource:'verified-insurance-only'},origin);
  }
  if(req.method==='GET'&&url.pathname==='/v1/admin/traders') {
    return reply(res,200,{traders:await listTraders(),storageVolatile:true},origin);
  }
  const financeRoute=url.pathname.match(/^\/v1\/admin\/traders\/([a-f0-9-]{36})\/finance$/);
  if(req.method==='GET'&&financeRoute) {
    const trader=await getAcc(financeRoute[1]);
    if(!trader||trader.role!=='trader')throw issue(404,'Трейдер не найден');
    return reply(res,200,{trader:toPublic(trader),finance:await financeOf(trader)},origin);
  }
  if(req.method==='POST'&&url.pathname==='/v1/admin/traders'){
    const data=await parseBody(req);
    const username=String(data.username??'').trim();
    if(!traderLoginValid(username))throw issue(400,'Логин: от 1 до 64 символов, можно цифры, кириллицу, пробелы и спецсимволы');
    if(!traderPassValid(data.password))throw issue(400,'Пароль: от 1 до 128 символов');
    const note=String(data.note||'').trim();
    if(note.length>500)throw issue(400,'Заметка не больше 500 символов');
    const nameKey=key('username:'+username.toLowerCase());
    if(await storage.exists(nameKey))throw issue(409,'Такой логин уже существует');
    const id=crypto.randomUUID();
    const memo=await allocateMemo();
    // Reserve both the login and memo before writing the trader.
    const reserved=await storage.set(nameKey,id,{NX:true});
    if(reserved!=='OK')throw issue(409,'Такой логин уже существует');
    const memoKey=key('memo:'+normalizeMemo(memo));
    const reservedMemo=await storage.set(memoKey,id,{NX:true});
    if(reservedMemo!=='OK') {await storage.del(nameKey);throw issue(409,'Не получилось зарезервировать Memo');}
    try {
      const trader={id,username,role:'trader',passwordHash:await pwHash(data.password),
        note,memo,active:true,working:false,sessionVersion:1,createdAt:new Date().toISOString()};
      await saveAcc(trader);
      await storage.sAdd(key('trader-ids'),id);
      await recordAudit('trader.created',{id,username});
      return reply(res,201,{trader:toPublic(trader),message:'Трейдер создан; логин и пароль активны. Хранилище временное.'},origin);
    }catch(e) {await storage.del(nameKey,memoKey,key('account:'+id));throw e;}
  }
  const match=url.pathname.match(/^\/v1\/admin\/traders\/([a-f0-9-]{36})\/(memo|password|status)$/);
  if(match&&req.method==='PATCH'){
    const id=match[1],op=match[2],data=await parseBody(req);
    const trader=await getAcc(id);
    if(!trader||trader.role!=='trader')throw issue(404,'Трейдер не найден');
    if(op==='memo') {
      const memo=String(data.memo||'').trim();
      const reason=String(data.reason||'').trim();
      validateMemoChange(trader,memo);
      if(reason.length>120)throw issue(400,'Причина: не более 120 символов');
      const candidate=key('memo:'+normalizeMemo(memo));
      if(await storage.set(candidate,id,{NX:true})!=='OK')throw issue(409,'Memo уже используется или находится в архиве');
      const oldMemo=trader.memo;
      trader.memo=memo;
      await saveAcc(trader);
      await storage.lPush(key('memo-history'),JSON.stringify({
        username:trader.username,oldMemo,newMemo:memo,reason,changedAt:new Date().toISOString()
      }));
      await storage.lTrim(key('memo-history'),0,99);
      await recordAudit('memo.changed',{id,username:trader.username,oldMemo,newMemo:memo});
    }else if(op==='password'){
      if(!traderPassValid(data.password))throw issue(400,'Пароль: от 1 до 128 символов');
      trader.passwordHash=await pwHash(data.password);
      trader.sessionVersion++;
      await saveAcc(trader);
      await recordAudit('trader.password_changed',{id,username:trader.username});
    }else {
      if(typeof data.active!=='boolean')throw issue(400,'Ожидается true или false');
      trader.active=data.active;
      if(!data.active)trader.sessionVersion++;
      await saveAcc(trader);
      await recordAudit('trader.status_changed',{id,username:trader.username,active:trader.active});
    }
    return reply(res,200,{trader:toPublic(trader),ok:true},origin);
  }
  if(req.method==='GET'&&url.pathname==='/v1/admin/memo-history'){
    const values=await storage.lRange(key('memo-history'),0,99);
    return reply(res,200,{history:values.map(x=>JSON.parse(x))},origin);
  }
  throw issue(404,'Маршрут не найден');
}
http.createServer((req,res)=>handle(req,res).catch(err=>{
  if(err.status!==401&&err.status!==429)console.error('Ice Pay auth:',err.message);
  if(!res.headersSent)reply(res,err.status||500,{error:err.status?err.message:'Ошибка сервера'},req.headers.origin);
})).listen(PORT,'0.0.0.0',()=>{
  console.log('Ice Pay accounts API HTTP started on',PORT);
  initialize().catch(e=>{ready=false;console.error('Ice Pay accounts backend not ready:',e.message)});
});
