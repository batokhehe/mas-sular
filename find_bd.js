const fs=require('fs');
const s=fs.readFileSync('backend/src/modules/orders/orders.service.ts','utf8');
const idx=s.indexOf('calculateVoucherDiscountBreakdown');
console.log(idx);
if(idx>=0){
  const start=Math.max(0,idx-300);
  const end=Math.min(s.length,idx+400);
  console.log(s.slice(start,end));
}
