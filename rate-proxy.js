'use strict';
const http = require('node:http');
const PORT = Number(process.env.PORT || 10000);
const ORIGIN = 'https://muslim-pay.onrender.com';
const SOURCE = 'https://api.rapira.net/open/market/rates';
let cache = null, cacheUntil = 0, pending = null;
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
  if (req.url !== '/rate') return json(res, 404, { error: 'Not found' });
  try {
    if (cache && Date.now() < cacheUntil) return json(res, 200, cache);
    if (!pending) pending = requestRate().finally(() => { pending = null; });
    return json(res, 200, await pending);
  } catch (error) {
    console.error('Rapira rates unavailable:', error.message);
    res.setHeader('Retry-After', '20');
    return json(res, 503, { error: 'Rapira temporarily unavailable' });
  }
}).listen(PORT, '0.0.0.0', () => console.log('Ice Pay rates service listening on ' + PORT));
