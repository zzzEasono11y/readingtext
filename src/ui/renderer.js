const $ = id => document.getElementById(id);
const api = window.reader;
const content = window.ReadingContent;
let books = [];
let categories = [];
let selectedCategory = 'all';
let editingCategory = null;
let deletingCategory = null;
let movingBook = null;
let settings = { fontSize: 20, lineHeight: 1.9, width: 760, paragraphGap: 1.2, fontFamily: 'system', background: 'white', tint: .6 };
let layoutVersion = 0;
let layoutPending = false;
let sortingPending = false;
let rightDrag = null;
let suppressContextUntil = 0;
let current = null;
let chapterIndex = 0;
let position = null;
let busy = false;
let suppressScroll = false;
let saveTimer;
let resizeTimer;
let toastTimer;
let pendingDelete;
let pendingSaves = Promise.resolve();
let failedSave = null;
let navigationHistory = [];
let searchGeneration = 0;
let searchQuery = '';
let fullscreen = false;
let quiet = false;
let quietHideTimer;
const speech = new window.ReadAloud(api, doc, error => toast(error.message, true), {
  getBook: () => current, getChapter: () => chapterIndex,
  advanceChapter: index => openChapter(index, null, '', false, null, true),
  savePosition: (id, value) => queueSave(() => api.saveListeningPosition(id, value)),
  saveVoiceSettings: value => queueSave(() => api.saveVoiceSettings(value))
});
const companion = new window.ReaderAi(api, {
  getBook: () => current, onError: error => toast(error.message, true), toast,
  saveExcerpt: (book, value) => notes.save(book, { ...value, isExcerpt: true }),
  getChapter: () => chapterIndex,
  saveImageSession: book => { const quote = '截图讨论 · ' + new Date().toLocaleString() + ' · ' + crypto.randomUUID().slice(0, 8); return notes.save(book, { chapter: chapterIndex, start: 0, end: quote.length, quote, kind: 'image', isExcerpt: false }); },
  gotoSource: async (book, source) => {
    if (current?.id !== book.id) throw new Error('请先打开这本书再查看引用。');
    if (!await openChapter(source.chapter, null, '', true)) return;
    const range = content.annotationRange(doc(), source);
    if (!range) throw new Error('引用未能在当前原文中定位，请核对书籍版本。');
    const frameDoc = doc(); frameDoc.defaultView.CSS.highlights.set('reader-source', new frameDoc.defaultView.Highlight(range));
    clearTimeout(companion.sourceTimer); companion.sourceTimer = setTimeout(() => { if (doc() === frameDoc) frameDoc.defaultView.CSS.highlights.delete('reader-source'); }, 2400);
    doc().defaultView.scrollBy(0, range.getBoundingClientRect().top - 100);
    position = content.location(doc(), chapterIndex); await saveCurrent();
  },
  onOpen: () => { setQuiet(false); doc()?.getSelection()?.removeAllRanges(); notes.hide(); speech.panel(false); closeTools(); $('settings-panel').hidden = true; },
  update: (book, saved) => {
    const replace = target => { const index = target?.annotations.findIndex(value => value.id === saved.id); if (index >= 0) target.annotations[index] = saved; };
    replace(book); if (current?.id === book.id) { replace(current); notes.apply(); notes.render(); }
  },
  editNote: value => notes.edit(current, value)
});
const notes = new window.ReaderNotes(api, doc, {
  getBook: () => current, getChapter: () => chapterIndex, persist: action => queueSave(action), toast,
  onError: error => toast(error.message, true),
  discuss: (book, value) => companion.open(book, value),
  removed: (bookId, annotationId) => companion.removed(bookId, annotationId),
  goto: async value => {
    closeTools(); if (!await openChapter(value.chapter, null, '', true)) return;
    const range = content.annotationRange(doc(), value);
    if (!range) { toast('这条摘录暂时无法定位，原文和笔记仍保留。', true); return; }
    notes.apply(value.id); doc().defaultView.scrollBy(0, range.getBoundingClientRect().top - 80);
    position = content.location(doc(), chapterIndex); await saveCurrent();
  }
});

function toast(message, error = false, action = null) {
  clearTimeout(toastTimer);
  const label = document.createElement('span'); label.textContent = message;
  $('toast').replaceChildren(label);
  if (action) {
    const button = document.createElement('button'); button.className = 'toast-action'; button.textContent = '撤销';
    button.onclick = async () => {
      clearTimeout(toastTimer); button.disabled = true;
      try { await action(); if (button.isConnected) toast('已撤销移动。'); }
      catch (error) { if (button.isConnected) { label.textContent = error.message; button.disabled = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 10000); } }
    };
    $('toast').append(button);
  }
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, action ? 8000 : error ? 10000 : 3500);
}
function run(action) {
  return Promise.resolve().then(action).catch(error => toast(error.message, true));
}
function percent(book) {
  const progress = book.progress;
  return Math.round((progress.chapter + progress.ratio) / book.chapterCount * 100);
}
function generatedCover(book, index) {
  const cover = document.createElement('div');
  cover.className = 'generated-cover';
  cover.style.setProperty('--cover-color', ['#dce4d7', '#e9dfc9', '#d7e1e3', '#e6d8d2'][index % 4]);
  for (const [className, value] of [['cover-label', 'READING TEXT'], ['cover-title', book.title], ['cover-author', book.author]]) {
    const node = document.createElement('span'); node.className = className; node.textContent = value; cover.append(node);
  }
  return cover;
}
function bookCover(book, index) {
  const cover = document.createElement('div'); cover.className = 'book-cover';
  if (book.cover) {
    const image = document.createElement('img'); image.src = book.cover; image.alt = `${book.title}封面`;
    image.onerror = () => cover.replaceChildren(generatedCover(book, index));
    cover.append(image);
  } else cover.append(generatedCover(book, index));
  return cover;
}
function renderCategories() {
  $('uncategorized-count').textContent = books.filter(book => !book.categoryId).length;
  for (const [id, selected] of [['all-books-button', selectedCategory === 'all'], ['uncategorized-button', selectedCategory === 'uncategorized']]) {
    $(id).classList.toggle('sidebar-current', selected);
    if (selected) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
  $('folder-hint').hidden = categories.length > 0;
  $('folder-list').replaceChildren();
  for (const category of categories) {
    const row = document.createElement('div'); row.className = 'folder-row';
    row.dataset.categoryDrop = category.id;
    row.classList.toggle('selected', selectedCategory === category.id);
    const button = document.createElement('button'); button.className = 'folder-button';
    button.setAttribute('aria-label', `打开分类 ${category.name}`);
    if (selectedCategory === category.id) button.setAttribute('aria-current', 'page');
    const icon = document.createElement('span'); icon.textContent = '▱'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'folder-label'; label.textContent = category.name;
    const count = document.createElement('span'); count.className = 'folder-count'; count.textContent = books.filter(book => book.categoryId === category.id).length;
    button.append(icon, label, count); button.onclick = () => selectCategory(category.id);
    const rename = document.createElement('button'); rename.className = 'folder-action'; rename.textContent = '✎';
    rename.setAttribute('aria-label', `重命名分类 ${category.name}`); rename.onclick = () => editCategory(category);
    const remove = document.createElement('button'); remove.className = 'folder-action'; remove.textContent = '×';
    remove.setAttribute('aria-label', `删除分类 ${category.name}`);
    remove.onclick = () => { deletingCategory = category.id; $('delete-folder-name').textContent = category.name; $('delete-folder-error').textContent = ''; $('delete-folder-dialog').showModal(); };
    row.append(button, rename, remove); $('folder-list').append(row);
  }
}
function selectCategory(id) { selectedCategory = id; window.scrollTo(0, 0); run(refreshShelf); }
function categoryOptions(select, id = null) {
  select.replaceChildren();
  for (const category of [{ id: '', name: '未分类' }, ...categories]) {
    const option = document.createElement('option'); option.value = category.id; option.textContent = category.name; select.append(option);
  }
  select.value = id || '';
}
function editCategory(category = null) {
  editingCategory = category?.id || null;
  $('folder-dialog-title').textContent = category ? '重命名分类' : '新建分类';
  $('folder-name').value = category?.name || ''; $('folder-error').textContent = '';
  $('folder-dialog').showModal(); $('folder-name').focus();
}
async function moveWithUndo(book, categoryId) {
  if (!book) throw new Error('这本书不在书架中。');
  if (sortingPending) throw new Error('正在整理，请稍后再试。');
  if (book.categoryId === categoryId) return;
  const previous = book.categoryId;
  const targetName = categories.find(category => category.id === categoryId)?.name || '未分类';
  sortingPending = true;
  try {
    await api.moveBook(book.id, categoryId);
    await refreshShelf();
    toast(`已将《${book.title}》移到${targetName}。`, false, async () => {
      if (sortingPending) throw new Error('正在整理，请稍后再试。');
      sortingPending = true;
      try { await api.moveBook(book.id, previous); await refreshShelf(); }
      finally { sortingPending = false; }
    });
  } finally { sortingPending = false; }
}
function cancelRightDrag() {
  const drag = rightDrag;
  if (!drag) return;
  rightDrag = null;
  drag.ghost?.remove();
  drag.element.classList.remove('book-dragging');
  document.body.classList.remove('sorting-book');
  document.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
  try { if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId); } catch {}
  suppressContextUntil = Date.now() + 500;
}
document.addEventListener('pointerdown', event => {
  const element = event.target.closest('.book-open');
  if (event.button !== 2 || !element || current || busy || sortingPending || document.querySelector('dialog[open]')) return;
  const book = books.find(item => item.id === element.dataset.bookId);
  if (!book) return;
  event.preventDefault();
  rightDrag = { element, book, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ghost: null };
  suppressContextUntil = Date.now() + 800;
  element.setPointerCapture(event.pointerId);
});
document.addEventListener('pointermove', event => {
  const drag = rightDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!(event.buttons & 2)) { cancelRightDrag(); return; }
  if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
  if (!drag.ghost) {
    drag.ghost = document.createElement('div'); drag.ghost.className = 'drag-ghost'; drag.ghost.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'drag-label';
    drag.ghost.append(bookCover(drag.book, books.indexOf(drag.book)), label); document.body.append(drag.ghost);
    drag.element.classList.add('book-dragging'); document.body.classList.add('sorting-book');
  }
  drag.ghost.style.left = `${Math.max(0, Math.min(event.clientX + 18, innerWidth - 150))}px`;
  drag.ghost.style.top = `${Math.max(0, Math.min(event.clientY + 18, innerHeight - 180))}px`;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-category-drop]');
  const id = target?.dataset.categoryDrop || null;
  document.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
  if (target && id !== drag.book.categoryId) target.classList.add('drop-target');
  drag.ghost.querySelector('.drag-label').textContent = !target ? '拖到分类 · Esc 取消'
    : id === drag.book.categoryId ? '已在这个分类中' : `松开移到${categories.find(item => item.id === id)?.name || '未分类'}`;
  const scroll = document.querySelector('.sidebar-scroll');
  const rect = scroll.getBoundingClientRect();
  if (event.clientX >= rect.left && event.clientX < rect.right) {
    if (event.clientY < rect.top + 26) scroll.scrollBy(0, -14);
    else if (event.clientY > rect.bottom - 26) scroll.scrollBy(0, 14);
  }
});
document.addEventListener('pointerup', event => {
  const drag = rightDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const target = drag.ghost && document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-category-drop]');
  cancelRightDrag();
  if (target) run(() => moveWithUndo(drag.book, target.dataset.categoryDrop || null));
});
document.addEventListener('pointercancel', cancelRightDrag);
document.addEventListener('contextmenu', event => {
  if (rightDrag || Date.now() < suppressContextUntil || event.target.closest('.book-open')) event.preventDefault();
});
window.addEventListener('blur', cancelRightDrag);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && rightDrag) { event.preventDefault(); cancelRightDrag(); } });
async function refreshShelf() {
  const state = await api.list();
  speech.configure(state.voiceSettings);
  settings = state.settings;
  categories = state.categories;
  if (!['all', 'uncategorized'].includes(selectedCategory) && !categories.some(category => category.id === selectedCategory)) selectedCategory = 'all';
  books = state.books.sort((a, b) => (b.lastReadAt || b.importedAt).localeCompare(a.lastReadAt || a.importedAt));
  const filtered = books.filter(book => selectedCategory === 'all' || (selectedCategory === 'uncategorized' ? !book.categoryId : book.categoryId === selectedCategory));
  const title = selectedCategory === 'all' ? '全部书籍' : selectedCategory === 'uncategorized' ? '未分类' : categories.find(category => category.id === selectedCategory).name;
  $('shelf-title').textContent = selectedCategory === 'all' ? '我的书架' : title;
  $('section-title').textContent = title;
  $('book-count').textContent = filtered.length;
  $('sidebar-count').textContent = books.length;
  $('shelf-subtitle').textContent = filtered.length ? `${filtered.length} 本书，${filtered.filter(book => book.lastReadAt).length} 段正在继续的旅程。` : '从一本书开始，慢慢读。';
  $('empty-state').hidden = books.length > 0 || selectedCategory !== 'all';
  $('category-empty').hidden = filtered.length > 0 || (selectedCategory === 'all' && books.length === 0);
  renderCategories();
  const recent = filtered.find(book => book.lastReadAt);
  $('continue-section').hidden = !recent;
  if (recent) {
    $('continue-cover').replaceChildren(bookCover(recent, books.indexOf(recent)));
    $('continue-title').textContent = recent.title;
    $('continue-detail').textContent = `${recent.author} · 上次读到第 ${recent.progress.chapter + 1} 节 · 约 ${percent(recent)}%`;
    $('continue-button').onclick = () => run(() => openBook(recent.id));
  }
  $('book-grid').replaceChildren();
  filtered.forEach(book => {
    const index = books.indexOf(book);
    const card = document.createElement('article'); card.className = 'book-card';
    const open = document.createElement('button'); open.className = 'book-open';
    open.dataset.bookId = book.id;
    open.ondragstart = event => event.preventDefault();
    open.setAttribute('aria-label', `阅读 ${book.title}`); open.onclick = () => run(() => openBook(book.id));
    const cover = bookCover(book, index);
    const title = document.createElement('h3'); title.textContent = book.title;
    const author = document.createElement('p'); author.className = 'book-author'; author.textContent = book.author;
    const progress = document.createElement('div'); progress.className = 'book-progress';
    const track = document.createElement('div'); track.className = 'progress-track';
    const fill = document.createElement('div'); fill.className = 'progress-fill'; fill.style.width = `${percent(book)}%`; track.append(fill);
    const label = document.createElement('span'); label.textContent = book.lastReadAt ? `约 ${percent(book)}%` : '未开始';
    progress.append(track, label); open.append(cover, title, author, progress);
    const remove = document.createElement('button'); remove.className = 'remove-book'; remove.textContent = '×';
    remove.setAttribute('aria-label', `移除 ${book.title}`);
    remove.onclick = () => { pendingDelete = book.id; $('delete-description').textContent = book.title; $('delete-dialog').showModal(); };
    const organize = document.createElement('button'); organize.className = 'organize-book'; organize.textContent = '⋯';
    organize.setAttribute('aria-label', `整理 ${book.title}`); organize.title = '移动到分类';
    organize.onclick = () => { movingBook = book.id; $('move-book-title').textContent = book.title; $('move-error').textContent = ''; categoryOptions($('move-category'), book.categoryId); $('move-dialog').showModal(); };
    card.append(open, remove, organize); $('book-grid').append(card);
  });
  syncSettingsControls();
}
function doc() { return $('book-frame').contentDocument; }
function progressUi() {
  if (!current || !position) return;
  const approximate = Math.round((chapterIndex + position.ratio) / current.chapters.length * 100);
  $('reading-progress').textContent = `第 ${chapterIndex + 1} / ${current.chapters.length} 节 · 本章 ${Math.round(position.ratio * 100)}% · 全书约 ${approximate}%`;
}
function queueSave(action) {
  const operation = pendingSaves.then(action).then(() => { failedSave = null; });
  pendingSaves = operation.catch(error => {
    failedSave = error; $('save-status').textContent = '保存失败，请重试'; toast(error.message, true);
  });
  return operation;
}
function saveCurrent() {
  clearTimeout(saveTimer);
  if (!current || !position) return pendingSaves;
  const id = current.id;
  const savedPosition = { ...position };
  $('save-status').textContent = '正在保存…';
  return queueSave(async () => {
    await api.saveProgress(id, savedPosition);
    $('save-status').textContent = '进度已保存';
  });
}
async function flush() {
  await companion.flush();
  if (current && doc()?.querySelector('article') && !busy && !suppressScroll) position = content.location(doc(), chapterIndex);
  await saveCurrent();
  if (failedSave) throw failedSave;
}
function onScroll() {
  if (suppressScroll || busy || !current) return;
  position = content.location(doc(), chapterIndex);
  progressUi();
  $('save-status').textContent = '正在保存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => run(saveCurrent), 220);
}
function renderToc() {
  $('toc-list').replaceChildren();
  $('chapter-count').textContent = `${current.chapters.length} 节`;
  for (const item of current.toc) {
    const button = document.createElement('button'); button.className = 'toc-item';
    button.textContent = item.label; button.style.paddingLeft = `${11 + Math.min(4, item.depth) * 14}px`;
    button.dataset.chapter = item.chapter;
    button.onclick = () => run(() => openChapter(item.chapter, null, item.fragment, true));
    $('toc-list').append(button);
  }
}
function updateChapterUi() {
  $('chapter-title').textContent = current.chapters[chapterIndex].label;
  $('previous-chapter').disabled = chapterIndex === 0;
  $('next-chapter').disabled = chapterIndex === current.chapters.length - 1;
  for (const button of $('toc-list').children) {
    const selected = Number(button.dataset.chapter) === chapterIndex;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
  }
  progressUi();
}
async function settleLayout() {
  const document = doc();
  await document.fonts.ready;
  await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function openChapter(index, saved = null, fragment = '', remember = false, match = null, fromSpeech = false) {
  if (busy || !current) return;
  if (!fromSpeech) speech.stop();
  notes.hide();
  const speechVersion = speech.version;
  if (position) position = content.location(doc(), chapterIndex);
  const origin = position && { ...position };
  busy = true;
  suppressScroll = true;
  $('chapter-loading').hidden = false;
  try {
    if (position) await flush();
    const chapter = await api.chapter(current.id, index);
    if (fromSpeech && (!speech.active || speech.version !== speechVersion)) return false;
    const html = content.build(chapter.html, current.id, chapter.path, settings, index === current.chapters.length - 1);
    await new Promise(resolve => { $('book-frame').onload = resolve; $('book-frame').srcdoc = html; });
    chapterIndex = index;
    await settleLayout();
    if (fragment) doc().getElementById(fragment)?.scrollIntoView();
    else if (saved) content.restore(doc(), saved);
    else doc().defaultView.scrollTo(0, 0);
    if (searchQuery) {
      const range = content.highlight(doc(), searchQuery, match);
      if (range && match) doc().defaultView.scrollBy(0, range.getBoundingClientRect().top - 40);
    }
    position = content.location(doc(), chapterIndex);
    doc().defaultView.addEventListener('scroll', onScroll, { passive: true });
    doc().addEventListener('click', event => {
      const anchor = event.target.closest?.('a');
      if (!anchor) return;
      event.preventDefault();
      const targetPath = anchor.dataset.readerPath;
      const targetFragment = anchor.dataset.readerFragment;
      const target = current.chapters.findIndex(item => item.path === targetPath);
      if (target >= 0) run(() => openChapter(target, null, targetFragment, true));
      else if (targetPath) toast('这个链接指向正文以外的资源，第一版暂不支持打开。');
    });
    doc().addEventListener('keydown', onKeydown);
    speech.attach(doc());
    notes.attach(doc());
    updateChapterUi();
    await saveCurrent();
    if (remember && origin) { navigationHistory.push(origin); if (navigationHistory.length > 50) navigationHistory.shift(); }
    $('return-position-button').disabled = !navigationHistory.length;
    return true;
  } finally {
    busy = false;
    $('chapter-loading').hidden = true;
    requestAnimationFrame(() => { suppressScroll = false; });
  }
}
async function openBook(id) {
  if (busy) return;
  companion.close();
  busy = true;
  try { current = await api.openBook(id); }
  finally { busy = false; }
  settings = { ...settings, fontFamily: current.fontFamily || settings.fontFamily };
  syncSettingsControls();
  position = null;
  navigationHistory = []; searchGeneration++; searchQuery = '';
  $('return-position-button').disabled = true;
  closeTools();
  $('search-input').value = ''; $('search-results').replaceChildren();
  $('search-status').textContent = '输入关键词，搜索全部章节。';
  $('reader-title').textContent = current.title;
  $('shelf-view').hidden = true; $('reader-view').hidden = false;
  $('settings-panel').hidden = true; $('settings-button').setAttribute('aria-expanded', 'false');
  renderToc();
  renderBookmarks();
  notes.render(); applyBackground();
  try { await openChapter(current.progress.chapter, current.progress); }
  catch (error) {
    current = null; position = null;
    $('reader-view').hidden = true; $('shelf-view').hidden = false;
    throw error;
  }
}
async function shelf() {
  if (busy) return;
  companion.close();
  speech.stop();
  notes.hide();
  await flush();
  searchGeneration++;
  setQuiet(false);
  closeTools();
  if (fullscreen) await api.setFullscreen(false);
  current = null; position = null;
  clearTimeout(resizeTimer); suppressScroll = false;
  $('reader-view').hidden = true; $('shelf-view').hidden = false;
  $('book-frame').srcdoc = '';
  await refreshShelf();
}
async function importBook(example = false, categoryId = null) {
  if (busy) return;
  busy = true; $('import-button').disabled = true; $('example-button').disabled = true;
  try {
    const result = await (example ? api.importExample(categoryId) : api.importBook(categoryId));
    if (!result) return;
    await refreshShelf();
    toast(result.duplicate ? '这本书已在书架中。' : '已添加到书架，开始阅读吧。');
  } finally { busy = false; $('import-button').disabled = false; $('example-button').disabled = false; }
}
function dropCategory() {
  return categories.some(category => category.id === selectedCategory) ? selectedCategory : null;
}
async function importDropped(paths) {
  if (busy || current) return;
  const files = [...new Set(paths)].slice(0, 20);
  if (!files.length) return;
  busy = true;
  let added = 0; let duplicates = 0; const failures = [];
  try {
    for (const filename of files) {
      try {
        const result = await api.importFilePath(filename, dropCategory());
        if (result.duplicate) duplicates++; else added++;
      } catch (error) {
        const label = filename.split(/[\\/]/).pop() || filename;
        failures.push(`${label}：${error.message}`);
      }
    }
    await refreshShelf();
    if (failures.length) toast(`${added ? `已导入 ${added} 本。` : ''}${duplicates ? `已有 ${duplicates} 本。` : ''} ${failures.join('；')}`.trim(), true);
    else toast(duplicates ? `已导入 ${added} 本，${duplicates} 本已在书架中。` : `已导入 ${added} 本 EPUB。`);
  } finally { busy = false; }
}
let externalDropDepth = 0;
function clearExternalDrop() {
  externalDropDepth = 0; $('shelf-view').classList.remove('file-drop-active'); $('drop-overlay').hidden = true;
}
function hasEpubDrop(dataTransfer) {
  const files = [...(dataTransfer?.files || [])];
  if (files.some(file => /\.epub$/i.test(file?.name || ''))) return true;
  const items = [...(dataTransfer?.items || [])];
  return items.some(item => {
    if (item.kind !== 'file') return false;
    const file = item.getAsFile?.();
    return /\.epub$/i.test(file?.name || '') || /epub/i.test(item.type || '');
  });
}
document.addEventListener('dragenter', event => {
  if ($('shelf-view').hidden || !hasEpubDrop(event.dataTransfer)) return;
  event.preventDefault(); externalDropDepth++;
  $('shelf-view').classList.add('file-drop-active'); $('drop-overlay').hidden = false;
});
document.addEventListener('dragover', event => {
  if ($('shelf-view').hidden || !hasEpubDrop(event.dataTransfer)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', event => {
  if ($('shelf-view').hidden || !externalDropDepth) return;
  if (!event.relatedTarget) clearExternalDrop();
});
document.addEventListener('drop', event => {
  if ($('shelf-view').hidden) return;
  event.preventDefault(); clearExternalDrop();
  const paths = [...(event.dataTransfer?.files || [])].map(file => api.filePath(file)).filter(filename => /\.epub$/i.test(filename));
  if (!paths.length) {
    if (hasEpubDrop(event.dataTransfer)) toast('无法读取拖入的 EPUB 文件路径，请改用“导入 EPUB”按钮。', true);
    return;
  }
  run(() => importDropped(paths));
});
window.addEventListener('blur', clearExternalDrop);
function syncSettingsControls() {
  $('font-family').value = settings.fontFamily;
  $('paragraph-gap').value = settings.paragraphGap; $('paragraph-gap-value').textContent = `${settings.paragraphGap.toFixed(1)} 倍字号`;
  $('font-size').value = settings.fontSize; $('font-size-value').textContent = `${settings.fontSize} px`;
  $('line-height').value = settings.lineHeight; $('line-height-value').textContent = settings.lineHeight.toFixed(1);
  $('reading-width').value = settings.width; $('reading-width-value').textContent = `${settings.width} px`;
  $('reading-background').value = settings.background; $('background-tint').value = settings.tint;
  $('background-tint-value').textContent = `${Math.round(settings.tint * 100)}%`;
}
function applyBackground() {
  const color = content.background(settings);
  $('reading-area').style.background = color;
  $('reader-view').style.background = `linear-gradient(135deg, ${color}, #f4f7f8)`;
}
async function applySettings(next) {
  if (busy) return;
  const book = current;
  const activeDoc = book && doc();
  const anchor = book ? (suppressScroll && position ? { ...position } : content.location(activeDoc, chapterIndex)) : null;
  const version = ++layoutVersion;
  settings = next;
  syncSettingsControls();
  applyBackground();
  if (book) {
    layoutPending = true;
    suppressScroll = true;
    activeDoc.head.querySelector('style').textContent = content.styles(settings);
  }
  try {
    await queueSave(() => api.saveSettings(next, book?.id || null));
    if (book) {
      book.fontFamily = next.fontFamily;
      const family = { serif: 'ReaderSerif', sans: 'ReaderSans', wenkai: 'ReaderWenKai' }[next.fontFamily];
      if (family) await activeDoc.fonts.load(`${next.fontSize}px "${family}"`, '阅读 Anna');
      await activeDoc.fonts.ready;
      if (version !== layoutVersion || current !== book || doc() !== activeDoc) return;
      content.restore(activeDoc, anchor);
      position = content.location(activeDoc, chapterIndex);
      progressUi();
      await saveCurrent();
    }
  } finally {
    if (version === layoutVersion) {
      layoutPending = false;
      if (!book || (current === book && doc() === activeDoc)) requestAnimationFrame(() => { suppressScroll = false; });
    }
  }
}
function preserveOnResize() {
  if (!current || busy || !position || layoutPending) return;
  const anchor = { ...position };
  suppressScroll = true;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (current && !busy) {
      content.restore(doc(), anchor); position = content.location(doc(), chapterIndex); progressUi();
      run(saveCurrent);
    }
    requestAnimationFrame(() => { suppressScroll = false; });
  }, 100);
}
function setQuiet(enabled) {
  if (!current || quiet === enabled) return;
  if (!busy && !layoutPending) {
    if (!suppressScroll) position = content.location(doc(), chapterIndex);
    preserveOnResize();
  }
  clearTimeout(quietHideTimer);
  quiet = enabled;
  $('reader-view').classList.toggle('quiet-reading', enabled);
  $('reader-view').classList.remove('quiet-controls');
  $('quiet-button').setAttribute('aria-pressed', String(enabled));
  $('quiet-button').setAttribute('aria-label', enabled ? '退出安静阅读' : '安静阅读');
  $('toc-button').setAttribute('aria-expanded', String(!enabled && !$('toc-panel').hidden));
  if (enabled) {
    companion.close(); closeTools(); speech.panel(false); notes.hide(); doc().getSelection()?.removeAllRanges();
    $('settings-panel').hidden = true; $('settings-button').setAttribute('aria-expanded', 'false');
    doc().defaultView.focus();
    toast('安静阅读 · 鼠标移到上下边缘显示工具，Esc 退出。');
  } else $('quiet-button').focus({ preventScroll: true });
}
function revealQuietControls() {
  if (!quiet) return;
  clearTimeout(quietHideTimer);
  $('reader-view').classList.add('quiet-controls');
}
function hideQuietControls() {
  clearTimeout(quietHideTimer);
  if (!quiet) return;
  quietHideTimer = setTimeout(() => {
    const focused = document.activeElement;
    if (focused?.matches(':focus-visible') && focused.closest('.reader-toolbar, .reader-footer, #speech-toggle, #speech-follow')) return;
    $('reader-view').classList.remove('quiet-controls');
  }, 240);
}
for (const node of document.querySelectorAll('.quiet-edge, .reader-toolbar, .reader-footer, #speech-toggle, #speech-follow')) {
  node.addEventListener('pointerenter', revealQuietControls);
  node.addEventListener('pointerleave', hideQuietControls);
  node.addEventListener('focusin', revealQuietControls);
  node.addEventListener('focusout', hideQuietControls);
}
$('book-frame').addEventListener('pointerenter', hideQuietControls);
window.addEventListener('blur', hideQuietControls);
$('speech-toggle').addEventListener('click', () => setQuiet(false), { capture: true });
$('quiet-button').onclick = () => setQuiet(!quiet);
function closeTools() {
  $('tools-panel').hidden = true;
  $('bookmarks-button').setAttribute('aria-expanded', 'false');
  $('search-button').setAttribute('aria-expanded', 'false');
  $('notes-button').setAttribute('aria-expanded', 'false');
}
function showTools(kind) {
  if (!current || busy) return;
  setQuiet(false);
  $('settings-panel').hidden = true;
  $('settings-button').setAttribute('aria-expanded', 'false');
  $('tools-panel').hidden = false;
  $('bookmark-tools').hidden = kind !== 'bookmarks';
  $('search-tools').hidden = kind !== 'search';
  $('note-tools').hidden = kind !== 'notes';
  $('tools-title').textContent = { bookmarks: '书签', search: '书内搜索', notes: '摘录与笔记' }[kind];
  $('bookmarks-button').setAttribute('aria-expanded', String(kind === 'bookmarks'));
  $('search-button').setAttribute('aria-expanded', String(kind === 'search'));
  $('notes-button').setAttribute('aria-expanded', String(kind === 'notes'));
  if (kind === 'search') $('search-input').focus();
  else if (kind === 'notes') notes.render(); else renderBookmarks();
}
function resultButton(label, excerpt) {
  const button = document.createElement('button'); button.className = 'reading-result';
  const title = document.createElement('small'); title.textContent = label;
  const summary = document.createElement('span'); summary.textContent = excerpt || '阅读位置';
  button.append(title, summary);
  return button;
}
function renderBookmarks() {
  $('bookmark-list').replaceChildren();
  const bookmarks = current?.bookmarks || [];
  $('bookmark-status').textContent = bookmarks.length ? `已保存 ${bookmarks.length} 个书签。` : '还没有书签，可以先保存当前阅读位置。';
  for (const bookmark of bookmarks) {
    const row = document.createElement('div'); row.className = 'bookmark-entry';
    const button = resultButton(current.chapters[bookmark.progress.chapter].label, bookmark.excerpt);
    button.onclick = () => run(async () => { closeTools(); await openChapter(bookmark.progress.chapter, bookmark.progress, '', true); });
    const remove = document.createElement('button'); remove.className = 'delete-bookmark'; remove.textContent = '×';
    remove.setAttribute('aria-label', '删除书签');
    remove.onclick = () => run(async () => {
      const book = current;
      await queueSave(() => api.removeBookmark(book.id, bookmark.id));
      book.bookmarks = book.bookmarks.filter(item => item.id !== bookmark.id);
      if (current === book) renderBookmarks();
    });
    row.append(button, remove); $('bookmark-list').append(row);
  }
}
async function addBookmark() {
  if (busy || !current) return;
  const book = current;
  const progress = content.location(doc(), chapterIndex);
  const value = { progress, excerpt: content.excerpt(doc(), progress) };
  $('add-bookmark').disabled = true;
  try {
    let bookmark;
    await queueSave(async () => { bookmark = await api.addBookmark(book.id, value); });
    if (!book.bookmarks.some(item => item.id === bookmark.id)) book.bookmarks.push(bookmark);
    if (current === book) { renderBookmarks(); toast('已保存书签。'); }
  } finally { $('add-bookmark').disabled = false; }
}
async function searchBook() {
  if (!current || busy) return;
  const generation = ++searchGeneration;
  const book = current;
  const query = $('search-input').value.trim();
  searchQuery = query;
  $('search-results').replaceChildren();
  if (!query) {
    $('search-status').textContent = '请输入要查找的关键词。';
    content.highlight(doc(), ''); return;
  }
  let count = 0;
  try {
    for (let index = 0; index < book.chapters.length; index++) {
      $('search-status').textContent = `正在搜索第 ${index + 1} / ${book.chapters.length} 节…`;
      const chapter = await api.chapter(book.id, index);
      if (generation !== searchGeneration || current !== book) return;
      for (const hit of content.search(chapter.html, query, 200 - count)) {
        count++;
        const button = resultButton(chapter.label, hit.excerpt);
        button.onclick = () => run(async () => {
          closeTools();
          await openChapter(index, { chapter: index, block: hit.block, ratio: .001, offset: 0 }, '', true, hit);
        });
        $('search-results').append(button);
      }
      // shortcut: cap visible matches at 200; add pagination if real books need more.
      if (count >= 200) break;
    }
    if (generation !== searchGeneration || current !== book) return;
    $('search-status').textContent = count >= 200 ? '显示前 200 处匹配，可缩短范围或更换关键词。'
      : count ? `找到 ${count} 处匹配。` : '没有找到匹配内容。';
    if (!busy && doc()?.querySelector('article')) content.highlight(doc(), query);
  } catch (error) {
    if (generation !== searchGeneration || current !== book) return;
    $('search-status').textContent = '搜索未完成，请重试。';
    throw error;
  }
}
function onKeydown(event) {
  if (!current || $('delete-dialog').open) return;
  if (event.key === 'F11') { event.preventDefault(); run(() => api.setFullscreen(!fullscreen)); return; }
  if (event.key === 'Escape') {
    if (quiet && document.querySelector('dialog[open]')) return;
    if (quiet) {
      event.preventDefault(); setQuiet(false); return;
    }
    companion.close();
    closeTools();
    if (fullscreen) run(() => api.setFullscreen(false));
    else speech.panel(false);
  }
  if (event.target.matches?.('input,select,textarea')) return;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'q') {
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault(); setQuiet(!quiet); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); showTools('search'); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); run(addBookmark); return; }
  if (event.key === 'Escape') {
    $('settings-panel').hidden = true; $('settings-button').setAttribute('aria-expanded', 'false');
  }
  if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const index = chapterIndex + (event.key === 'ArrowRight' ? 1 : -1);
    if (index >= 0 && index < current.chapters.length) { event.preventDefault(); run(() => openChapter(index)); }
  }
}
$('import-button').onclick = () => {
  if (!categories.length) { run(() => importBook()); return; }
  categoryOptions($('import-category'), categories.some(category => category.id === selectedCategory) ? selectedCategory : null);
  $('import-dialog').showModal();
};
$('example-button').onclick = () => run(() => importBook(true));
$('all-books-button').onclick = () => selectCategory('all');
$('uncategorized-button').onclick = () => selectCategory('uncategorized');
$('new-folder-button').onclick = () => editCategory();
$('cancel-folder').onclick = () => $('folder-dialog').close();
$('folder-form').onsubmit = async event => {
  event.preventDefault(); $('save-folder').disabled = true; $('folder-error').textContent = '';
  try {
    await api.saveCategory(editingCategory, $('folder-name').value);
    $('folder-dialog').close(); await refreshShelf();
  } catch (error) { $('folder-error').textContent = error.message; }
  finally { $('save-folder').disabled = false; }
};
$('cancel-delete-folder').onclick = () => $('delete-folder-dialog').close();
$('confirm-delete-folder').onclick = async () => {
  $('confirm-delete-folder').disabled = true;
  try {
    await api.removeCategory(deletingCategory);
    if (selectedCategory === deletingCategory) selectedCategory = 'uncategorized';
    $('delete-folder-dialog').close(); await refreshShelf(); toast('已删除分类，书籍和阅读记录都已保留。');
  } catch (error) { $('delete-folder-error').textContent = error.message; }
  finally { $('confirm-delete-folder').disabled = false; }
};
$('cancel-move').onclick = () => $('move-dialog').close();
$('confirm-move').onclick = async () => {
  $('confirm-move').disabled = true;
  try {
    await moveWithUndo(books.find(book => book.id === movingBook), $('move-category').value || null);
    $('move-dialog').close();
  } catch (error) { $('move-error').textContent = error.message; }
  finally { $('confirm-move').disabled = false; }
};
$('cancel-import').onclick = () => $('import-dialog').close();
$('confirm-import').onclick = () => {
  const id = $('import-category').value || null;
  $('import-dialog').close(); run(() => importBook(false, id));
};
$('back-button').onclick = () => run(shelf);
$('previous-chapter').onclick = () => run(() => openChapter(chapterIndex - 1));
$('next-chapter').onclick = () => run(() => openChapter(chapterIndex + 1));
$('notes-button').onclick = () => showTools('notes');
$('ai-open-reader').onclick = () => run(async () => {
  const value = current?.annotations.filter(item => item.discussion?.length || item.isExcerpt === false).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  await companion.open(current, value || null);
});
$('bookmarks-button').onclick = () => showTools('bookmarks');
$('search-button').onclick = () => showTools('search');
$('close-tools').onclick = closeTools;
$('add-bookmark').onclick = () => run(addBookmark);
$('search-form').onsubmit = event => { event.preventDefault(); run(searchBook); };
$('search-input').oninput = () => {
  searchGeneration++;
  $('search-status').textContent = '按 Enter 搜索新关键词。';
};
$('return-position-button').onclick = () => run(async () => {
  if (busy || !navigationHistory.length) return;
  closeTools();
  const target = navigationHistory.at(-1);
  if (await openChapter(target.chapter, target)) navigationHistory.pop();
  $('return-position-button').disabled = !navigationHistory.length;
});
$('fullscreen-button').onclick = () => run(() => api.setFullscreen(!fullscreen));
api.onFullscreenChanged(enabled => {
  fullscreen = enabled;
  speech.fullscreenChanged(enabled);
  if (quiet) speech.panel(false);
  $('fullscreen-label').textContent = enabled ? '退出全屏' : '全屏';
  $('fullscreen-button').setAttribute('aria-label', enabled ? '退出全屏' : '全屏');
  $('fullscreen-button').title = enabled ? '退出全屏（Esc / F11）' : '全屏（F11）';
  $('fullscreen-button').setAttribute('aria-pressed', String(enabled));
  preserveOnResize();
});
$('toc-button').onclick = () => {
  if (quiet) { setQuiet(false); $('toc-panel').hidden = false; }
  else $('toc-panel').hidden = !$('toc-panel').hidden;
  $('toc-button').setAttribute('aria-expanded', String(!$('toc-panel').hidden)); preserveOnResize();
};
$('settings-button').onclick = () => { setQuiet(false); closeTools(); $('settings-panel').hidden = !$('settings-panel').hidden;
  $('settings-button').setAttribute('aria-expanded', String(!$('settings-panel').hidden)); };
$('close-settings').onclick = () => { $('settings-panel').hidden = true; $('settings-button').setAttribute('aria-expanded', 'false'); };
function settingsFromControls() {
  return { fontSize: Number($('font-size').value), lineHeight: Number($('line-height').value), width: Number($('reading-width').value),
    paragraphGap: Number($('paragraph-gap').value), fontFamily: $('font-family').value, background: $('reading-background').value, tint: Number($('background-tint').value) };
}
for (const id of ['font-size', 'line-height', 'reading-width', 'paragraph-gap', 'background-tint']) $(id).oninput = () => run(() => applySettings(settingsFromControls()));
$('reading-background').onchange = () => run(() => applySettings(settingsFromControls()));
$('font-family').onchange = () => run(() => applySettings(settingsFromControls()));
$('reset-settings').onclick = () => run(() => applySettings({ fontSize: 20, lineHeight: 1.9, width: 760, paragraphGap: 1.2, fontFamily: 'system', background: 'white', tint: .6 }));
$('cancel-delete').onclick = () => $('delete-dialog').close();
$('confirm-delete').onclick = () => run(async () => {
  $('confirm-delete').disabled = true;
  try { await api.removeBook(pendingDelete); $('delete-dialog').close(); await refreshShelf(); toast('已从书架移除，原始文件仍保留。'); }
  finally { $('confirm-delete').disabled = false; }
});
window.addEventListener('resize', preserveOnResize);
let restoreToken = null; let backupBusy = false;
async function backupAction(action) {
  if (backupBusy) return;
  backupBusy = true; $('backup-error').textContent = ''; $('backup-status').textContent = '正在处理，请稍候…';
  for (const id of ['backup-export', 'backup-choose', 'backup-restore', 'backup-close']) $(id).disabled = true;
  try { await action(); }
  catch (error) { $('backup-status').textContent = ''; $('backup-error').textContent = error.message; }
  finally { backupBusy = false; for (const id of ['backup-export', 'backup-choose', 'backup-restore', 'backup-close']) $(id).disabled = false; }
}
$('backup-button').onclick = () => {
  speech.stop(); $('backup-error').textContent = ''; $('backup-status').textContent = '';
  $('restore-preview').hidden = true; restoreToken = null; $('backup-dialog').showModal();
};
$('backup-close').onclick = () => $('backup-dialog').close();
$('backup-dialog').addEventListener('cancel', event => { if (backupBusy) event.preventDefault(); });
$('backup-dialog').addEventListener('close', () => { restoreToken = null; api.cancelRestore().catch(() => {}); });
$('backup-export').onclick = () => backupAction(async () => {
  await flush(); const result = await api.exportBackup();
  $('backup-status').textContent = result ? `备份已保存，包含 ${result.books} 本书。` : '已取消导出。';
});
$('backup-choose').onclick = () => backupAction(async () => {
  $('restore-preview').hidden = true; restoreToken = null;
  const result = await api.previewBackup();
  if (!result) { $('backup-status').textContent = '已取消选择。'; return; }
  restoreToken = result.token;
  $('restore-summary').textContent = `备份包含 ${result.books} 本书（新增 ${result.newBooks} 本）、${result.bookmarks} 个书签、${result.annotations} 条摘录。`;
  $('restore-preview').hidden = false; $('backup-status').textContent = '检查后点击「确认合并恢复」。';
});
$('backup-restore').onclick = () => backupAction(async () => {
  const result = await api.restoreBackup(restoreToken); restoreToken = null;
  $('restore-preview').hidden = true; await refreshShelf();
  $('backup-status').textContent = `恢复完成：新增 ${result.added} 本书、${result.annotations} 条摘录。`;
});
document.addEventListener('keydown', onKeydown);
api.onOpenFile(({ id, title, duplicate } = {}) => run(async () => {
  if (!id) return;
  await refreshShelf(); await openBook(id);
  toast(duplicate ? `已打开《${title || '这本书'}》。` : `已导入并打开《${title || '这本书'}》。`);
}));
api.onOpenFileError(message => toast(message || '无法打开这个 EPUB 文件。', true));
api.onBeforeClose(async () => {
  speech.stop();
  companion.cancel();
  try { await flush(); api.closeReady(); }
  catch (error) { api.closeCancel(); toast(`进度未能保存，暂未关闭窗口：${error.message}`, true); }
});
run(refreshShelf);
