const { test } = require('node:test');
const assert = require('node:assert/strict');
const { epubPathFromArgs } = require('../src/open-file');

test('EPUB file association arguments pick the last EPUB path and ignore app flags', () => {
  assert.equal(epubPathFromArgs(['electron.exe', 'app.asar', '--enable-logging', 'C:\\Books\\安娜.epub']), 'C:\\Books\\安娜.epub');
  assert.equal(epubPathFromArgs(['readingtext.exe', '"C:\\Books\\sample.EPUB"']), 'C:\\Books\\sample.EPUB');
  assert.equal(epubPathFromArgs(['readingtext.exe', '--some.epub-flag']), null);
  assert.equal(epubPathFromArgs(['readingtext.exe', 'book.pdf']), null);
});

test('Windows package declares EPUB association', () => {
  const packageJson = require('../package.json');
  assert.equal(packageJson.build.fileAssociations[0].ext, 'epub');
  assert.equal(packageJson.build.fileAssociations[0].mimeType, 'application/epub+zip');
});
