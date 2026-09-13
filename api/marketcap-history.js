const COINGECKO='https://api.coingecko.com/api/v3';
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url,{retries=1}={}){
  let lastError;
  for(let attempt=0;attempt<=retries;attempt++){
    const r=await fetch(url,{headers:{accept:'application/json','user-agent':'bitunix-pro-panel/1.0'},cache:'no-store'});
    const text=await r.text();
    let j=null;
    try{j=JSON.parse(text)}catch{}
    if(r.ok){
      if(j==null) throw new Error('CoinGecko invalid JSON');
      return j;
    }
    lastError=new Error(`CoinGecko ${r.status}`);
    if(r.status!==429||attempt>=retries) throw lastError;
    const retryAfter=Number(r.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter*1000,4000):1200*(attempt+1));
  }
  throw lastError||new Error('CoinGecko failed');
}

function summarize(points,currentCap){
  const vals=(Array.isArray(points)?points:[])
    .map(p=>Array.isArray(p)?n(p[1]):null)
    .filter(v=>v!=null&&v>0);
  if(!vals.length) return {marketCap30dAvg:null,marketCap7dAvg:null,marketCapVs30dAvgPct:null,marketCap7dVs30dPct:null,marketCapSpikeLevel:'unknown'};
  const avg30=avg(vals.slice(-30));
  const avg7=avg(vals.slice(-7));
  const vs30=avg30&&currentCap!=null?((currentCap-avg30)/avg30)*100:null;
  const avg7vs30=avg30&&avg7!=null?((avg7-avg30)/avg30)*100:null;
  const level=vs30==null?'unknown':vs30>=40?'spike':vs30>=20?'elevated':vs30<=-20?'depressed':'normal';
  return {marketCap30dAvg:avg30,marketCap7dAvg:avg7,marketCapVs30dAvgPct:vs30,marketCap7dVs30dPct:avg7vs30,marketCapSpikeLevel:level};
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','public, s-maxage=21600, stale-while-revalidate=86400');
  try{
    const coinId=String(req.query.coinId||'').trim();
    const currentCap=n(req.query.currentCap);
    if(!coinId) return res.status(400).json({ok:false,error:'coinId required'});
    const url=`${COINGECKO}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=30&interval=daily`;
    const data=await getJson(url,{retries:1});
    const points=Array.isArray(data?.market_caps)?data.market_caps:[];
    if(!points.length) throw new Error('No market-cap history');
    res.status(200).json({ok:true,...summarize(points,currentCap)});
  }catch(e){
    const message=String(e?.message||e);
    res.status(message.includes('429')?429:502).json({ok:false,error:message});
  }
}
