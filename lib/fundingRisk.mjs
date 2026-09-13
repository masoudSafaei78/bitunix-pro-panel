export function getFundingRisk(fundingRate, fundingIntervalHours) {
  const rate = Number(fundingRate);
  const interval = Number(fundingIntervalHours);
  if (fundingRate === null || fundingRate === undefined || fundingRate === '' || fundingIntervalHours === null || fundingIntervalHours === undefined || fundingIntervalHours === '' || !Number.isFinite(rate) || !Number.isFinite(interval)) {
    return {level:'unknown',label:'داده معتبر در دسترس نیست',candidateDefaultAllowed:false,candidateNote:'داده Funding کامل نیست؛ قبل از معامله دستی بررسی شود.'};
  }
  const severe=Math.abs(rate)>=0.5;
  const frequent=interval<4;
  if(severe&&frequent)return{level:'extreme',label:'⛔ ریسک بسیار بالا — فاندینگ شدید و پرتکرار / ترجیحاً معامله نشود',candidateDefaultAllowed:false,candidateNote:'ریسک Funding بسیار بالاست؛ برای معامله ترجیحاً کنار گذاشته شود.'};
  if(severe)return{level:'very-high',label:'⚠️ خطر خیلی بالا — فاندینگ شدید',candidateDefaultAllowed:true,candidateNote:null};
  if(frequent)return{level:'high',label:'⚠️ خطر بالا — فاندینگ پرتکرار',candidateDefaultAllowed:true,candidateNote:null};
  return{level:'normal',label:'عادی',candidateDefaultAllowed:true,candidateNote:null};
}
