const fs=require('fs');
const s=fs.readFileSync('frontend/lib/types/models.ts','utf8');
const re=/^export (interface|type) ([A-Za-z0-9_]+)/gm;
let m;
while((m=re.exec(s))!==null){
  if(m[2].includes('Order')) console.log(m[2]);
}
