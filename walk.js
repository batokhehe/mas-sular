const fs=require('fs');
const path=require('path');
function walk(dir){
  const entries=fs.readdirSync(dir);
  for(const e of entries){
    const full=path.join(dir,e);
    const stat=fs.statSync(full);
    if(stat.isDirectory()){
      if(full.includes('node_modules')||full.includes('.git')||full.includes('dist')||full.includes('build')) continue;
      walk(full);
    }else{
      if(/\.(ts|tsx|js|jsx)$/.test(e)){
        try{
          const s=fs.readFileSync(full,'utf8');
          if(s.includes('voucherDiscountAmount')){
            console.log(full);
          }
        }catch(ex){}
      }
    }
  }
}
walk('.');
