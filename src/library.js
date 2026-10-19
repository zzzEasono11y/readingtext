const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseEpub, readResource, MAX_FILE } = require('./epub');
const VOICES = require('../assets/voice/voices.json');
const { validModel, usageOf } = require('./ai');
const { validateImage, validateSources, ensureImageBudget } = require('./ai-materials');

function validateDiscussion(turns, annotation) {
  if (!Array.isArray(turns) || turns.length > 20) throw new Error('摘录讨论数据无效。');
  const ids = new Set();
  for (const turn of turns) {
    if (!turn || typeof turn.id !== 'string' || !/^[a-f\d-]{36}$/.test(turn.id) || ids.has(turn.id)
      || (turn.parentId !== null && (typeof turn.parentId !== 'string' || !/^[a-f\d-]{36}$/.test(turn.parentId)))
      || typeof turn.question !== 'string' || !turn.question.trim() || turn.question.length > 1500
      || typeof turn.answer !== 'string' || !turn.answer.trim() || turn.answer.length > 12000 || !validModel(turn.model)
      || typeof turn.createdAt !== 'string' || !Number.isFinite(Date.parse(turn.createdAt)) || typeof turn.truncated !== 'boolean'
      || !turn.usage || typeof turn.usage !== 'object' || Array.isArray(turn.usage)
      || Object.keys(turn.usage).length !== Object.keys(usageOf(turn.usage)).length) throw new Error('摘录讨论数据无效。');
    if (turn.parentId !== (turns[ids.size - 1]?.id || null)) throw new Error('摘录讨论顺序无效。');
    if (turn.image !== undefined) validateImage(turn.image);
    if (turn.sources !== undefined) validateSources(turn.sources, annotation);
    ids.add(turn.id);
  }
  return structuredClone(turns);
}

const FONT_IDS = ['system', 'serif', 'wenkai', 'sans'];
const DEFAULT_SETTINGS = { fontSize: 20, lineHeight: 1.9, width: 760, paragraphGap: 1.2, fontFamily: 'system', background: 'white', tint: .6 };
const DEFAULT_VOICE_SETTINGS = { rate: .9, prewarm: true, autoAdvance: true, speaker: 'Serena' };
function validateVoiceSettings(value) {
  const autoAdvance = value?.autoAdvance === undefined ? true : value.autoAdvance;
  const speaker = value?.speaker === undefined ? 'Serena' : value.speaker;
  if (!value || !Number.isFinite(value.rate) || value.rate < .6 || value.rate > 2 || typeof value.prewarm !== 'boolean' || typeof autoAdvance !== 'boolean' || typeof speaker !== 'string' || !Object.hasOwn(VOICES, speaker)) throw new Error('朗读设置无效。');
  return { rate: value.rate, prewarm: value.prewarm, autoAdvance, speaker };
}
function categoryName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 30
    || ['全部书籍', '未分类'].includes(value.trim())) throw new Error('分类名称需为 1–30 个字符，且不能使用“全部书籍”或“未分类”。');
  return value.trim();
}
function validateSettings(value) {
  const paragraphGap = value?.paragraphGap === undefined ? DEFAULT_SETTINGS.paragraphGap : value.paragraphGap;
  const fontFamily = value?.fontFamily === undefined ? DEFAULT_SETTINGS.fontFamily : value.fontFamily;
  const background = value?.background === undefined ? DEFAULT_SETTINGS.background : value.background;
  const tint = value?.tint === undefined ? DEFAULT_SETTINGS.tint : value.tint;
  if (!value || !Number.isFinite(value.fontSize) || value.fontSize < 14 || value.fontSize > 32
    || !Number.isFinite(value.lineHeight) || value.lineHeight < 1.4 || value.lineHeight > 2.4
    || !Number.isFinite(value.width) || value.width < 560 || value.width > 960
    || !Number.isFinite(paragraphGap) || paragraphGap < 0 || paragraphGap > 2.4 || !FONT_IDS.includes(fontFamily)
    || !['white', 'blue', 'gray', 'sand'].includes(background) || !Number.isFinite(tint) || tint < 0 || tint > 1) {
    throw new Error('阅读设置超出了允许的范围。');
  }
  return { fontSize: value.fontSize, lineHeight: value.lineHeight, width: value.width, paragraphGap, fontFamily, background, tint };
}
function validateProgress(value, chapterCount) {
  if (!value || !Number.isInteger(value.chapter) || value.chapter < 0 || value.chapter >= chapterCount
    || !Number.isFinite(value.ratio) || value.ratio < 0 || value.ratio > 1
    || !Number.isInteger(value.block) || value.block < 0 || value.block > 1000000
    || !Number.isFinite(value.offset) || value.offset < 0 || value.offset > 1) {
    throw new Error('阅读位置无效。');
  }
  return { chapter: value.chapter, ratio: value.ratio, block: value.block, offset: value.offset };
}
function validateListeningPosition(value, chapterCount) {
  const clean = validateProgress({ chapter: value?.chapter, block: value?.block, ratio: 0, offset: 0 }, chapterCount);
  if (!Number.isInteger(value?.part) || value.part < 0 || value.part > 100000) throw new Error('听读位置无效。');
  return { chapter: clean.chapter, block: clean.block, part: value.part };
}
function validateAnnotation(value, chapterCount) {
  const color = value?.color === undefined ? 'yellow' : value.color;
  const kind = value?.kind ?? 'text';
  if (!value || !Number.isInteger(value.chapter) || value.chapter < 0 || value.chapter >= chapterCount
    || !Number.isInteger(value.start) || value.start < 0 || !Number.isInteger(value.end) || value.end <= value.start || value.end > 4 * 1024 * 1024
    || typeof value.quote !== 'string' || !value.quote.trim() || value.quote.length > 4000 || value.end - value.start !== value.quote.length
    || (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 2000))
    || (value.isExcerpt !== undefined && typeof value.isExcerpt !== 'boolean')
    || !['text', 'image'].includes(kind) || (kind === 'image' && value.isExcerpt !== false)
    || !['yellow', 'blue', 'green', 'purple'].includes(color)) throw new Error('摘录或笔记无效，请重新选择文字。');
  return { chapter: value.chapter, start: value.start, end: value.end, quote: value.quote, note: value.note ?? '', color, isExcerpt: value.isExcerpt ?? true, kind };
}

function validateState(state) {
  if (state.version !== 1 || !Array.isArray(state.books)) throw new Error('书架数据格式无效。');
  state.settings = validateSettings(state.settings);
  state.voiceSettings = validateVoiceSettings(state.voiceSettings ?? DEFAULT_VOICE_SETTINGS);
  state.categories ??= [];
  if (!Array.isArray(state.categories) || state.categories.length > 100) throw new Error('分类数据无效。');
  const categoryIds = new Set();
  const categoryNames = new Set();
  for (const category of state.categories) {
    const name = categoryName(category.name).toLowerCase();
    if (typeof category.id !== 'string' || !/^[a-f\d-]{36}$/.test(category.id)
      || categoryIds.has(category.id) || categoryNames.has(name)) throw new Error('分类数据无效。');
    categoryIds.add(category.id); categoryNames.add(name);
  }
  const ids = new Set();
  for (const book of state.books) {
    if (typeof book.id !== 'string' || !/^[a-f\d]{64}$/.test(book.id)) throw new Error('书籍编号无效。');
    if (ids.has(book.id) || typeof book.title !== 'string' || typeof book.author !== 'string'
      || !Number.isInteger(book.chapterCount) || book.chapterCount < 1
      || typeof book.importedAt !== 'string' || !Number.isFinite(Date.parse(book.importedAt))
      || (book.lastReadAt !== null && (typeof book.lastReadAt !== 'string' || !Number.isFinite(Date.parse(book.lastReadAt))))) throw new Error('书架数据格式无效。');
    validateProgress(book.progress, book.chapterCount);
    book.listeningPosition ??= null;
    if (book.listeningPosition !== null) book.listeningPosition = validateListeningPosition(book.listeningPosition, book.chapterCount);
    book.fontFamily ??= null;
    if (book.fontFamily !== null && !FONT_IDS.includes(book.fontFamily)) throw new Error('字体设置无效。');
    book.categoryId ??= null;
    if (book.categoryId !== null && !categoryIds.has(book.categoryId)) throw new Error('书籍分类无效。');
    book.bookmarks ??= [];
    if (!Array.isArray(book.bookmarks) || book.bookmarks.length > 1000) throw new Error('书签数据无效。');
    const bookmarkIds = new Set();
    for (const bookmark of book.bookmarks) {
      if (typeof bookmark.id !== 'string' || !/^[a-f\d-]{36}$/.test(bookmark.id)
        || bookmarkIds.has(bookmark.id) || typeof bookmark.excerpt !== 'string'
        || bookmark.excerpt.length > 180 || !Number.isFinite(Date.parse(bookmark.createdAt))) throw new Error('书签数据无效。');
      validateProgress(bookmark.progress, book.chapterCount);
      bookmarkIds.add(bookmark.id);
    }
    book.annotations ??= [];
    if (!Array.isArray(book.annotations) || book.annotations.length > 1000) throw new Error('摘录数据无效。');
    const annotationIds = new Set();
    for (const annotation of book.annotations) {
      annotation.color ??= 'yellow';
      if (annotation.isExcerpt === undefined) annotation.isExcerpt = true;
      validateAnnotation(annotation, book.chapterCount);
      annotation.discussion ??= [];
      validateDiscussion(annotation.discussion, annotation);
      if (typeof annotation.id !== 'string' || !/^[a-f\d-]{36}$/.test(annotation.id) || annotationIds.has(annotation.id)
        || !Number.isFinite(Date.parse(annotation.createdAt)) || !Number.isFinite(Date.parse(annotation.updatedAt))) throw new Error('摘录数据无效。');
      annotationIds.add(annotation.id);
    }
    ids.add(book.id);
  }
  ensureImageBudget(state); return state;
}

class Library {
  constructor(directory) {
    this.directory = directory;
    this.state = { version: 1, books: [], categories: [], settings: { ...DEFAULT_SETTINGS }, voiceSettings: { ...DEFAULT_VOICE_SETTINGS } };
    this.queue = Promise.resolve();
    this.active = null;
  }
  async init() {
    await fs.mkdir(path.join(this.directory, 'books'), { recursive: true });
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.directory, 'library.json'), 'utf8'));
      validateState(state);
      this.state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取本地书架。原有数据已保留，请检查 library.json 或从备份恢复。');
    }
    return this.snapshot();
  }
  snapshot() { return structuredClone(this.state); }
  category(id, state = this.state) {
    if (id === null) return null;
    const category = state.categories.find(item => item.id === id);
    if (!category) throw new Error('这个分类已不存在，请重新选择。');
    return category;
  }
  async saveCategory(id, value) {
    const name = categoryName(value);
    return this.mutate(next => {
      if (next.categories.some(item => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new Error('已经有同名分类了。');
      if (id !== null) {
        const category = this.category(id, next); category.name = name; return { ...category };
      }
      if (next.categories.length >= 100) throw new Error('最多创建 100 个分类。');
      const category = { id: randomUUID(), name };
      next.categories.push(category); return { ...category };
    });
  }
  async removeCategory(id) {
    if (id === null) throw new Error('请选择要删除的分类。');
    return this.mutate(next => {
      this.category(id, next);
      next.categories = next.categories.filter(item => item.id !== id);
      for (const book of next.books) if (book.categoryId === id) book.categoryId = null;
    });
  }
  async moveBook(id, categoryId) {
    this.book(id);
    return this.mutate(next => {
      this.category(categoryId, next);
      const book = next.books.find(item => item.id === id);
      if (!book) throw new Error('这本书不在书架中。');
      book.categoryId = categoryId;
    });
  }
  validateId(id) {
    if (typeof id !== 'string' || !/^[a-f\d]{64}$/.test(id)) throw new Error('书籍编号无效。');
  }
  book(id) {
    this.validateId(id);
    const book = this.state.books.find(item => item.id === id);
    if (!book) throw new Error('这本书不在书架中。');
    return book;
  }
  mutate(change) {
    return this.locked(async () => {
      const next = this.snapshot();
      const result = await change(next);
      // shortcut: screenshots stay in library.json up to 32 MiB; move them to separate assets if image libraries grow.
      ensureImageBudget(next);
      const target = path.join(this.directory, 'library.json');
      const temp = `${target}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
      await fs.rename(temp, target);
      this.state = next;
      return result;
    });
  }
  locked(action) {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {}); return operation;
  }
  async importFile(filename, categoryId = null) {
    this.category(categoryId);
    if (path.extname(filename).toLowerCase() !== '.epub') throw new Error('请选择 EPUB 格式的电子书。');
    if ((await fs.stat(filename)).size > MAX_FILE) throw new Error('第一版支持 100 MB 以内的 EPUB 文件。');
    const bytes = await fs.readFile(filename);
    const id = createHash('sha256').update(bytes).digest('hex');
    await this.queue;
    if (this.state.books.some(item => item.id === id)) return { book: structuredClone(this.book(id)), duplicate: true };
    const epub = await parseEpub(bytes);
    const book = { id, title: epub.title, author: epub.author, cover: epub.cover,
      chapterCount: epub.chapters.length, importedAt: new Date().toISOString(), lastReadAt: null,
      progress: { chapter: 0, ratio: 0, block: 0, offset: 0 }, bookmarks: [], annotations: [], categoryId, fontFamily: null };
    return this.mutate(async next => {
      if (next.books.some(item => item.id === id)) return { book: next.books.find(item => item.id === id), duplicate: true };
      this.category(categoryId, next);
      await fs.writeFile(path.join(this.directory, 'books', `${id}.epub`), bytes);
      next.books.unshift(book);
      return { book, duplicate: false };
    });
  }
  async open(id) {
    const book = this.book(id);
    const epub = await parseEpub(await fs.readFile(path.join(this.directory, 'books', `${id}.epub`)));
    this.active = { id, epub };
    return { ...structuredClone(book), chapters: epub.chapters, toc: epub.toc };
  }
  async chapter(id, index) {
    this.book(id);
    if (this.active?.id !== id) throw new Error('请先打开这本书。');
    const chapters = this.active.epub.chapters;
    if (!Number.isInteger(index) || index < 0 || index >= chapters.length) throw new Error('章节编号无效。');
    return { ...chapters[index], html: await readResource(this.active.epub.zip, chapters[index].path, 'string', 4 * 1024 * 1024) };
  }
  async image(id, resource) {
    if (this.active?.id !== id) throw new Error('书籍资源未打开。');
    const item = this.active.epub.manifest.find(entry => entry.path === resource && entry.mediaType.startsWith('image/'));
    if (!item) throw new Error('图片不存在。');
    return { bytes: await readResource(this.active.epub.zip, resource, 'nodebuffer'), mediaType: item.mediaType };
  }
  async saveProgress(id, progress) {
    const clean = validateProgress(progress, this.book(id).chapterCount);
    return this.mutate(next => {
      const book = next.books.find(item => item.id === id);
      if (!book) throw new Error('这本书不在书架中。');
      book.progress = clean;
      book.fontFamily ??= next.settings.fontFamily;
      book.lastReadAt = new Date().toISOString();
    });
  }
  async saveSettings(settings, bookId = null) {
    const clean = validateSettings(settings);
    if (bookId !== null) this.book(bookId);
    return this.mutate(next => {
      if (bookId !== null) {
        const book = next.books.find(item => item.id === bookId);
        if (!book) throw new Error('这本书不在书架中。');
        book.fontFamily = clean.fontFamily;
      }
      next.settings = clean;
    });
  }
  async saveListeningPosition(id, value) {
    const clean = validateListeningPosition(value, this.book(id).chapterCount);
    return this.mutate(next => {
      const book = next.books.find(item => item.id === id);
      if (!book) throw new Error('这本书不在书架中。');
      book.listeningPosition = clean;
    });
  }
  async saveVoiceSettings(value) {
    const clean = validateVoiceSettings(value);
    return this.mutate(next => { next.voiceSettings = clean; });
  }
  async addBookmark(id, value) {
    const progress = validateProgress(value?.progress, this.book(id).chapterCount);
    if (typeof value.excerpt !== 'string' || value.excerpt.length > 180) throw new Error('书签摘要无效。');
    return this.mutate(next => {
      const book = next.books.find(item => item.id === id);
      if (!book) throw new Error('这本书不在书架中。');
      book.bookmarks ??= [];
      const existing = book.bookmarks.find(item => item.progress.chapter === progress.chapter && item.progress.block === progress.block);
      if (existing) return structuredClone(existing);
      if (book.bookmarks.length >= 1000) throw new Error('每本书最多保存 1000 个书签。');
      const bookmark = { id: randomUUID(), progress, excerpt: value.excerpt, createdAt: new Date().toISOString() };
      book.bookmarks.push(bookmark);
      return structuredClone(bookmark);
    });
  }
  async removeBookmark(id, bookmarkId) {
    this.book(id);
    if (typeof bookmarkId !== 'string') throw new Error('书签编号无效。');
    return this.mutate(next => {
      const book = next.books.find(item => item.id === id);
      if (!book) throw new Error('这本书不在书架中。');
      book.bookmarks = (book.bookmarks || []).filter(item => item.id !== bookmarkId);
    });
  }
  async saveAnnotation(id, value) {
    const clean = validateAnnotation(value, this.book(id).chapterCount);
    if (value.id != null && (typeof value.id !== 'string' || !/^[a-f\d-]{36}$/.test(value.id))) throw new Error('摘录编号无效。');
    return this.mutate(next => {
      const book = next.books.find(item => item.id === id); if (!book) throw new Error('这本书不在书架中。');
      book.annotations ??= [];
      const existing = value.id ? book.annotations.find(item => item.id === value.id)
        : book.annotations.find(item => (item.kind || 'text') === clean.kind && item.chapter === clean.chapter && item.start === clean.start && item.end === clean.end && item.quote === clean.quote);
      if (value.id && !existing) throw new Error('这条摘录已不存在。');
      if (existing) {
        existing.isExcerpt = existing.isExcerpt !== false || clean.isExcerpt;
        if (value.note !== undefined) existing.note = clean.note;
        if (value.color !== undefined) existing.color = clean.color;
        if (value.note !== undefined || value.color !== undefined) existing.updatedAt = new Date().toISOString();
        return structuredClone(existing);
      }
      if (book.annotations.length >= 1000) throw new Error('每本书最多保存 1000 条摘录。');
      const annotation = { ...clean, discussion: validateDiscussion(value.discussion || [], clean), id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      book.annotations.push(annotation); return structuredClone(annotation);
    });
  }
  async removeAnnotation(id, annotationId) {
    this.book(id);
    return this.mutate(next => {
      const book = next.books.find(item => item.id === id); if (!book) throw new Error('这本书不在书架中。');
      book.annotations = (book.annotations || []).filter(item => item.id !== annotationId);
    });
  }
  async appendDiscussion(id, annotationId, turn, replaceId = null) {
    this.book(id);
    return this.mutate(next => {
      const annotation = next.books.find(book => book.id === id)?.annotations.find(item => item.id === annotationId);
      if (!annotation) throw new Error('这条摘录已不存在，讨论未保存。');
      annotation.discussion ??= [];
      const existing = annotation.discussion.find(item => item.id === turn?.id); if (existing) return structuredClone(annotation);
      if (replaceId !== null && annotation.discussion.at(-1)?.id !== replaceId) throw new Error('讨论已改变，请重新打开后再生成。');
      const turns = [...(replaceId === null ? annotation.discussion : annotation.discussion.slice(0, -1)), turn]; validateDiscussion(turns, annotation);
      annotation.discussion = turns; annotation.updatedAt = new Date().toISOString();
      return structuredClone(annotation);
    });
  }
  async trimDiscussion(id, annotationId, fromId, expectedLastId) {
    this.book(id);
    return this.mutate(next => {
      const annotation = next.books.find(book => book.id === id)?.annotations.find(item => item.id === annotationId);
      if (!annotation) throw new Error('这条摘录已不存在。');
      const turns = annotation.discussion || []; const index = turns.findIndex(turn => turn.id === fromId);
      if (index < 0 || turns.at(-1)?.id !== expectedLastId) throw new Error('讨论已改变，请重新打开后再删除。');
      annotation.discussion = turns.slice(0, index); annotation.updatedAt = new Date().toISOString();
      return structuredClone(annotation);
    });
  }
  async remove(id) {
    this.book(id);
    await this.mutate(next => { next.books = next.books.filter(book => book.id !== id); });
    if (this.active?.id === id) this.active = null;
    await fs.rm(path.join(this.directory, 'books', `${id}.epub`), { force: true });
  }
}

module.exports = { Library, DEFAULT_SETTINGS, validateSettings, validateProgress, validateState };
