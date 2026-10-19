const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { extractSources, validateSources, validateImage, ensureImageBudget } = require('../src/ai-materials');
const { Library } = require('../src/library');
const { exportBackup, readBackup, restoreBackup } = require('../src/backup');
const { makeEpub } = require('./fixtures');
async function image() { return { width: 64, height: 32, dataUrl: 'data:image/jpeg;base64,' + (await fs.readFile(path.join(__dirname, 'reading-image.jpg'))).toString('base64') }; }

test('Citations match exact original text and absolute locations; fabricated quotes never become source links', () => {
  const annotation = { chapter: 2, start: 100, end: 108, quote: '清晨，窗边的光。' };
  const result = extractSources('一种解读【原文：窗边的光】。再看【原文：窗边的光】；伪引文【原文：从未出现】。', annotation);
  assert.equal(result.sources.length, 1); assert.match(result.answer, /\[原文 1\]/); assert.match(result.answer, /引文未匹配/);
  assert.deepEqual(result.sources[0], { chapter: 2, start: 103, end: 107, quote: '窗边的光' });
  assert.doesNotThrow(() => validateSources(result.sources, annotation));
  for (const bad of [{ ...result.sources[0], start: 0 }, { ...result.sources[0], quote: '假原文' }, { ...result.sources[0], chapter: 3 }]) assert.throws(() => validateSources([bad], annotation), /未匹配/);
  assert.equal(extractSources('【原文：窗边的光】', { ...annotation, kind: 'image' }).sources.length, 0);
});

test('Screenshot validation bounds actual JPEG dimensions and rejects URLs, other MIME types and oversized payloads', async () => {
  const valid = await image(); assert.deepEqual(validateImage(valid), valid);
  for (const bad of [{ ...valid, width: 5000 }, { ...valid, height: 33 }, { ...valid, dataUrl: 'https://example.com/a.jpg' }, { ...valid, dataUrl: valid.dataUrl.replace('image/jpeg', 'image/svg+xml') }, { ...valid, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(700001) }]) assert.throws(() => validateImage(bad), /截图/);
  const full = { books: [{ annotations: [{ discussion: [{ image: { dataUrl: 'x'.repeat(32 * 1024 * 1024) } }] }] }] };
  assert.throws(() => ensureImageBudget(full, valid), /上限/);
  assert.doesNotThrow(() => ensureImageBudget(full, valid, valid));
});

test('Images and verified citations save atomically, survive restart and backups, and image sessions cannot become text highlights', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readingtext-materials-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = new Library(path.join(root, 'library')); await library.init(); const file = path.join(root, 'book.epub'); await fs.writeFile(file, await makeEpub()); const { book } = await library.importFile(file);
  const mark = await library.saveAnnotation(book.id, { chapter: 0, start: 0, end: 4, quote: '真实原文', isExcerpt: false });
  const turn = { id: randomUUID(), parentId: null, question: '解释图片', answer: '一种理解 [原文 1]', model: 'deepseek-flash', usage: {}, createdAt: new Date().toISOString(), truncated: false, image: await image(), sources: [{ chapter: 0, start: 0, end: 4, quote: '真实原文' }] };
  const temp = path.join(library.directory, 'library.json.tmp'); await fs.mkdir(temp);
  try { await assert.rejects(library.appendDiscussion(book.id, mark.id, turn)); } finally { await fs.rmdir(temp); }
  assert.equal(library.book(book.id).annotations[0].discussion.length, 0);
  await library.appendDiscussion(book.id, mark.id, turn);
  await assert.rejects(library.appendDiscussion(book.id, mark.id, { ...turn, id: randomUUID(), parentId: turn.id, sources: [{ chapter: 0, start: 0, end: 4, quote: '伪造原文' }] }), /未匹配/);
  await assert.rejects(library.saveAnnotation(book.id, { chapter: 0, start: 0, end: 4, quote: '截图会话', kind: 'image', isExcerpt: true }), /无效/);
  const backup = path.join(root, 'backup.readingtext'); await exportBackup(library, backup);
  const target = new Library(path.join(root, 'target')); await target.init(); await restoreBackup(target, await readBackup(backup));
  const fresh = new Library(target.directory); await fresh.init(); assert.deepEqual(fresh.book(book.id).annotations[0].discussion[0], turn);
});
