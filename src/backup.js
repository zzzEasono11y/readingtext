const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const JSZip = require('jszip');
const { crc32 } = require('node:zlib');
const { validateState } = require('./library');
const { parseEpub, MAX_FILE } = require('./epub');
const MAX_BACKUP = 250 * 1024 * 1024;
const MAX_CONTENT = 500 * 1024 * 1024;
const MAX_METADATA = 64 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function readEntry(entry, limit) {
  if (!entry) return Promise.reject(new Error('备份缺少文件'));
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('nodebuffer'); const parts = []; let size = 0;
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { stream.pause(); reject(new Error('实际解压大小过大')); return; }
      parts.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      const bytes = Buffer.concat(parts);
      if (crc32(bytes) !== (entry._data.crc32 >>> 0)) reject(new Error('文件校验失败')); else resolve(bytes);
    });
    stream.resume();
  });
}

async function exportBackup(library, filename) {
  const target = path.resolve(filename); const root = path.resolve(library.directory);
  if (target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith((root + path.sep).toLowerCase())) throw new Error('请把备份保存在书架数据文件夹之外。');
  return library.locked(async () => {
    const state = library.snapshot(); const zip = new JSZip();
    for (const book of state.books) book.cover = null; // Covers are rebuilt from the bundled EPUBs.
    const metadata = JSON.stringify({ format: 'readingtext-backup', version: 1, library: state });
    if (Buffer.byteLength(metadata) > MAX_METADATA || state.books.length > 500) throw new Error('当前书架超过此版本的备份容量。');
    zip.file('backup.json', metadata); let total = Buffer.byteLength(metadata);
    for (const book of state.books) {
      const bytes = await fs.readFile(path.join(root, 'books', `${book.id}.epub`));
      if (digest(bytes) !== book.id) throw new Error('书籍副本校验失败，请先检查本地数据。');
      total += bytes.length; if (total > MAX_CONTENT) throw new Error('此版本备份的书籍总大小最多为 500 MB。');
      zip.file(`books/${book.id}.epub`, bytes);
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    if (bytes.length > MAX_BACKUP) throw new Error('此版本的单个备份文件最多为 250 MB。');
    const temp = `${target}.tmp-${randomUUID()}`;
    try { await fs.writeFile(temp, bytes, { flag: 'wx' }); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }); }
    return { books: state.books.length };
  });
}

async function readBackup(filename) {
  if ((await fs.stat(filename)).size > MAX_BACKUP) throw new Error('备份文件超过 250 MB。');
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(filename));
    let total = 0;
    if (Object.keys(zip.files).length > 510) throw new Error('文件数量过多');
    for (const entry of Object.values(zip.files)) {
      if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw new Error('文件路径无效');
      if (entry.dir) { if (entry.name !== 'books/') throw new Error('文件夹无效'); continue; }
      if (entry.name !== 'backup.json' && !/^books\/[a-f\d]{64}\.epub$/.test(entry.name)) throw new Error('文件路径无效');
      const size = entry._data.uncompressedSize;
      if (!Number.isFinite(size) || size > (entry.name === 'backup.json' ? MAX_METADATA : MAX_FILE)) throw new Error('文件过大');
      total += size; if (total > MAX_CONTENT) throw new Error('解压大小过大');
    }
    const metadata = await readEntry(zip.file('backup.json'), MAX_METADATA);
    const data = JSON.parse(metadata.toString('utf8')); let decoded = metadata.length;
    if (data.format !== 'readingtext-backup' || data.version !== 1 || !Array.isArray(data.library?.books) || data.library.books.length > 500) throw new Error('格式不支持');
    const state = validateState(data.library); const files = new Map();
    for (const book of state.books) {
      const bytes = await readEntry(zip.file(`books/${book.id}.epub`), Math.min(MAX_FILE, MAX_CONTENT - decoded));
      decoded += bytes.length;
      if (digest(bytes) !== book.id) throw new Error('书籍校验失败');
      const epub = await parseEpub(bytes);
      if (epub.chapters.length !== book.chapterCount) throw new Error('章节数量不符');
      book.title = epub.title; book.author = epub.author; book.cover = epub.cover;
      files.set(book.id, bytes);
    }
    return { state, files };
  } catch { throw new Error('备份无法读取、已损坏或格式不支持，原有书架未改动。'); }
}

function previewBackup(library, backup) {
  const existing = new Set(library.snapshot().books.map(book => book.id));
  return { books: backup.state.books.length, newBooks: backup.state.books.filter(book => !existing.has(book.id)).length,
    annotations: backup.state.books.reduce((sum, book) => sum + book.annotations.filter(item => item.isExcerpt !== false).length, 0),
    bookmarks: backup.state.books.reduce((sum, book) => sum + book.bookmarks.length, 0) };
}

async function restoreBackup(library, backup) {
  return library.mutate(async next => {
    const empty = !next.books.length; const categoryMap = new Map();
    for (const category of backup.state.categories) {
      let match = next.categories.find(item => item.name.toLowerCase() === category.name.toLowerCase());
      if (!match) {
        if (next.categories.length >= 100) throw new Error('合并后的分类超过 100 个，请先整理分类。');
        match = { id: randomUUID(), name: category.name }; next.categories.push(match);
      }
      categoryMap.set(category.id, match.id);
    }
    let added = 0; let annotations = 0;
    for (const incoming of backup.state.books) {
      const file = path.join(library.directory, 'books', `${incoming.id}.epub`);
      // shortcut: interrupted restores can leave unreferenced copies; add cleanup if disk use becomes an issue.
      try { await fs.writeFile(file, backup.files.get(incoming.id), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; if (digest(await fs.readFile(file)) !== incoming.id) throw new Error('本地同名书籍副本异常，恢复已停止。'); }
      const existing = next.books.find(book => book.id === incoming.id);
      if (!existing) {
        next.books.push({ ...structuredClone(incoming), categoryId: incoming.categoryId === null ? null : categoryMap.get(incoming.categoryId) });
        added++; annotations += incoming.annotations.filter(item => item.isExcerpt !== false).length; continue;
      }
      existing.annotations ??= [];
      for (const mark of incoming.bookmarks) {
        if (existing.bookmarks.some(item => item.progress.chapter === mark.progress.chapter && item.progress.block === mark.progress.block)) continue;
        if (existing.bookmarks.length >= 1000) throw new Error('合并后的书签超过每本书 1000 个。');
        existing.bookmarks.push({ ...structuredClone(mark), id: randomUUID() });
      }
      for (const note of incoming.annotations) {
        const match = existing.annotations.find(item => item.chapter === note.chapter && item.start === note.start && item.end === note.end && item.quote === note.quote && item.note === note.note);
        if (match) {
          if (!match.discussion?.length) match.discussion = structuredClone(note.discussion);
          if (match.isExcerpt === false && note.isExcerpt !== false) { match.isExcerpt = true; match.color = note.color; annotations++; }
          continue;
        }
        if (existing.annotations.length >= 1000) throw new Error('合并后的摘录超过每本书 1000 条。');
        existing.annotations.push({ ...structuredClone(note), id: randomUUID() }); if (note.isExcerpt !== false) annotations++;
      }
    }
    if (empty) { next.settings = structuredClone(backup.state.settings); next.voiceSettings = structuredClone(backup.state.voiceSettings); }
    validateState(next);
    return { added, annotations };
  });
}
module.exports = { exportBackup, readBackup, previewBackup, restoreBackup };
