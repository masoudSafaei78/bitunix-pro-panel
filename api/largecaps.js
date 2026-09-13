import { getFundingRisk } from '../lib/fundingRisk.mjs';

const BITUNIX='https://fapi.bitunix.com';
const COINGECKO='https://api.coingecko.com/api/v3';
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;

// Current market snapshot cache.
const CG_TTL=10*60*1000;
const CG_STALE_TTL=60*60*1000;
let cgCache={at:0,data:null};
let cgInFlight=null;

// Historical market-cap data changes slowly enough that a 6h cache is fine.
// On provider trouble we can keep a successful snapshot for up to 24h.
const HISTORY_TTL=6*60*60*1000;
const HISTORY_STALE_TTL=24*60*60*1000;
const historyCache=new Map();
const historyInFlight=new Map();

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
    await sleep(Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter*1000,5000):1400*(attempt+1));
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
      if(cgCache.data && now-cgCache.at<CG_STALE_TTL) return {data:cgCache.data,cache:'stale'};
      throw e;
    }finally{
      cgInFlight=null;
    }
  })();
  return cgInFlight;
}

function summarizeMarketCapHistory(points,currentCap){
  const vals=(Array.isArray(points)?points:[])
    .map(p=>Array.isArray(p)?n(p[1]):null)
    .filter(v=>v!=null&&v>0);
  if(!vals.length) return {marketCap30dAvg:null,marketCap7dAvg:null,marketCapVs30dAvgPct:null,marketCap7dVs30dPct:null,marketCapSpikeLevel:'unknown'};

  const last30=vals.slice(-30);
  const last7=vals.slice(-7);
  const avg30=avg(last30);
  const avg7=avg(last7);
  const vs30=avg30&&currentCap!=null?((currentCap-avg30)/avg30)*100:null;
  const avg7vs30=avg30&&avg7!=null?((avg7-avg30)/avg30)*100:null;
  const level=vs30==null?'unknown':vs30>=40?'spike':vs30>=20?'elevated':vs30<=-20?'depressed':'normal';
  return {marketCap30dAvg:avg30,marketCap7dAvg:avg7,marketCapVs30dAvgPct:vs30,marketCap7dVs30dPct:avg7vs30,marketCapSpikeLevel:level};
}

async function getMarketCapHistory(coinId,currentCap){
  const now=Date.now();
  const cached=historyCache.get(coinId);
  if(cached?.data && now-cached.at<HISTORY_TTL) return {...summarizeMarketCapHistory(cached.data,currentCap),marketCapHistoryCache:'fresh'};
  if(historyInFlight.has(coinId)) return historyInFlight.get(coinId);

  const job=(async()=>{
    try{
      const url=`${COINGECKO}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=30&interval=daily`;
      const data=await getJson(url,{source:`CoinGecko history ${coinId}`,retries:1});
      const points=Array.isArray(data?.market_caps)?data.market_caps:[];
      if(!points.length) throw new Error('CoinGecko history: no market cap data');
      historyCache.set(coinId,{at:Date.now(),data:points});
      return {...summarizeMarketCapHistory(points,currentCap),marketCapHistoryCache:'refreshed'};
    }catch(e){
      if(cached?.data && now-cached.at<HISTORY_STALE_TTL){
        return {...summarizeMarketCapHistory(cached.data,currentCap),marketCapHistoryCache:'stale'};
      }
      // History failure must not break the entire scanner. The row remains usable.
      return {marketCap30dAvg:null,marketCap7dAvg:null,marketCapVs30dAvgPct:null,marketCap7dVs30dPct:null,marketCapSpikeLevel:'unavailable',marketCapHistoryCache:'unavailable',marketCapHistoryError:String(e?.message||e)};
    }finally{
      historyInFlight.delete(coinId);
    }
  })();

  historyInFlight.set(coinId,job);
  return job;
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
  res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=900');
  try{
    const minCap=Math.max(10_000_000,Number(req.query.minCap)||100_000_000);
    const minPump=Math.max(-100,Number(req.query.minPump)||5);
    const maxResults=Math.min(30,Math.max(5,Number(req.query.limit)||20));

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
        coinGeckoId:c.id,
        symbol,name:c.name,marketCap:cap,marketCapRank:n(c.market_cap_rank),
        lastPrice:last,change24hPct:change24h,quoteVol24h:n(t.quoteVol),
        high24h:high,distanceFrom24hHighPct:high&&last!=null?((last-high)/high)*100:null,
        fundingRate,fundingIntervalHours,fundingRisk:risk.label,fundingRiskLevel:risk.level
      });
    }

    matched.sort((a,b)=>b.change24hPct-a.change24hPct);
    const selected=matched.slice(0,maxResults);

    // Keep both providers under control: Bitunix 4h data at 4-way concurrency,
    // CoinGecko historical market-cap at only 2-way concurrency.
    const [changes4h,histories]=await Promise.all([
      mapWithConcurrency(selected,4,x=>fourHourChange(x.symbol)),
      mapWithConcurrency(selected,2,x=>getMarketCapHistory(x.coinGeckoId,x.marketCap))
    ]);

    const enriched=selected.map((x,i)=>({...x,change4hPct:changes4h[i],...histories[i]}));

    res.status(200).json({
      ok:true,
      generatedAt:new Date().toISOString(),
      source:'CoinGecko current + 30d historical market cap; Bitunix Futures price/funding/kline',
      marketCapCache:cg.cache,
      minCap,minPump,count:enriched.length,items:enriched
    });
  }catch(e){
    const message=String(e?.message||e);
    const status=message.includes('429')?429:502;
    res.status(status).json({ok:false,error:message});
  }
}
