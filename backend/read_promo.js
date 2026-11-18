const fs=require('fs');
const s=fs.readFileSync('prisma/schema.prisma','utf8');
const i=s.indexOf('model Promo');
if(i>=0){
  const j=s.indexOf('\nmodel ', i+1);
  console.log(s.slice(i, j==-1?i+1500:j));
}
