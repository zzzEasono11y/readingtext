const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { parseEpub, resolveHref, readResource } = require('../src/epub');
const { makeEpub } = require('./fixtures');

test('EPUB 3: metadata, spine, TOC nesting and percent-encoded Chinese paths', async () => {
  const book = await parseEpub(await makeEpub());
  assert.equal(book.title, '给阅读留一点时间');
  assert.equal(book.author, '拾页');
  assert.equal(book.chapters.length, 3);
  assert.equal(book.chapters[0].path, 'OPS/chapters/第1章.xhtml');
  assert.equal(book.toc.length, 4);
  assert.equal(book.toc[1].depth, 1);
  assert.equal(book.toc[1].fragment, 'p10');
  assert.equal(book.toc[2].chapter, 1);
  assert.match(await readResource(book.zip, book.chapters[0].path), /第 1 段/);
});
test('EPUB 2 falls back to NCX; broken navigation falls back to reading order', async () => {
  for (const options of [{ epub2: true }, { brokenNav: true }, { noToc: true }]) {
    const book = await parseEpub(await makeEpub(options));
    assert.equal(book.toc.length, 3);
    assert.equal(book.toc[2].chapter, 2);
    if (!options.noToc) assert.equal(book.toc[0].label, '慢下来，翻开一页');
  }
});

test('Read the embedded cover image while preserving a cover-less fallback', async () => {
  const book = await parseEpub(await makeEpub({ cover: true }));
  assert.match(book.cover, /^data:image\/svg\+xml;base64,/);
  assert.equal((await parseEpub(await makeEpub())).cover, null);
});
test('Reject corrupt archives, missing chapters, fixed layout and DRM', async () => {
  await assert.rejects(parseEpub(Buffer.from('not a zip')), /完整的 EPUB/);
  await assert.rejects(parseEpub(await makeEpub({ missing: true })), /章节缺失/);
  await assert.rejects(parseEpub(await makeEpub({ fixed: true })), /固定版式/);
  await assert.rejects(parseEpub(await makeEpub({ drm: true })), /DRM/);
});
test('Reject entity declarations and oversized compressed resources before extraction', async () => {
  const bytes = await makeEpub();
  const zip = await JSZip.loadAsync(bytes);
  zip.file('META-INF/container.xml', '<!DOCTYPE x [<!ENTITY x "boom">]><container/>');
  await assert.rejects(parseEpub(await zip.generateAsync({ type: 'nodebuffer' })), /实体声明/);
  const book = await parseEpub(bytes);
  book.zip.file(book.chapters[0].path)._data.uncompressedSize = 40 * 1024 * 1024;
  await assert.rejects(readResource(book.zip, book.chapters[0].path), /单个文件过大/);
  const fresh = await parseEpub(bytes);
  fresh.zip.file(fresh.chapters[0].path)._data.uncompressedSize = 0;
  await assert.rejects(readResource(fresh.zip, fresh.chapters[0].path, 'string', 32), /单个文件过大/);
});
test('Resolve book-local links without allowing traversal or remote resources', () => {
  assert.deepEqual(resolveHref('OPS/chapters/ch1.xhtml', '../images/a%20b.png#%E4%B8%80'), { path: 'OPS/images/a b.png', fragment: '一' });
  assert.deepEqual(resolveHref('OPS/ch1.xhtml', '#p1'), { path: 'OPS/ch1.xhtml', fragment: 'p1' });
  for (const href of ['../../outside', 'https://example.com/a', 'file:///secret', '//server/a', '..\\secret', '%00', '%zz']) {
    assert.throws(() => resolveHref('OPS/book.opf', href));
  }
});
