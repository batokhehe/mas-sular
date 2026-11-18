const fs=require('fs');
const s=fs.readFileSync('src/modules/orders/orders.service.ts','utf8');
const lines=s.split('\n');
for(let i=949;i<1200 && i<lines.length;i++){
  console.log((i+1)+': '+lines[i]);
}
