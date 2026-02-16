const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

const userHtml = fs.readFileSync(path.join(__dirname, 'src', 'user.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(__dirname, 'src', 'admin.html'), 'utf8');
const workerSrc = fs.readFileSync(path.join(__dirname, 'src', 'worker.js'), 'utf8');

function escapeForJs(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
}

let output = workerSrc
  .replace('"__USER_HTML__"', '"' + escapeForJs(userHtml) + '"')
  .replace('"__ADMIN_HTML__"', '"' + escapeForJs(adminHtml) + '"');

fs.writeFileSync(path.join(distDir, 'worker.js'), output);
console.log('Built dist/worker.js (' + Math.round(output.length / 1024) + ' KB)');
