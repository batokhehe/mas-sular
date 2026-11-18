const fs = require('fs');
const path = require('path');
function search(dir, pattern) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const e of entries) {
      const full = path.join(dir, e);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          if (full.includes('node_modules') || full.includes('.git')) continue;
          results.push(...search(full, pattern));
        } else if (full.match(/\.(ts|js|tsx|jsx)$/)) {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes(pattern)) {
            results.push(full);
          }
        }
      } catch (ex) {}
    }
  } catch (ex) {}
  return results;
}
const res = search('.', 'previewVoucher');
res.forEach(r => console.log(r));
