const fs=require('fs');
const s=fs.readFileSync('backend/src/modules/orders/orders.service.ts','utf8');
const idx=s.indexOf('grand_total: fee');
if(idx>=0){
  const start=Math.max(0,idx-100);
  const end=Math.min(s.length,idx+200);
  console.log(s.slice(start,end));
}
