const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Library, validateProgress, validateSettings } = require('../src/library');
const { makeEpub } = require('./fixtures');

test('Listening positions migrate, persist per book separately from reading, validate and recover from write failure', async t => {
  const { directory, filename, library } = await setup(t);
  const first = (await library.importFile(filename)).book;
  const secondFile = path.join(directory, 'second.epub');
  await fs.writeFile(secondFile, await makeEpub({ title: '第二本听读测试' }));
  const second = (await library.importFile(secondFile)).book;
  const position = { chapter: 1, block: 20, part: 2 };
  await library.saveListeningPosition(first.id, position);
  const fresh = new Library(path.join(directory, 'data')); await fresh.init();
  assert.deepEqual(fresh.book(first.id).listeningPosition, position);
  assert.equal(fresh.book(second.id).listeningPosition, null);
  assert.deepEqual(fresh.book(first.id).progress, first.progress);
  for (const bad of [null, { ...position, chapter: 1000 }, { ...position, block: -1 }, { ...position, part: .2 }, { ...position, part: NaN }]) {
    await assert.rejects(fresh.saveListeningPosition(first.id, bad), /位置无效/);
  }
  const temp = path.join(directory, 'data/library.json.tmp'); await fs.mkdir(temp);
  try { await assert.rejects(fresh.saveListeningPosition(first.id, { ...position, block: 30 })); }
  finally { await fs.rmdir(temp); }
  assert.deepEqual(fresh.book(first.id).listeningPosition, position);
  await fresh.saveListeningPosition(first.id, { ...position, block: 31 });
  assert.equal(fresh.book(first.id).listeningPosition.block, 31);
});

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readingtext-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'original.epub');
  await fs.writeFile(filename, await makeEpub());
  const library = new Library(path.join(directory, 'data'));
  await library.init();
  return { directory, filename, library };
}

test('Highlight colors migrate, validate and edit without losing notes; voice selection persists', async t => {
  const { filename, library } = await setup(t); const { book } = await library.importFile(filename);
  const value = { chapter: 0, start: 1, end: 5, quote: '原文摘录', note: '保留我的想法' };
  const saved = await library.saveAnnotation(book.id, value); assert.equal(saved.color, 'yellow');
  for (const color of ['blue', 'green', 'purple']) {
    const updated = await library.saveAnnotation(book.id, { ...value, note: undefined, id: saved.id, color });
    assert.equal(updated.color, color); assert.equal(updated.note, value.note);
  }
  for (const color of ['red', '', {}, ['blue']]) await assert.rejects(library.saveAnnotation(book.id, { ...value, color }), /摘录/);
  await library.saveVoiceSettings({ rate: .8, prewarm: false, autoAdvance: true, speaker: 'Vivian' });
  let fresh = new Library(library.directory); await fresh.init();
  assert.equal(fresh.book(book.id).annotations[0].color, 'purple'); assert.equal(fresh.snapshot().voiceSettings.speaker, 'Vivian');
  for (const speaker of ['../voice.wav', 'toString', {}, ['Serena'], null]) await assert.rejects(fresh.saveVoiceSettings({ rate: 1, prewarm: true, speaker }), /朗读设置无效/);
  const file = path.join(library.directory, 'library.json'); const old = JSON.parse(await fs.readFile(file, 'utf8'));
  delete old.books[0].annotations[0].color; delete old.voiceSettings.speaker; await fs.writeFile(file, JSON.stringify(old));
  fresh = new Library(library.directory); await fresh.init();
  assert.equal(fresh.book(book.id).annotations[0].color, 'yellow'); assert.equal(fresh.snapshot().voiceSettings.speaker, 'Serena');
});

test('Voice preferences migrate old shelves, persist slider speed and recover after failed writes', async t => {
  const { directory, library } = await setup(t);
  const file = path.join(directory, 'data/library.json');
  await library.saveVoiceSettings({ rate: .65, prewarm: false, autoAdvance: false, ignored: 'extra' });
  const fresh = new Library(path.dirname(file)); await fresh.init();
  assert.deepEqual(fresh.snapshot().voiceSettings, { rate: .65, prewarm: false, autoAdvance: false, speaker: 'Serena' });
  for (const value of [null, { rate: .59, prewarm: true }, { rate: 2.01, prewarm: true }, { rate: NaN, prewarm: true }, { rate: 1, prewarm: 'yes' }, { rate: 1, prewarm: true, autoAdvance: 'yes' }]) {
    await assert.rejects(fresh.saveVoiceSettings(value), /朗读设置无效/);
  }
  await fs.mkdir(file + '.tmp');
  try { await assert.rejects(fresh.saveVoiceSettings({ rate: 2, prewarm: true })); }
  finally { await fs.rmdir(file + '.tmp'); }
  assert.deepEqual(fresh.snapshot().voiceSettings, { rate: .65, prewarm: false, autoAdvance: false, speaker: 'Serena' });
  await fresh.saveVoiceSettings({ rate: 1, prewarm: true });
  const old = JSON.parse(await fs.readFile(file, 'utf8')); delete old.voiceSettings.autoAdvance;
  await fs.writeFile(file, JSON.stringify(old));
  const migrated = new Library(path.dirname(file)); await migrated.init();
  assert.deepEqual(migrated.snapshot().voiceSettings, { rate: 1, prewarm: true, autoAdvance: true, speaker: 'Serena' });
  delete old.voiceSettings; await fs.writeFile(file, JSON.stringify(old));
  const legacy = new Library(path.dirname(file)); await legacy.init();
  assert.deepEqual(legacy.snapshot().voiceSettings, { rate: .9, prewarm: true, autoAdvance: true, speaker: 'Serena' });
});
test('Import, deduplicate, read chapters, persist settings/progress and remove only the managed copy', async t => {
  const { directory, filename, library } = await setup(t);
  const first = await library.importFile(filename);
  assert.equal(first.duplicate, false);
  assert.equal((await library.importFile(filename)).duplicate, true);
  assert.equal(library.snapshot().books.length, 1);
  const book = await library.open(first.book.id);
  assert.equal(book.toc.length, 4);
  assert.match((await library.chapter(book.id, 1)).html, /在文字里/);
  assert.equal((await library.image(book.id, 'OPS/images/leaf.svg')).mediaType, 'image/svg+xml');
  await assert.rejects(library.image(book.id, 'OPS/book.opf'), /图片不存在/);
  const progress = { chapter: 1, ratio: .45, block: 24, offset: .3 };
  const settings = { fontSize: 24, lineHeight: 2, width: 800, paragraphGap: 1.8, fontFamily: 'serif', background: 'blue', tint: .8 };
  await Promise.all([library.saveProgress(book.id, progress), library.saveSettings(settings)]);
  const fresh = new Library(path.join(directory, 'data')); await fresh.init();
  assert.deepEqual(fresh.snapshot().books[0].progress, progress);
  assert.deepEqual(fresh.snapshot().settings, settings);
  assert.ok(fresh.snapshot().books[0].lastReadAt);
  await fresh.remove(book.id);
  assert.equal(fresh.snapshot().books.length, 0);
  await assert.rejects(fs.access(path.join(directory, 'data/books', `${book.id}.epub`)));
  await fs.access(filename);
  assert.equal((await new Library(path.join(directory, 'data')).init()).books.length, 0);
});

test('Backgrounds migrate, validate and persist without changing each book font', async t => {
  const { directory, library, filename } = await setup(t); const book = (await library.importFile(filename)).book;
  const old = library.snapshot(); delete old.settings.background; delete old.settings.tint;
  await fs.writeFile(path.join(directory, 'data/library.json'), JSON.stringify(old));
  const fresh = new Library(path.join(directory, 'data')); await fresh.init();
  assert.equal(fresh.snapshot().settings.background, 'white'); assert.equal(fresh.snapshot().settings.tint, .6);
  const settings = fresh.snapshot().settings;
  for (const background of ['white', 'blue', 'gray', 'sand']) await fresh.saveSettings({ ...settings, background, tint: .7 }, book.id);
  const restarted = new Library(fresh.directory); await restarted.init(); assert.equal(restarted.snapshot().settings.background, 'sand');
  for (const value of [{ background: 'url(evil)' }, { tint: -1 }, { tint: Infinity }]) await assert.rejects(fresh.saveSettings({ ...settings, ...value }));
});

test('Annotations migrate, deduplicate, edit, persist, validate and recover after failed writes', async t => {
  const { directory, library, filename } = await setup(t); const book = (await library.importFile(filename)).book;
  const value = { chapter: 0, start: 3, end: 7, quote: '阅读测试', note: '我的想法' };
  const first = await library.saveAnnotation(book.id, value);
  assert.equal((await library.saveAnnotation(book.id, { ...value, note: undefined })).id, first.id);
  assert.equal(library.book(book.id).annotations.length, 1); assert.equal(library.book(book.id).annotations[0].note, value.note);
  const temp = path.join(directory, 'data/library.json.tmp'); await fs.mkdir(temp);
  try { await assert.rejects(library.saveAnnotation(book.id, { ...value, id: first.id, note: '写入失败' })); }
  finally { await fs.rmdir(temp); }
  assert.equal(library.book(book.id).annotations[0].note, value.note);
  await library.saveAnnotation(book.id, { ...value, id: first.id, note: '修改后的笔记' });
  const fresh = new Library(library.directory); await fresh.init(); assert.equal(fresh.book(book.id).annotations[0].note, '修改后的笔记');
  for (const invalid of [{ chapter: 999 }, { start: -1 }, { end: 100 }, { quote: '' }, { note: {} }, { note: '字'.repeat(2001) }, { id: '../data' }]) {
    await assert.rejects(library.saveAnnotation(book.id, { ...value, ...invalid }));
  }
  await fresh.removeAnnotation(book.id, first.id); assert.deepEqual(fresh.book(book.id).annotations, []);
});
test('Independent progress for different books and parallel duplicate imports', async t => {
  const { directory, filename, library } = await setup(t);
  await Promise.all([library.importFile(filename), library.importFile(filename)]);
  assert.equal(library.snapshot().books.length, 1);
  const otherFile = path.join(directory, 'other.epub');
  await fs.writeFile(otherFile, await makeEpub({ title: '另一段旅程' }));
  const other = await library.importFile(otherFile);
  const first = library.snapshot().books.find(book => book.id !== other.book.id);
  await library.saveProgress(first.id, { chapter: 2, ratio: .8, block: 48, offset: .1 });
  assert.equal(library.book(other.book.id).progress.chapter, 0);
  await assert.rejects(library.open('../secret'), /编号无效/);
  await assert.rejects(library.chapter(first.id, -1));
  await assert.rejects(library.importFile(path.join(directory, 'a.pdf')), /EPUB 格式/);
});
test('Corrupt persisted state is reported without overwriting the original data', async t => {
  const { directory } = await setup(t);
  const filename = path.join(directory, 'data/library.json');
  await fs.writeFile(filename, 'broken');
  await assert.rejects(new Library(path.join(directory, 'data')).init(), /原有数据已保留/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'broken');
});
test('Failed state writes leave in-memory progress unchanged and subsequent saves can recover', async t => {
  const { directory, filename, library } = await setup(t);
  const { book } = await library.importFile(filename);
  const temp = path.join(directory, 'data/library.json.tmp');
  await fs.mkdir(temp);
  await assert.rejects(library.saveProgress(book.id, { chapter: 1, ratio: .4, block: 4, offset: .2 }));
  assert.equal(library.book(book.id).progress.chapter, 0);
  await fs.rmdir(temp);
  await library.saveProgress(book.id, { chapter: 1, ratio: .4, block: 4, offset: .2 });
  assert.equal(library.book(book.id).progress.chapter, 1);
});
test('Validate all persisted numeric fields and reject out-of-range values', () => {
  for (const value of [null, {}, { fontSize: 100, lineHeight: 2, width: 760 }, { fontSize: 20, lineHeight: NaN, width: 760 }]) {
    assert.throws(() => validateSettings(value));
  }
  for (const value of [null, {}, { chapter: 3, ratio: 0, block: 0, offset: 0 }, { chapter: 0, ratio: 2, block: 0, offset: 0 }, { chapter: 0, ratio: 0, block: -1, offset: 0 }]) {
    assert.throws(() => validateProgress(value, 3));
  }
});

test('Bookmarks persist independently, deduplicate by paragraph, and preserve legacy shelves', async t => {
  const { directory, filename, library } = await setup(t);
  const { book } = await library.importFile(filename);
  const legacy = library.snapshot();
  delete legacy.books[0].bookmarks;
  await fs.writeFile(path.join(directory, 'data/library.json'), JSON.stringify(legacy));
  const upgraded = new Library(path.join(directory, 'data')); await upgraded.init();
  assert.deepEqual(upgraded.book(book.id).bookmarks, []);
  const value = { progress: { chapter: 1, ratio: .4, block: 20, offset: .1 }, excerpt: '保存的段落' };
  const bookmark = await upgraded.addBookmark(book.id, value);
  assert.equal((await upgraded.addBookmark(book.id, value)).id, bookmark.id);
  assert.equal(upgraded.book(book.id).bookmarks.length, 1);
  assert.equal(upgraded.book(book.id).progress.chapter, 0);
  const otherFile = path.join(directory, 'other.epub');
  await fs.writeFile(otherFile, await makeEpub({ title: '没有书签的书' }));
  const other = await upgraded.importFile(otherFile);
  assert.deepEqual(upgraded.book(other.book.id).bookmarks, []);
  const restarted = new Library(path.join(directory, 'data')); await restarted.init();
  assert.deepEqual(restarted.book(book.id).bookmarks[0], bookmark);
  await restarted.removeBookmark(book.id, bookmark.id);
  const fresh = new Library(path.join(directory, 'data')); await fresh.init();
  assert.deepEqual(fresh.book(book.id).bookmarks, []);
  await assert.rejects(fresh.addBookmark(book.id, { ...value, excerpt: 'a'.repeat(181) }), /摘要无效/);
  await assert.rejects(fresh.addBookmark(book.id, { ...value, progress: { ...value.progress, chapter: 99 } }), /位置无效/);
});

test('Bookmark persistence failure does not leave a phantom bookmark', async t => {
  const { directory, filename, library } = await setup(t);
  const { book } = await library.importFile(filename);
  const temp = path.join(directory, 'data/library.json.tmp');
  await fs.mkdir(temp);
  await assert.rejects(library.addBookmark(book.id, { progress: book.progress, excerpt: '测试' }));
  assert.deepEqual(library.book(book.id).bookmarks, []);
  await fs.rmdir(temp);
  await library.addBookmark(book.id, { progress: book.progress, excerpt: '测试' });
  assert.equal(library.book(book.id).bookmarks.length, 1);
});

test('Category migration, creation, rename, import, move and deletion preserve reading data', async t => {
  const { directory, filename, library } = await setup(t);
  const { book } = await library.importFile(filename);
  const progress = { chapter: 1, ratio: .4, block: 20, offset: .1 };
  await library.saveProgress(book.id, progress);
  await library.addBookmark(book.id, { progress, excerpt: '保留的书签' });
  const legacy = library.snapshot(); delete legacy.categories; delete legacy.books[0].categoryId;
  await fs.writeFile(path.join(directory, 'data/library.json'), JSON.stringify(legacy));
  const upgraded = new Library(path.join(directory, 'data')); await upgraded.init();
  assert.deepEqual(upgraded.snapshot().categories, []);
  assert.equal(upgraded.book(book.id).categoryId, null);
  const folder = await upgraded.saveCategory(null, '  文学小说  ');
  assert.equal(folder.name, '文学小说');
  await assert.rejects(upgraded.saveCategory(null, '文学小说'), /同名分类/);
  for (const name of ['', '  ', '全部书籍', '未分类', 'a'.repeat(31)]) await assert.rejects(upgraded.saveCategory(null, name));
  await upgraded.saveCategory(folder.id, '外国文学');
  await upgraded.moveBook(book.id, folder.id);
  const before = structuredClone(upgraded.book(book.id));
  const otherFile = path.join(directory, 'new.epub');
  await fs.writeFile(otherFile, await makeEpub({ title: '新导入的一本书' }));
  const other = await upgraded.importFile(otherFile, folder.id);
  assert.equal(other.book.categoryId, folder.id);
  assert.equal((await upgraded.importFile(filename, null)).duplicate, true);
  assert.equal(upgraded.book(book.id).categoryId, folder.id);
  await assert.rejects(upgraded.moveBook(book.id, '../missing'), /分类已不存在/);
  await assert.rejects(upgraded.importFile(otherFile, 'missing'), /分类已不存在/);
  const restarted = new Library(path.join(directory, 'data')); await restarted.init();
  assert.equal(restarted.snapshot().categories[0].name, '外国文学');
  assert.equal(restarted.book(book.id).categoryId, folder.id);
  await restarted.removeCategory(folder.id);
  const after = restarted.book(book.id);
  assert.equal(after.categoryId, null);
  assert.deepEqual(after.progress, before.progress);
  assert.deepEqual(after.bookmarks, before.bookmarks);
  assert.equal(restarted.book(other.book.id).categoryId, null);
  await restarted.open(book.id);
  assert.match((await restarted.chapter(book.id, 0)).html, /慢下来/);
  await fs.access(filename);
});

test('Failed category writes are atomic and dangling persisted category references are rejected', async t => {
  const { directory, filename, library } = await setup(t);
  const { book } = await library.importFile(filename);
  const folder = await library.saveCategory(null, '文学');
  await library.moveBook(book.id, folder.id);
  const temp = path.join(directory, 'data/library.json.tmp'); await fs.mkdir(temp);
  await assert.rejects(library.removeCategory(folder.id));
  await assert.rejects(library.moveBook(book.id, null));
  await assert.rejects(library.saveCategory(folder.id, '改名失败'));
  assert.equal(library.snapshot().categories[0].name, '文学');
  assert.equal(library.book(book.id).categoryId, folder.id);
  await fs.rmdir(temp);
  const state = library.snapshot(); state.books[0].categoryId = 'missing';
  const target = path.join(directory, 'data/library.json');
  const raw = JSON.stringify(state); await fs.writeFile(target, raw);
  await assert.rejects(new Library(path.join(directory, 'data')).init(), /原有数据已保留/);
  assert.equal(await fs.readFile(target, 'utf8'), raw);
});

test('Legacy typography receives defaults; fonts persist per book and new books inherit the last choice', async t => {
  const { directory, filename, library } = await setup(t);
  const { book } = await library.importFile(filename);
  const legacy = library.snapshot(); delete legacy.books[0].fontFamily;
  legacy.settings = { fontSize: 22, lineHeight: 2, width: 800 };
  await fs.writeFile(path.join(directory, 'data/library.json'), JSON.stringify(legacy));
  const updated = new Library(path.join(directory, 'data')); await updated.init();
  assert.equal(updated.snapshot().settings.paragraphGap, 1.2);
  assert.equal(updated.snapshot().settings.fontFamily, 'system');
  const chosen = { ...updated.snapshot().settings, paragraphGap: 1.8, fontFamily: 'serif' };
  await updated.saveSettings(chosen, book.id);
  const otherFile = path.join(directory, 'font-book.epub');
  await fs.writeFile(otherFile, await makeEpub({ title: '字体继承测试' }));
  const { book: other } = await updated.importFile(otherFile);
  await updated.saveProgress(other.id, other.progress);
  assert.equal(updated.book(other.id).fontFamily, 'serif');
  await updated.saveSettings({ ...chosen, fontFamily: 'wenkai' }, other.id);
  assert.equal(updated.book(book.id).fontFamily, 'serif');
  assert.equal(updated.book(other.id).fontFamily, 'wenkai');
  const fresh = new Library(path.join(directory, 'data')); await fresh.init();
  assert.equal(fresh.book(book.id).fontFamily, 'serif');
  assert.equal(fresh.book(other.id).fontFamily, 'wenkai');
  assert.equal(fresh.snapshot().settings.paragraphGap, 1.8);
  for (const value of [{ ...chosen, fontFamily: 'https://unsafe/font' }, { ...chosen, paragraphGap: -1 }, { ...chosen, paragraphGap: 10 }]) {
    await assert.rejects(fresh.saveSettings(value, book.id), /范围/);
  }
  const temp = path.join(directory, 'data/library.json.tmp'); await fs.mkdir(temp);
  await assert.rejects(fresh.saveSettings({ ...chosen, fontFamily: 'sans' }, book.id));
  assert.equal(fresh.book(book.id).fontFamily, 'serif');
  await fs.rmdir(temp);
});
