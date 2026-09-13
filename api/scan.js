import { getFundingRisk } from '../lib/fundingRisk.mjs';
const BASE='https://fapi.bitunix.com';
async function J(path){const r=await fetch(BASE+path,{headers:{accept:'application/json','user-agent':'bitunix-pro-panel-v2/1.0'},cache:'no-store'});const j=await r.json();if(!r.ok||Number(j.code)!==0)throw new Error('Bitunix API error');return j.data}
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
async function has30(s){const now=Date.now(),d=Math.floor(now/86400000)*86400000,q=new URLSearchParams({symbol:s,interval:'1d',startTime:String(d-31*86400000),endTime:String(now),limit:'31',type:'LAST_PRICE'});const k=await J('/api/v1/futures/market/kline?'+q);return(k||[]).filter(x=>Number(x.time)<d).length>=30}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const[tickers,funding]=await Promise.all([J('/api/v1/futures/market/tickers'),J('/api/v1/futures/market/funding_rate/batch')]);
    const fm=new Map((funding||[]).map(x=>[x.symbol,x]));
    const ranked=(tickers||[]).filter(x=>x.symbol?.endsWith('USDT')).map(x=>{const o=n(x.open),l=n(x.lastPrice??x.last);return{raw:x,symbol:x.symbol,last:l,change24hPct:o&&l!==null?((l-o)/o)*100:null}}).filter(x=>x.change24hPct!==null).sort((a,b)=>b.change24hPct-a.change24hPct);
    const elig=[];for(const x of ranked){if(elig.length>=5)break;try{if(await has30(x.symbol))elig.push(x)}catch{}}
    const top5=elig.map(x=>{const f=fm.get(x.symbol)||null;const fundingRate=f?n(f.fundingRate):null;const fundingIntervalHours=f?n(f.fundingInterval):null;const risk=getFundingRisk(fundingRate,fundingIntervalHours);return {symbol:x.symbol,change24hPct:x.change24hPct,lastPrice:x.last,quoteVol24h:n(x.raw.quoteVol),fundingRate,fundingIntervalHours,fundingRisk:risk.label,fundingRiskLevel:risk.level,candidateDefaultAllowed:risk.candidateDefaultAllowed,candidateNote:risk.candidateNote};});
    const candidates=top5.filter(x=>x.candidateDefaultAllowed).slice(0,3);
    res.status(200).json({ok:true,generatedAt:new Date().toISOString(),top5,candidates});
  }catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
}
