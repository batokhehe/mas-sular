const fs=require('fs');
const s=fs.readFileSync('backend/src/modules/orders/orders.controller.ts','utf8');
const idx=s.indexOf('voucher');
if(idx>=0){
  const start=Math.max(0,idx-120);
  const end=Math.min(s.length,idx+250);
  console.log(s.slice(start,end));
}
