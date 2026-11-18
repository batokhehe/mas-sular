const fs=require('fs');
const s=fs.readFileSync('backend/src/modules/invoices/invoice-view.ts','utf8');
const lines=s.split('\n');
for(let i=0;i<lines.length;i++){
  if(lines[i].includes('voucherDiscountAmount')){
    console.log((i+1)+': '+lines[i]);
  }
}
