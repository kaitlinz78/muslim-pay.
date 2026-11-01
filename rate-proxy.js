'use strict';
const http = require('node:http');
const {verifyTx,TREASURY,USDT_CONTRACT} = require('./tron-verify.js');
const PORT = Number(process.env.PORT || 10000);
// All routes in this service are public and use no credentials or cookies.
const PUBLIC_ORIGIN = '*';
const SOURCE = 'https://api.rapira.net/open/market/rates';
const REFERENCE_SOURCE='https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=rub';
const LAST_GOOD_TTL=10*60*1000;
let lastGoodAt=0;
let cache = null, cacheUntil = 0, pending = null;
const perIp = new Map();
function throttle(req) {
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
  const now=Date.now();
  if(perIp.size>5000)perIp.clear();
  const rec=perIp.get(ip)||{count:0,expires:now+60000};
  if(now>rec.expires){rec.count=0;rec.expires=now+60000;}
  rec.count++;perIp.set(ip,rec);
  return rec.count<=12;
}
function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', PUBLIC_ORIGIN);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.end(JSON.stringify(data));
}
async function fetchJson(url, timeout, extraHeaders) {
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeout);
  try {
    const response=await fetch(url,{headers:{Accept:'application/json',...(extraHeaders||{})},signal:c.signal});
    if(!response.ok)throw new Error('Rate source HTTP '+response.status);
    return await response.json();
  }finally{clearTimeout(timer);}
}
function validPrice(value){
  const price=Number(value);
  if(!Number.isFinite(price)||price<1||price>10000)throw new Error('Invalid USDT/RUB quote');
  return price;
}
async function requestRate(){
  let quote;
  try{
    const payload=await fetchJson(SOURCE,8500,{'User-Agent':'OnlyMatch-Quote/2.0'});
    const market=Array.isArray(payload?.data)?payload.data.find(item=>item.symbol==='USDT/RUB'):null;
    if(!market)throw new Error('USDT/RUB market absent');
    const bidPrice=validPrice(market.bidPrice);
    quote={symbol:'USDT/RUB',bidPrice,source:'Rapira',type:'bidPrice',updatedAt:new Date().toISOString()};
  }catch(primaryError){
    console.warn('USDT/RUB exchange quote failed, trying reference:',primaryError.message);
    const data=await fetchJson(REFERENCE_SOURCE,8500);
    const bidPrice=validPrice(data?.tether?.rub);
    quote={symbol:'USDT/RUB',bidPrice,source:'CoinGecko',type:'reference',updatedAt:new Date().toISOString()};
  }
  cache=quote;lastGoodAt=Date.now();cacheUntil=lastGoodAt+25000;
  return quote;
}
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', PUBLIC_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    res.statusCode = 204; return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  if (req.url === '/health') return json(res, 200, { ok: true, service: 'OnlyMatch market quotes' });
  const route=new URL(req.url,'http://localhost');
  if(route.pathname === '/trc20/config') {
    res.setHeader('Cache-Control','no-store');
    return json(res,200,{network:'TRON Mainnet',token:'USDT',contract:USDT_CONTRACT,address:TREASURY,decimals:6,autoCreditEnabled:false,accounting:'demo only'});
  }
  if(route.pathname === '/trc20/verify'){
    res.setHeader('Cache-Control','no-store');
    if(!throttle(req)){res.setHeader('Retry-After','60');return json(res,429,{status:'rate_limited',message:'Слишком много проверок, попробуйте позже'});}
    const txid=route.searchParams.get('txid')||'';
    const amount=route.searchParams.get('amount')||'';
    if(!/^[a-f0-9]{64}$/i.test(txid))return json(res,400,{status:'invalid_txid',message:'Укажите корректный хэш транзакции (64 символа)'});
    if(amount&&!/^\d{1,7}(\.\d{1,6})?$/.test(amount))return json(res,400,{status:'invalid_amount',message:'Укажите сумму USDT до шести знаков после точки'});
    try{
      const result=await verifyTx(txid,amount);
      return json(res,200,result);
    }catch(error){
      console.error('TRON verification failed:',error.message);
      return json(res,503,{status:'unavailable',message:'Сеть TRON сейчас недоступна для проверки. Повторите позднее.'});
    }
  }
  if(route.pathname !== '/rate') return json(res, 404, { error: 'Not found' });
  try {
    if (cache && Date.now() < cacheUntil) return json(res, 200, cache);
    if (!pending) pending = requestRate().finally(() => { pending = null; });
    return json(res, 200, await pending);
  } catch (error) {
    console.error('USDT/RUB quote unavailable:', error.message);
    if(cache && lastGoodAt && Date.now()-lastGoodAt<LAST_GOOD_TTL)
      return json(res,200,{...cache,stale:true});
    res.setHeader('Retry-After','20');
    return json(res,503,{error:'USDT/RUB data temporarily unavailable'});
  }
}).listen(PORT, '0.0.0.0', () => { console.log('OnlyMatch market quote service listening on ' + PORT); requestRate().then(r => console.log('USDT/RUB quote fetched:', r.bidPrice, r.source)).catch(e => console.error('Quote startup check failed:', e.message)); verifyTx('0'.repeat(64),'').then(r=>console.log('TRON receipt API readiness:',r.status)).catch(e=>console.error('TRON receipt API readiness failed:',e.message)); });
