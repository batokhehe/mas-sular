const fs=require('fs');
const dir='backend/src/modules/orders';
try{
  const files=fs.readdirSync(dir);
  files.forEach(f=>{console.log(f);});
}catch(e){console.log('err');}
