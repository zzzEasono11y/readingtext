const fs = require('node:fs/promises');

const FORMATS = new Set(['markdown', 'text']);

function clean(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

function entries(book) {
  return (book?.annotations || [])
    .filter(value => value.kind !== 'image' && value.isExcerpt !== false)
    .map(value => ({
      ...value,
      quote: clean(value.quote),
      note: clean(value.note),
      chapterLabel: clean(book.chapters?.[value.chapter]?.label) || `第 ${value.chapter + 1} 节`
    }))
    .filter(value => value.quote)
    .sort((a, b) => a.chapter - b.chapter || a.start - b.start || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function quoteMarkdown(value) {
  return value.split('\n').map(line => `> ${line || ' '}`).join('\n');
}

function formatMarkdown(book) {
  const values = entries(book);
  const lines = [`# ${clean(book?.title) || '未命名书籍'}`];
  if (clean(book?.author)) lines.push('', `作者：${clean(book.author)}`);
  lines.push('', '## 摘录与笔记');
  if (!values.length) lines.push('', '暂无可导出的摘录。');
  values.forEach((value, index) => {
    lines.push('', `### ${index + 1}. ${value.chapterLabel}`, '', quoteMarkdown(value.quote));
    if (value.note) lines.push('', '**我的笔记**', '', value.note);
    lines.push('', `> 标注颜色：${value.color || 'yellow'}`);
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

function formatText(book) {
  const values = entries(book);
  const lines = [clean(book?.title) || '未命名书籍'];
  if (clean(book?.author)) lines.push(`作者：${clean(book.author)}`);
  lines.push('', '摘录与笔记');
  if (!values.length) lines.push('', '暂无可导出的摘录。');
  values.forEach((value, index) => {
    lines.push('', `${index + 1}. ${value.chapterLabel}`, '', value.quote);
    if (value.note) lines.push('', `我的笔记：${value.note}`);
    lines.push('', `标注颜色：${value.color || 'yellow'}`);
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

function render(book, format = 'markdown') {
  if (!FORMATS.has(format)) throw new Error('导出格式无效。');
  return format === 'markdown' ? formatMarkdown(book) : formatText(book);
}

async function exportNotes(book, filename, format = 'markdown') {
  if (typeof filename !== 'string' || !filename.trim()) throw new Error('导出文件名无效。');
  const content = render(book, format);
  await fs.writeFile(filename, content, 'utf8');
  return { filename, format, count: entries(book).length };
}

module.exports = { entries, formatMarkdown, formatText, render, exportNotes };
