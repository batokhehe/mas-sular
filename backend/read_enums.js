const fs=require('fs');
const s=fs.readFileSync('prisma/schema.prisma','utf8');
const re=/(enum\s+[A-Za-z]+\s*\{[^}]+\})/gs;
let m;
while((m=re.exec(s))){
  const t=m[1];
  if(t.includes('Voucher')||t.includes('ProductDiscount')||t.includes('ShippingDiscount')){
    console.log(t);
    console.log('===');
  }
}
