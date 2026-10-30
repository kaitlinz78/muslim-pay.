'use strict';
const http = require('node:http');
const {verifyTx,TREASURY,USDT_CONTRACT} = require('./tron-verify.js');
const PORT = Number(process.env.PORT || 10000);
const ORIGIN = 'https://muslim-pay.onrender.com';
const SOURCE = 'https://api.rapira.net/open/market/rates';
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
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'public, max-age=15');
  res.end(JSON.stringify(data));
}
async function requestRate() {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 8500);
  try {
    const response = await fetch(SOURCE, {
      headers: { Accept: 'application/json', 'User-Agent': 'IcePay-RapiraRate/1.0' },
      signal: c.signal
    });
    if (!response.ok) throw new Error('Rapira HTTP ' + response.status);
    const payload = await response.json();
    const row = Array.isArray(payload.data)
      ? payload.data.find(item => item.symbol === 'USDT/RUB') : null;
    const bidPrice = Number(row?.bidPrice);
    if (!Number.isFinite(bidPrice) || bidPrice <= 0 || bidPrice > 10000)
      throw new Error('Rapira bidPrice unavailable');
    const result = { symbol: 'USDT/RUB', bidPrice, source: 'Rapira',
      updatedAt: new Date().toISOString(), type: 'bidPrice' };
    cache = result;
    cacheUntil = Date.now() + 25000;
    return result;
  } finally { clearTimeout(timer); }
}
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    res.statusCode = 204; return res.end();
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  if (req.url === '/health') return json(res, 200, { ok: true, service: 'Ice Pay rates' });
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
    console.error('Rapira rates unavailable:', error.message);
    res.setHeader('Retry-After', '20');
    return json(res, 503, { error: 'Rapira temporarily unavailable' });
  }
}).listen(PORT, '0.0.0.0', () => { console.log('Ice Pay rates service listening on ' + PORT); requestRate().then(r => console.log('Rapira USDT/RUB bid fetched successfully:', r.bidPrice)).catch(e => console.error('Rapira startup check failed:', e.message)); verifyTx('0'.repeat(64),'').then(r=>console.log('TRON receipt API readiness:',r.status)).catch(e=>console.error('TRON receipt API readiness failed:',e.message)); });
