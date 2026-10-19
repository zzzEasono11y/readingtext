const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { Library } = require('../src/library');
const { exportBackup, readBackup, previewBackup, restoreBackup } = require('../src/backup');
const { makeEpub } = require('./fixtures');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readingtext-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = new Library(path.join(root, 'source')); const target = new Library(path.join(root, 'target'));
  await source.init(); await target.init();
  const file = path.join(root, 'book.epub'); await fs.writeFile(file, await makeEpub({ cover: true }));
  const category = await source.saveCategory(null, '文学');
  const book = (await source.importFile(file, category.id)).book;
  await source.saveAnnotation(book.id, { chapter: 0, start: 1, end: 5, quote: '原文摘录', note: '备份笔记', color: 'blue' });
  await source.saveVoiceSettings({ rate: .85, prewarm: true, speaker: 'Uncle_Fu' });
  await source.addBookmark(book.id, { progress: book.progress, excerpt: '书签摘要' });
  await source.saveSettings({ ...source.snapshot().settings, background: 'blue', tint: .8 });
  const backupFile = path.join(root, 'backup.readingtext'); await exportBackup(source, backupFile);
  return { root, source, target, file, book, backupFile };
}

test('Backup round trip preserves books, categories, bookmarks, notes and settings without voice files', async t => {
  const { source, target, backupFile, book } = await setup(t);
  const backup = await readBackup(backupFile);
  assert.deepEqual(previewBackup(target, backup), { books: 1, newBooks: 1, bookmarks: 1, annotations: 1 });
  await restoreBackup(target, backup);
  assert.equal(target.book(book.id).annotations[0].note, '备份笔记'); assert.equal(target.book(book.id).bookmarks.length, 1);
  assert.equal(target.book(book.id).annotations[0].color, 'blue'); assert.equal(target.snapshot().voiceSettings.speaker, 'Uncle_Fu');
  assert.equal(target.snapshot().settings.background, 'blue'); assert.equal(target.snapshot().categories[0].name, '文学');
  assert.equal(target.book(book.id).cover, source.book(book.id).cover);
  assert.equal((await target.open(book.id)).chapters.length, book.chapterCount);
  assert.deepEqual(await fs.readFile(path.join(target.directory, 'books', `${book.id}.epub`)), await fs.readFile(path.join(source.directory, 'books', `${book.id}.epub`)));
  const zip = await JSZip.loadAsync(await fs.readFile(backupFile));
  assert.ok(Object.keys(zip.files).every(name => name === 'backup.json' || name.startsWith('books/')));
  const fresh = new Library(target.directory); await fresh.init(); assert.equal(fresh.book(book.id).annotations.length, 1);
});

test('Merging the same quote and note keeps its current color and voice; legacy backups default safely', async t => {
  const { target, backupFile, book, file, root } = await setup(t); await target.importFile(file);
  await target.saveAnnotation(book.id, { chapter: 0, start: 1, end: 5, quote: '原文摘录', note: '备份笔记', color: 'purple' });
  await target.saveVoiceSettings({ rate: .8, prewarm: false, speaker: 'Vivian' });
  await restoreBackup(target, await readBackup(backupFile));
  assert.equal(target.book(book.id).annotations.length, 1); assert.equal(target.book(book.id).annotations[0].color, 'purple');
  assert.equal(target.snapshot().voiceSettings.speaker, 'Vivian');
  const zip = await JSZip.loadAsync(await fs.readFile(backupFile)); const meta = JSON.parse(await zip.file('backup.json').async('string'));
  delete meta.library.voiceSettings.speaker; delete meta.library.books[0].annotations[0].color;
  zip.file('backup.json', JSON.stringify(meta)); const legacyFile = path.join(root, 'legacy.readingtext'); await fs.writeFile(legacyFile, await zip.generateAsync({ type: 'nodebuffer' }));
  const legacy = await readBackup(legacyFile); assert.equal(legacy.state.voiceSettings.speaker, 'Serena'); assert.equal(legacy.state.books[0].annotations[0].color, 'yellow');
});

test('Merge keeps current progress and categories, preserves conflicting notes and is idempotent', async t => {
  const { target, backupFile, book, file } = await setup(t); const backup = await readBackup(backupFile);
  const category = await target.saveCategory(null, '当前分类'); await target.importFile(file, category.id);
  const progress = { chapter: 1, ratio: .3, block: 20, offset: .2 }; await target.saveProgress(book.id, progress);
  await target.saveAnnotation(book.id, { chapter: 0, start: 1, end: 5, quote: '原文摘录', note: '当前笔记' });
  await restoreBackup(target, backup); await restoreBackup(target, backup);
  assert.equal(target.snapshot().books.length, 1); assert.deepEqual(target.book(book.id).progress, progress);
  assert.equal(target.book(book.id).categoryId, category.id); assert.equal(target.snapshot().settings.background, 'white');
  assert.deepEqual(target.book(book.id).annotations.map(item => item.note).sort(), ['备份笔记', '当前笔记']);
  assert.equal(target.book(book.id).bookmarks.length, 1);
});

test('Failed restore leaves existing metadata intact and can retry; export cannot overwrite managed data', async t => {
  const { target, source, backupFile } = await setup(t); const backup = await readBackup(backupFile);
  const before = target.snapshot(); const temp = path.join(target.directory, 'library.json.tmp'); await fs.mkdir(temp);
  try { await assert.rejects(restoreBackup(target, backup)); } finally { await fs.rmdir(temp); }
  assert.deepEqual(target.snapshot(), before); await restoreBackup(target, backup); assert.equal(target.snapshot().books.length, 1);
  await assert.rejects(exportBackup(source, path.join(source.directory, 'library.json')), /文件夹之外/);
  await exportBackup(source, backupFile); assert.equal((await readBackup(backupFile)).state.books.length, 1);
});

test('Corrupt, missing, traversal, oversized and unsupported backup entries are rejected before restore', async t => {
  const { root, target, backupFile, book } = await setup(t); const original = await fs.readFile(backupFile);
  const bad = path.join(root, 'bad.readingtext'); const before = target.snapshot();
  const cases = [
    async zip => zip.file(`books/${book.id}.epub`, 'tampered'),
    async zip => zip.remove(`books/${book.id}.epub`),
    async zip => zip.file('../escape.txt', 'bad'),
    async zip => { const meta = JSON.parse(await zip.file('backup.json').async('string')); meta.version = 9; zip.file('backup.json', JSON.stringify(meta)); },
    async zip => { const meta = JSON.parse(await zip.file('backup.json').async('string')); meta.library.books[0].annotations[0].end = -1; zip.file('backup.json', JSON.stringify(meta)); },
    async zip => { const meta = JSON.parse(await zip.file('backup.json').async('string')); meta.library.books[0].lastReadAt = {}; zip.file('backup.json', JSON.stringify(meta)); }
  ];
  for (const mutate of cases) {
    const zip = await JSZip.loadAsync(original); await mutate(zip); await fs.writeFile(bad, await zip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(readBackup(bad), /原有书架未改动/); assert.deepEqual(target.snapshot(), before);
  }
  const zip = new JSZip(); zip.file('backup.json', '{}'); const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bytes.writeUInt32LE(600 * 1024 * 1024, central + 24);
  await fs.writeFile(bad, bytes); await assert.rejects(readBackup(bad), /原有书架未改动/);
  const bomb = new JSZip(); bomb.file('backup.json', ' '.repeat(17 * 1024 * 1024));
  const compressed = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const header = compressed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); compressed.writeUInt32LE(100, header + 24);
  await fs.writeFile(bad, compressed); await assert.rejects(readBackup(bad), /原有书架未改动/);
  const checksum = Buffer.from(original); const record = checksum.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  checksum.writeUInt32LE((checksum.readUInt32LE(record + 16) ^ 1) >>> 0, record + 16);
  await fs.writeFile(bad, checksum); await assert.rejects(readBackup(bad), /原有书架未改动/);
});

test('Export failure preserves an existing backup instead of replacing it with incomplete data', async t => {
  const { source, backupFile, book } = await setup(t); const before = await fs.readFile(backupFile);
  await fs.writeFile(path.join(source.directory, 'books', `${book.id}.epub`), 'damaged');
  await assert.rejects(exportBackup(source, backupFile), /校验失败/);
  assert.deepEqual(await fs.readFile(backupFile), before);
});
