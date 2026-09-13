const BASE='https://fapi.bitunix.com';
export default async function handler(req,res){
  res.setHeader('Cache-Control','public,max-age=30');
  try{
    const r=await fetch(BASE+'/api/v1/futures/market/tickers',{headers:{accept:'application/json','user-agent':'bitunix-pro-panel-v2/1.0'},cache:'no-store'});
    const j=await r.json();
    if(!r.ok||Number(j.code)!==0)throw new Error('ticker error');
    const symbols=(j.data||[]).filter(x=>x.symbol?.endsWith('USDT')).map(x=>{const o=Number(x.open),l=Number(x.lastPrice??x.last);return {symbol:x.symbol,lastPrice:l,change24hPct:o?((l-o)/o)*100:null};}).sort((a,b)=>a.symbol.localeCompare(b.symbol));
    res.status(200).json({ok:true,symbols});
  }catch(e){res.status(502).json({ok:false,error:String(e.message||e)})}
}
