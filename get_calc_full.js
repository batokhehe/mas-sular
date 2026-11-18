const fs=require('fs');
const s=fs.readFileSync('backend/src/modules/orders/orders.service.ts','utf8');
const idx=s.indexOf('calculateVoucherDiscountBreakdown');
if(idx>=0){
  const end=s.indexOf('\n  private calculateVoucherDiscount', idx);
  if(end>idx){
    console.log(s.slice(idx, end+50));
  } else {
    console.log(s.slice(idx, idx+1000));
  }
}
