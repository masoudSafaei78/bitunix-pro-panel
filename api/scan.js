import { getFundingRisk } from '../lib/fundingRisk.mjs';
const BASE='https://fapi.bitunix.com';
async function J(path){const r=await fetch(BASE+path,{headers:{accept:'application/json','user-agent':'bitunix-pro-panel-v2/1.0'},cache:'no-store'});const j=await r.json();if(!r.ok||Number(j.code)!==0)throw new Error('Bitunix API error');return j.data}
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
function boll(rows,p=20,m=2.5){const c=rows.map(x=>n(x.close)).filter(x=>x!==null);if(c.length<p)return null;const w=c.slice(-p),mid=w.reduce((s,x)=>s+x,0)/p,sd=Math.sqrt(w.reduce((s,x)=>s+(x-mid)**2,0)/p),upper=mid+m*sd,lower=mid-m*sd,last=w.at(-1),prev=c.length>p?c.at(-2):null,pctB=upper===lower?null:(last-lower)/(upper-lower),width=mid?((upper-lower)/mid)*100:null;let signal='Inside';if(last>upper)signal='Upper Break';else if(pctB!==null&&pctB>=.9)signal='Stretched';if(prev!==null&&prev>upper&&last<=upper)signal='Bearish Re-entry';return{upper,mid,lower,pctB,widthPct:width,signal}}
async function klines(s,interval,limit=25){const now=Date.now(),unit=interval==='1h'?3600000:14400000,q=new URLSearchParams({symbol:s,interval,startTime:String(now-unit*(limit+3)),endTime:String(now),limit:String(limit+3),type:'LAST_PRICE'});const k=await J('/api/v1/futures/market/kline?'+q);return(k||[]).sort((a,b)=>Number(a.time)-Number(b.time)).filter(x=>Number(x.time)<Math.floor(now/unit)*unit)}
async function has30(s){const now=Date.now(),d=Math.floor(now/86400000)*86400000,q=new URLSearchParams({symbol:s,interval:'1d',startTime:String(d-31*86400000),endTime:String(now),limit:'31',type:'LAST_PRICE'});const k=await J('/api/v1/futures/market/kline?'+q);return(k||[]).filter(x=>Number(x.time)<d).length>=30}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
  const[tickers,funding]=await Promise.all([J('/api/v1/futures/market/tickers'),J('/api/v1/futures/market/funding_rate/batch')]);
  const fm=new Map((funding||[]).map(x=>[x.symbol,x]));
  const ranked=(tickers||[]).filter(x=>x.symbol?.endsWith('USDT')).map(x=>{const o=n(x.open),l=n(x.lastPrice??x.last);return{raw:x,symbol:x.symbol,last:l,change24hPct:o&&l!==null?((l-o)/o)*100:null}}).filter(x=>x.change24hPct!==null).sort((a,b)=>b.change24hPct-a.change24hPct);
  const elig=[];for(const x of ranked){if(elig.length>=5)break;try{if(await has30(x.symbol))elig.push(x)}catch{}}
  const top5=await Promise.all(elig.map(async x=>{const f=fm.get(x.symbol)||null, fundingRate=f?n(f.fundingRate):null,fundingIntervalHours=f?n(f.fundingInterval):null,risk=getFundingRisk(fundingRate,fundingIntervalHours);let boll1h=null,boll4h=null;try{const[k1,k4]=await Promise.all([klines(x.symbol,'1h'),klines(x.symbol,'4h')]);boll1h=boll(k1);boll4h=boll(k4)}catch{}const base={symbol:x.symbol,change24hPct:x.change24hPct,lastPrice:x.last,quoteVol24h:n(x.raw.quoteVol),fundingRate,fundingIntervalHours,fundingRisk:risk.label,fundingRiskLevel:risk.level,candidateDefaultAllowed:risk.candidateDefaultAllowed,candidateNote:risk.candidateNote,boll1h,boll4h};return{...base,correction:correctionScore(base)}}));
  function correctionScore(x){
 let s=0,reasons=[];
 const addB=(b,tf)=>{if(!b)return;if(b.signal==='Bearish Re-entry'){s+=2;reasons.push(tf+' برگشت داخل باند')}else if(b.signal==='Upper Break'){s+=1.5;reasons.push(tf+' شکست باند بالا')}else if(b.signal==='Stretched'){s+=1;reasons.push(tf+' نزدیک سقف باند')}};
 addB(x.boll1h,'1H');addB(x.boll4h,'4H');
 if(x.change24hPct>=50){s+=2;reasons.push('رشد 24h بسیار شدید')}else if(x.change24hPct>=25){s+=1.5;reasons.push('رشد 24h شدید')}else if(x.change24hPct>=12){s+=1;reasons.push('رشد 24h بالا')};
 if(x.fundingRiskLevel==='extreme'){s+=2;reasons.push('فاندینگ بسیار پرریسک')}else if(x.fundingRiskLevel==='very-high'||x.fundingRiskLevel==='high'){s+=1;reasons.push('فاندینگ پرریسک')};
 return{score:Math.min(10,Math.round(s*10)/10),reasons};
}
  const candidates=top5.filter(x=>x.candidateDefaultAllowed).sort((a,b)=>(b.correction?.score||0)-(a.correction?.score||0)).slice(0,3);
  res.status(200).json({ok:true,generatedAt:new Date().toISOString(),bollinger:{period:20,stdDev:2.5,ma:'SMA',usesClosedCandles:true},top5,candidates});
 }catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
}