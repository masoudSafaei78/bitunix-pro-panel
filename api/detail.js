const BASE='https://fapi.bitunix.com';
async function J(path){const r=await fetch(BASE+path,{headers:{accept:'application/json','user-agent':'bitunix-pro-panel-v2/1.0'},cache:'no-store'});const j=await r.json();if(!r.ok||Number(j.code)!==0)throw new Error('Bitunix API error');return j.data}
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
async function has30(s){const now=Date.now(),d=Math.floor(now/86400000)*86400000,q=new URLSearchParams({symbol:s,interval:'1d',startTime:String(d-31*86400000),endTime:String(now),limit:'31',type:'LAST_PRICE'});const k=await J('/api/v1/futures/market/kline?'+q);return(k||[]).filter(x=>Number(x.time)<d).length>=30}
async function ath(s){const DAY=86400000;let end=Date.now(),a=null,at=null,prev=null;for(let p=0;p<20;p++){const q=new URLSearchParams({symbol:s,interval:'1d',startTime:String(Math.max(0,end-205*DAY)),endTime:String(end),limit:'200',type:'LAST_PRICE'});const k=await J('/api/v1/futures/market/kline?'+q),rows=(k||[]).slice().sort((x,y)=>Number(x.time)-Number(y.time));if(!rows.length)break;for(const z of rows){const h=n(z.high);if(h!==null&&(a===null||h>a)){a=h;at=Number(z.time)}}const oldest=Number(rows[0].time);if(!Number.isFinite(oldest)||oldest===prev)break;prev=oldest;if(rows.length<200)break;end=oldest-1;}return{ath:a,athTime:at}}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  try{
    const s=String(req.query.symbol||'').toUpperCase(); if(!s.endsWith('USDT'))return res.status(400).json({ok:false,error:'invalid symbol'});
    const[tickers,funding,eligible,a]=await Promise.all([J('/api/v1/futures/market/tickers'),J('/api/v1/futures/market/funding_rate/batch'),has30(s),ath(s)]);
    const x=(tickers||[]).find(z=>z.symbol===s);if(!x)return res.status(404).json({ok:false,error:'symbol not found'});
    const f=(funding||[]).find(z=>z.symbol===s),open=n(x.open),last=n(x.lastPrice??x.last);
    res.status(200).json({ok:true,symbol:s,eligible30d:eligible,lastPrice:last,change24hPct:open&&last!==null?((last-open)/open)*100:null,quoteVol24h:n(x.quoteVol),high24h:n(x.high),low24h:n(x.low),fundingRate:f?n(f.fundingRate):null,fundingIntervalHours:f?n(f.fundingInterval):null,nextFundingTime:f?n(f.nextFundingTime):null,athBitunixFutures:a.ath,athBitunixFuturesTime:a.athTime,distanceFromAthPct:(a.ath&&last!==null)?((last-a.ath)/a.ath)*100:null});
  }catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
}
