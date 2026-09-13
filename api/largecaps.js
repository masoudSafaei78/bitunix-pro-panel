import { getFundingRisk } from '../lib/fundingRisk.mjs';

const BITUNIX='https://fapi.bitunix.com';
const COINGECKO='https://api.coingecko.com/api/v3';
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};

// Best-effort warm-instance cache. CoinGecko market-cap data does not need to be
// fetched on every page refresh. Stale data is preferable to a 429 failure.
const CG_TTL=10*60*1000;
const CG_STALE_TTL=60*60*1000;
let cgCache={at:0,data:null};
let cgInFlight=null;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url,{source='upstream',headers={},retries=0}={}){
  let lastError;
  for(let attempt=0;attempt<=retries;attempt++){
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'bitunix-pro-panel/1.0',...headers},cache:'no-store'});
    const text=await r.text();
    let j=null;
    try{j=JSON.parse(text)}catch{}
    if(r.ok){
      if(j==null) throw new Error(`${source}: invalid JSON`);
      return j;
    }
    lastError=new Error(`${source} ${r.status}`);
    if(r.status!==429 || attempt>=retries) throw lastError;
    const retryAfter=Number(r.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter*1000,5000):1200*(attempt+1));
  }
  throw lastError||new Error(`${source} failed`);
}

async function bitunix(path){
  const j=await getJson(BITUNIX+path,{source:'Bitunix',retries:1});
  if(Number(j?.code)!==0) throw new Error('Bitunix API error');
  return j.data;
}

async function getCoinGeckoMarkets(){
  const now=Date.now();
  if(cgCache.data && now-cgCache.at<CG_TTL) return {data:cgCache.data,cache:'fresh'};
  if(cgInFlight) return cgInFlight;

  cgInFlight=(async()=>{
    try{
      const data=await getJson(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h`,{source:'CoinGecko',retries:1});
      if(!Array.isArray(data)) throw new Error('CoinGecko: unexpected response');
      cgCache={at:Date.now(),data};
      return {data,cache:'refreshed'};
    }catch(e){
      // If the provider rate-limits us, keep serving the last successful snapshot
      // for up to one hour instead of breaking the page.
      if(cgCache.data && now-cgCache.at<CG_STALE_TTL) return {data:cgCache.data,cache:'stale'};
      throw e;
    }finally{
      cgInFlight=null;
    }
  })();
  return cgInFlight;
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

async function mapWithConcurrency(items,limit,fn){
  const out=new Array(items.length);
  let cursor=0;
  async function worker(){
    while(true){
      const i=cursor++;
      if(i>=items.length) return;
      out[i]=await fn(items[i],i);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

export default async function handler(req,res){
  // CDN cache also prevents every browser refresh from invoking this function.
  res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=600');
  try{
    const minCap=Math.max(10_000_000,Number(req.query.minCap)||100_000_000);
    const minPump=Math.max(-100,Number(req.query.minPump)||5);
    const maxResults=Math.min(50,Math.max(5,Number(req.query.limit)||25));

    const [tickers,funding,cg]=await Promise.all([
      bitunix('/api/v1/futures/market/tickers'),
      bitunix('/api/v1/futures/market/funding_rate/batch'),
      getCoinGeckoMarkets()
    ]);
    const coins=cg.data;

    const tickerMap=new Map((tickers||[]).filter(x=>x.symbol?.endsWith('USDT')).map(x=>[x.symbol,x]));
    const fundingMap=new Map((funding||[]).map(x=>[x.symbol,x]));

    const matched=[];
    for(const c of coins){
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
    // Avoid a burst of many simultaneous Bitunix kline requests.
    const enriched=await mapWithConcurrency(selected,4,async x=>({...x,change4hPct:await fourHourChange(x.symbol)}));

    res.status(200).json({ok:true,generatedAt:new Date().toISOString(),source:'CoinGecko market cap + Bitunix Futures market data',marketCapCache:cg.cache,minCap,minPump,count:enriched.length,items:enriched});
  }catch(e){
    const message=String(e?.message||e);
    const status=message.includes('429')?429:502;
    res.status(status).json({ok:false,error:message});
  }
}
