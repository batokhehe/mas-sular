const fs=require('fs');
const s=fs.readFileSync('frontend/lib/types/models.ts','utf8');
const idx=s.indexOf('export interface Order');
if(idx>=0){
  let end=s.indexOf('\nexport ', idx+1);
  if(end<0) end=s.length;
  console.log(s.slice(idx, end));
}
