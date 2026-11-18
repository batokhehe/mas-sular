const fs=require('fs');
const files=[
  'frontend/app/orders/page.tsx',
  'admin/app/orders/[id]/page.tsx',
  'backend/src/modules/orders/domain/customer-order-view.ts',
  'frontend/lib/types/models.ts',
  'admin/lib/admin.ts',
];
for(const f of files){
  try{
    const s=fs.readFileSync(f,'utf8');
    console.log('===',f,'===');
    if(f.includes('page.tsx')){
      // look for discount lines
      const lines=s.split('\n');
      for(let i=0;i<lines.length;i++){
        if(lines[i].match(/discount|voucher/i)){
          console.log((i+1)+': '+lines[i]);
        }
      }
    }else if(f.includes('customer-order-view')){
      console.log(s);
    }else if(f.includes('models.ts')){
      // look for Order type
      const idx=s.indexOf('export interface Order');
      if(idx>=0){
        const end=s.indexOf('\nexport ', idx+1);
        console.log(s.slice(idx, end>=0?end:s.length));
      }else{
        console.log('no Order interface found');
      }
    }else{
      // admin lib
      const lines=s.split('\n');
      for(let i=0;i<lines.length;i++){
        if(lines[i].match(/voucherDiscountAmount|Order/)){
          console.log((i+1)+': '+lines[i]);
        }
      }
    }
    console.log();
  }catch(e){console.log('ERR',f,e.message);console.log();}
}
