const fs = require('node:fs/promises');
const path = require('node:path');
const { makeEpub } = require('../tests/fixtures');
(async () => {
  const directory = path.join(__dirname, '../assets');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'demo.epub'), await makeEpub({ cover: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
