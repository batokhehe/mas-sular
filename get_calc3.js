const fs=require('fs');
const s=fs.readFileSync('backend/src/modules/orders/orders.service.ts','utf8');
const idx=s.indexOf('private calculateVoucherDiscount');
if(idx>=0){
  let end=s.indexOf('\n  }\n', idx);
  if(end<0) end=idx+250;
  console.log(s.slice(idx, end+5));
}
