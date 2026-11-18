const fs=require('fs');
const path=require('path');
const patterns=['voucherDiscountAmount','discount','totalPrice','subtotal','deliveryFee'];
function walk(dir){
  const entries=fs.readdirSync(dir);
  for(const e of entries){
    const full=path.join(dir,e);
    const stat=fs.statSync(full);
    if(stat.isDirectory()){
      if(full.includes('node_modules')||full.includes('.git')||full.includes('dist')||full.includes('build')||full.includes('.next')) continue;
      walk(full);
    }else{
      if(/\.(ts|tsx|js|jsx)$/.test(e)){
        try{
          const s=fs.readFileSync(full,'utf8');
          for(const p of patterns){
            if(s.includes(p)){
              console.log(full+':'+p);
              break;
            }
          }
        }catch(ex){}
      }
    }
  }
}
walk('backend/src');
walk('admin');
walk('frontend');
