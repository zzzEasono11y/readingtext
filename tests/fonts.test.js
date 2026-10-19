const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fonts = require('../assets/fonts/manifest.json');

test('Bundled fonts match the pinned official files and include their OFL licenses', async () => {
  assert.equal(fonts.length, 3);
  const directory = path.join(__dirname, '../assets/fonts');
  for (const font of fonts) {
    const bytes = await fs.readFile(path.join(directory, font.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), font.sha256, font.file);
    assert.ok(font.file.endsWith('.otf') ? bytes.subarray(0, 4).toString() === 'OTTO' : bytes.readUInt32BE(0) === 0x10000, font.file);
    const license = await fs.readFile(path.join(directory, font.license), 'utf8');
    assert.match(license, /Copyright/i);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/i);
  }
});
