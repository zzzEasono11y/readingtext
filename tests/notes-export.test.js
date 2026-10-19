const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { entries, formatMarkdown, formatText, exportNotes } = require('../src/notes-export');

function book() {
  return {
    title: '安娜·卡列尼娜', author: '列夫·托尔斯泰',
    chapters: [{ label: '第一部' }, { label: '第二部' }],
    annotations: [
      { chapter: 1, start: 5, end: 9, quote: '第二段\n带有换行', note: '这是一条笔记', color: 'blue', isExcerpt: true, kind: 'text', createdAt: '2026-01-02T00:00:00.000Z' },
      { chapter: 0, start: 1, end: 3, quote: '第一句', note: '', color: 'yellow', isExcerpt: true, kind: 'text', createdAt: '2026-01-01T00:00:00.000Z' },
      { chapter: 0, start: 20, end: 22, quote: 'AI 临时讨论', note: '', color: 'purple', isExcerpt: false, kind: 'text', createdAt: '2026-01-03T00:00:00.000Z' },
      { chapter: 0, start: 30, end: 32, quote: '截图会话', note: '', color: 'yellow', isExcerpt: false, kind: 'image', createdAt: '2026-01-04T00:00:00.000Z' }
    ]
  };
}

test('Note export keeps real excerpts ordered and leaves AI-only sessions out', () => {
  const value = book();
  assert.deepEqual(entries(value).map(item => item.quote), ['第一句', '第二段\n带有换行']);
  const markdown = formatMarkdown(value);
  assert.match(markdown, /^# 安娜·卡列尼娜/m);
  assert.match(markdown, /> 第二段\n> 带有换行/);
  assert.match(markdown, /\*\*我的笔记\*\*[\s\S]*这是一条笔记/);
  assert.doesNotMatch(markdown, /AI 临时讨论|截图会话/);
  const text = formatText(value);
  assert.match(text, /第一部/); assert.match(text, /我的笔记：这是一条笔记/); assert.doesNotMatch(text, /AI 临时讨论/);
});

test('Note export writes the selected format and count', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readingtext-notes-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'notes.md'); const result = await exportNotes(book(), target, 'markdown');
  assert.equal(result.count, 2); assert.equal(result.filename, target); assert.match(await fs.readFile(target, 'utf8'), /摘录与笔记/);
  await assert.rejects(exportNotes(book(), path.join(root, 'bad'), 'pdf'), /导出格式无效/);
});
