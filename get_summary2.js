const fs=require('fs');
const s=fs.readFileSync('backend/src/modules/orders/orders.service.ts','utf8');
const idx=s.indexOf('async computeSummary');
if(idx>=0){
  const end=s.indexOf('\n  private async persistOrderWithRetry', idx);
  if(end>idx){
    console.log(s.slice(idx, Math.min(end, idx+2500)));
  }
}
