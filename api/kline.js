const BASE='https://fapi.bitunix.com';
const allowed=new Set(['1m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']);
const ms={'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'8h':28800000,'12h':43200000,'1d':86400000,'3d':259200000,'1w':604800000};
const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  try{
    const symbol=String(req.query.symbol||'').toUpperCase();
    const interval=String(req.query.interval||'1h');
    const requested=Math.min(Math.max(Number(req.query.limit)||120,30),197);
    if(!symbol.endsWith('USDT')||!allowed.has(interval)) return res.status(400).json({ok:false,error:'invalid args'});
    const now=Date.now();
    let startTime;
    if(interval==='1M'){const d=new Date(now);d.setUTCMonth(d.getUTCMonth()-(requested+3));startTime=d.getTime();}else startTime=Math.max(0,now-(requested+3)*ms[interval]);
    const q=new URLSearchParams({symbol,interval,startTime:String(startTime),endTime:String(now),limit:String(Math.min(requested+3,200)),type:'LAST_PRICE'});
    const r=await fetch(BASE+'/api/v1/futures/market/kline?'+q.toString(),{headers:{accept:'application/json','user-agent':'bitunix-pro-panel-v2/2.0'},cache:'no-store'});
    const text=await r.text();let j;try{j=JSON.parse(text)}catch{throw new Error('Bitunix kline returned invalid JSON')}
    if(!r.ok||Number(j?.code)!==0) throw new Error('Bitunix kline error: '+(j?.msg||j?.message||j?.code||r.status));
    const rows=(Array.isArray(j.data)?j.data:[]).slice().sort((a,b)=>Number(a.time)-Number(b.time)).slice(-requested);
    const candles=rows.map((x,idx)=>{const quoteVolume=n(x.quoteVol ?? x.quoteVolume ?? x.turnover ?? x.amount ?? x.quote_volume);const baseVolume=n(x.baseVol ?? x.baseVolume ?? x.volume ?? x.base_volume);const volume=quoteVolume ?? baseVolume;return {time:Number(x.time),open:n(x.open),high:n(x.high),low:n(x.low),close:n(x.close),volume,quoteVolume,baseVolume,volumeSource:quoteVolume!=null?'quote':baseVolume!=null?'base':'missing',isClosed:idx<rows.length-1};});
    if(candles.length){const last=candles.at(-1);if(interval==='1M'){const d=new Date(last.time);last.isClosed=now>=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);}else last.isClosed=now>=last.time+ms[interval];}
    const validVolumeCount=candles.filter(x=>Number.isFinite(Number(x.volume))&&Number(x.volume)>=0).length;
    res.status(200).json({ok:true,symbol,interval,generatedAt:new Date(now).toISOString(),volumeDiagnostics:{candles:candles.length,validVolumeCount,sources:[...new Set(candles.map(x=>x.volumeSource))]},candles});
  }catch(e){res.status(502).json({ok:false,error:String(e?.message||e)})}
}
