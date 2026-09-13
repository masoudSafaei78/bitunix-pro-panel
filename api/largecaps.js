import { getFundingRisk } from '../lib/fundingRisk.mjs';

const BITUNIX='https://fapi.bitunix.com';
const COINGECKO='https://api.coingecko.com/api/v3';
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};

async function getJson(url, headers={}){
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'bitunix-pro-panel/1.0',...headers},cache:'no-store'});
  const text=await r.text();
  let j; try{j=JSON.parse(text)}catch{throw new Error('Invalid JSON from upstream')}
  if(!r.ok) throw new Error(`Upstream ${r.status}`);
  return j;
}

async function bitunix(path){
  const j=await getJson(BITUNIX+path);
  if(Number(j?.code)!==0) throw new Error('Bitunix API error');
  return j.data;
}

async function fourHourChange(symbol){
  try{
    const now=Date.now();
    const q=new URLSearchParams({symbol,interval:'4h',startTime:String(now-12*3600000),endTime:String(now),limit:'4',type:'LAST_PRICE'});
    const rows=await bitunix('/api/v1/futures/market/kline?'+q);
    const a=(rows||[]).slice().sort((x,y)=>Number(x.time)-Number(y.time));
    if(a.length<2)return null;
    const first=n(a[Math.max(0,a.length-2)].open),last=n(a.at(-1).close);
    return first&&last!=null?((last-first)/first)*100:null;
  }catch{return null}
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  try{
    const minCap=Math.max(10_000_000,Number(req.query.minCap)||100_000_000);
    const minPump=Math.max(-100,Number(req.query.minPump)||5);
    const maxResults=Math.min(50,Math.max(5,Number(req.query.limit)||25));

    const [tickers,funding,coins]=await Promise.all([
      bitunix('/api/v1/futures/market/tickers'),
      bitunix('/api/v1/futures/market/funding_rate/batch'),
      getJson(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h`)
    ]);

    const tickerMap=new Map((tickers||[]).filter(x=>x.symbol?.endsWith('USDT')).map(x=>[x.symbol,x]));
    const fundingMap=new Map((funding||[]).map(x=>[x.symbol,x]));

    const matched=[];
    for(const c of (Array.isArray(coins)?coins:[])){
      const cap=n(c.market_cap);
      if(cap==null||cap<minCap) continue;
      const base=String(c.symbol||'').toUpperCase();
      const symbol=base+'USDT';
      const t=tickerMap.get(symbol);
      if(!t) continue;
      const open=n(t.open),last=n(t.lastPrice??t.last),high=n(t.high);
      const change24h=open&&last!=null?((last-open)/open)*100:null;
      if(change24h==null||change24h<minPump) continue;
      const f=fundingMap.get(symbol)||null;
      const fundingRate=f?n(f.fundingRate):null;
      const fundingIntervalHours=f?n(f.fundingInterval):null;
      const risk=getFundingRisk(fundingRate,fundingIntervalHours);
      matched.push({
        symbol,name:c.name,marketCap:cap,marketCapRank:n(c.market_cap_rank),
        lastPrice:last,change24hPct:change24h,quoteVol24h:n(t.quoteVol),
        high24h:high,distanceFrom24hHighPct:high&&last!=null?((last-high)/high)*100:null,
        fundingRate,fundingIntervalHours,fundingRisk:risk.label,fundingRiskLevel:risk.level
      });
    }

    matched.sort((a,b)=>b.change24hPct-a.change24hPct);
    const selected=matched.slice(0,maxResults);
    const enriched=await Promise.all(selected.map(async x=>({...x,change4hPct:await fourHourChange(x.symbol)})));

    res.status(200).json({ok:true,generatedAt:new Date().toISOString(),source:'CoinGecko market cap + Bitunix Futures market data',minCap,minPump,count:enriched.length,items:enriched});
  }catch(e){res.status(502).json({ok:false,error:String(e?.message||e)})}
}
