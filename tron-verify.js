'use strict';
// Read-only TRON mainnet USDT TRC20 receipt verification.
// IMPORTANT: No account balance modifications, no payment acceptance, no custody keys.
const crypto = require('node:crypto');

const TREASURY = 'TGfwabyvWcCC9wHJLbqiE7x9P5GDsnD63J';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function tronToHex(s) {
  if (typeof s !== 'string' || s.length < 25 || s.length > 36) throw new Error('Invalid TRON address');
  let n = 0n;
  for (const ch of s) {
    const i=ALPHABET.indexOf(ch); if (i < 0) throw new Error('Invalid TRON alphabet');
    n = n * 58n + BigInt(i);
  }
  const result=Buffer.alloc(25);
  for(let i=24; i>=0;i--){result[i]=Number(n & 255n);n >>= 8n;}
  if(n !== 0n || result[0] !== 0x41)throw new Error('Invalid TRON address size');
  const check=crypto.createHash('sha256').update(crypto.createHash('sha256').update(result.subarray(0,21)).digest()).digest().subarray(0,4);
  if(!result.subarray(21,25).equals(check))throw new Error('Invalid TRON checksum');
  return result.subarray(1,21).toString('hex');
}
const destination = tronToHex(TREASURY);
const contract = tronToHex(USDT_CONTRACT);

function amountFromBaseUnits(value) {
  const raw=BigInt(value);
  const integer=raw/1000000n, fractional=(raw%1000000n).toString().padStart(6,'0');
  return integer.toString()+'.'+fractional;
}
function inspectReceipt(receipt, txid, expectedAmount) {
  if(!receipt || receipt.id?.toLowerCase()!==txid.toLowerCase() || receipt.receipt?.result!=='SUCCESS')
    return {status:'unconfirmed',message:'Подтверждённый успешный перевод пока не найден'};
  const transfers=[];
  for(let index=0;index<(receipt.log||[]).length;index++){
    const log=receipt.log[index], topics=log?.topics||[];
    if(String(log?.address||'').replace(/^0x/,'').toLowerCase()!==contract)continue;
    if(topics.length<3||String(topics[0]).replace(/^0x/,'').toLowerCase()!==TRANSFER_TOPIC)continue;
    const recipient=String(topics[2]).replace(/^0x/,'').toLowerCase();
    if(!/^[0-9a-f]{64}$/.test(recipient)||recipient.slice(-40)!==destination)continue;
    const value=String(log?.data||'').replace(/^0x/,'');
    if(!/^[0-9a-f]{64}$/.test(value))continue;
    const base=BigInt('0x'+value);
    if(base<=0n)continue;
    transfers.push({eventIndex:index, amount:amountFromBaseUnits(base)});
  }
  if(!transfers.length)return {status:'not_ours',message:'Нет подтверждённого перевода USDT TRC20 на адрес Ice Pay в этой транзакции'};
  let matched=transfers;
  if(expectedAmount){
    const e=String(expectedAmount);
    if(!/^\d{1,7}(\.\d{1,6})?$/.test(e)) return {status:'invalid_amount',message:'Сумма должна содержать не более 6 знаков после точки'};
    const n=BigInt(e.split('.')[0])*1000000n+BigInt((e.split('.')[1]||'').padEnd(6,'0'));
    matched=transfers.filter(t=>{const [a,b]=t.amount.split('.');return BigInt(a)*1000000n+BigInt(b)===n;});
  }
  if(!matched.length)return {status:'amount_mismatch',message:'Перевод найден, но сумма отличается от суммы заявки',transfers};
  return {status:'confirmed',message:'Перевод USDT подтверждён сетью TRON',txid,transfers:matched,blockTimeStamp:receipt.blockTimeStamp,contract:USDT_CONTRACT,to:TREASURY};
}
async function verifyTx(txid, expectedAmount) {
  if(typeof txid!=='string'|| !/^[0-9a-fA-F]{64}$/.test(txid))return {status:'invalid_txid',message:'Хэш транзакции должен содержать 64 шестнадцатеричных символа'};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try {
    const headers={'Content-Type':'application/json','Accept':'application/json'};
    if(process.env.TRONGRID_API_KEY)headers['TRON-PRO-API-KEY']=process.env.TRONGRID_API_KEY;
    const response=await fetch('https://api.trongrid.io/walletsolidity/gettransactioninfobyid',{method:'POST',headers,body:JSON.stringify({value:txid.toLowerCase()}),signal:controller.signal});
    if(!response.ok)throw new Error('TRON HTTP '+response.status);
    const result=await response.json();
    return inspectReceipt(result,txid,expectedAmount);
  } finally {clearTimeout(timer);}
}
module.exports={TREASURY,USDT_CONTRACT,tronToHex,inspectReceipt,verifyTx};
