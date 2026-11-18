const fs=require('fs');
const s=fs.readFileSync('prisma/schema.prisma','utf8');
const i=s.indexOf('model Order ');
if(i>=0){
  let j=s.indexOf('\nmodel ', i+1);
  if(j==-1) j=i+2000;
  console.log(s.slice(i,j));
}
