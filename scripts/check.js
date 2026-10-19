const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const directory of ['src', 'scripts', 'tests']) {
  for (const entry of fs.readdirSync(path.join(__dirname, '..', directory), { recursive: true })) {
    if (entry.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(__dirname, '..', directory, entry)], { stdio: 'inherit' });
  }
}
execFileSync(process.execPath, ['--check', path.join(__dirname, '../playwright.config.js')], { stdio: 'inherit' });
console.log('全部 JavaScript 文件语法检查通过。');
