const fs=require('fs');
const s=fs.readFileSync('backend/test/unit/orders-voucher-calculation.spec.ts','utf8');
console.log(s.split('\n').slice(0,60).join('\n'));
