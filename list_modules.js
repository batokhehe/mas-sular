const fs=require('fs');
const dirs=fs.readdirSync('backend/src/modules');
console.log(dirs.join('\n'));
