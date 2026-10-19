const { app, BrowserWindow, dialog, ipcMain, protocol, session, safeStorage, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Library } = require('./library');
const { Voice } = require('./voice');
const { Ai } = require('./ai');
const { exportBackup, readBackup, previewBackup, restoreBackup } = require('./backup');
const { exportNotes } = require('./notes-export');
const { randomUUID } = require('node:crypto');
const { ensureImageBudget, validateImage } = require('./ai-materials');
const { epubPathFromArgs } = require('./open-file');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'epub', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
app.setName('拾页');
app.setPath('userData', process.env.READINGTEXT_DATA
  ? path.resolve(process.env.READINGTEXT_DATA) : path.join(app.getPath('appData'), 'ReadingText'));
app.setAppUserModelId('com.readingtext.reader');
let window;
let library;
let voice;
let ai;
let pendingRestore;
let mayClose = false;
let waitingForClose = false;
let rendererReady = false;
let pendingOpenFiles = [epubPathFromArgs(process.argv)].filter(Boolean);
let openFileQueue = Promise.resolve();
const APP_URL = 'app://reader/index.html';

function focusWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

function queueOpenFile(filename) {
  if (!filename) return openFileQueue;
  openFileQueue = openFileQueue.then(async () => {
    if (!window || !library || !rendererReady) { pendingOpenFiles.push(filename); return; }
    try {
      const result = await library.importFile(filename);
      if (!window.isDestroyed()) window.webContents.send('library:open-file', { id: result.book.id, title: result.book.title, duplicate: result.duplicate });
    } catch (error) {
      if (!window.isDestroyed()) window.webContents.send('library:open-file-error', error.message || '无法打开这个 EPUB 文件。');
    }
  }).catch(() => {});
  return openFileQueue;
}

function authorized(event) {
  return window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === APP_URL;
}
function handle(name, action) {
  ipcMain.handle(name, async (event, ...args) => {
    if (!authorized(event)) throw new Error('访问被拒绝。');
    try { return { ok: true, data: await action(...args) }; }
    catch (error) {
      const message = error.code === 'ENOENT' ? '找不到电子书文件，请重新导入。'
        : ['EACCES', 'EPERM', 'EIO', 'EROFS', 'ENOSPC', 'EISDIR'].includes(error.code)
          ? '无法读写本地数据，请检查磁盘空间和文件夹权限后重试。' : error.message;
      return { ok: false, error: message || '操作未完成，请重试。' };
    }
  });
}

async function start() {
  library = new Library(app.getPath('userData'));
  await library.init();
  ai = new Ai(app.getPath('userData'), safeStorage,
    (url, options) => session.fromPartition('ai-service', { cache: false }).fetch(url, options),
    value => { if (window && !window.isDestroyed()) window.webContents.send('ai:delta', value); });
  await ai.init();
  voice = new Voice(path.join(process.env.READINGTEXT_VOICE_HOME || path.join(app.getPath('userData'), 'voices'), 'serena'),
    app.isPackaged ? path.join(process.resourcesPath, 'voice_worker.py') : path.join(__dirname, 'voice_worker.py'),
    state => { if (window && !window.isDestroyed()) window.webContents.send('voice:status-changed', state); },
    (url, options) => session.fromPartition('voice-download', { cache: false }).fetch(url, options),
    app.isPackaged ? path.join(process.resourcesPath, 'Serena-reference.wav') : path.join(__dirname, '../assets/voice/Serena-reference.wav'));
  const files = {
    '/index.html': ['ui/index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['ui/styles.css', 'text/css; charset=utf-8'],
    '/tools.css': ['ui/tools.css', 'text/css; charset=utf-8'],
    '/glass.css': ['ui/glass.css', 'text/css; charset=utf-8'],
    '/speech.css': ['ui/speech.css', 'text/css; charset=utf-8'],
    '/speech.js': ['ui/speech.js', 'text/javascript; charset=utf-8'],
    '/notes.js': ['ui/notes.js', 'text/javascript; charset=utf-8'],
    '/ai.js': ['ui/ai.js', 'text/javascript; charset=utf-8'],
    '/ai-images.js': ['ui/ai-images.js', 'text/javascript; charset=utf-8'],
    '/ai.css': ['ui/ai.css', 'text/css; charset=utf-8'],
    '/fonts/SourceHanSerifCN-Regular.otf': ['../assets/fonts/SourceHanSerifCN-Regular.otf', 'font/otf'],
    '/fonts/SourceHanSansCN-Regular.otf': ['../assets/fonts/SourceHanSansCN-Regular.otf', 'font/otf'],
    '/fonts/LXGWWenKaiScreen.ttf': ['../assets/fonts/LXGWWenKaiScreen.ttf', 'font/ttf'],
    '/renderer.js': ['ui/renderer.js', 'text/javascript; charset=utf-8'],
    '/reading.js': ['ui/reading.js', 'text/javascript; charset=utf-8'],
    '/purify.js': ['../node_modules/dompurify/dist/purify.min.js', 'text/javascript; charset=utf-8']
  };
  protocol.handle('app', async request => {
    const url = new URL(request.url);
    const item = url.hostname === 'reader' && files[url.pathname];
    if (!item) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(__dirname, item[0])), {
      headers: { 'Content-Type': item[1], 'X-Content-Type-Options': 'nosniff' }
    });
  });
  protocol.handle('epub', async request => {
    try {
      const url = new URL(request.url);
      const resource = decodeURIComponent(url.pathname.slice(1));
      const image = await library.image(url.hostname, resource);
      return new Response(image.bytes, { headers: {
        'Content-Type': image.mediaType, 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox"
      } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(app:|epub:|data:|about:)/.test(details.url) });
  });
  handle('library:list', () => library.snapshot());
  handle('library:import', async (categoryId = null) => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入 EPUB 电子书', filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return library.importFile(result.filePaths[0], categoryId);
  });
  handle('library:import-path', async (filename, categoryId = null) => {
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('找不到拖入的 EPUB 文件。');
    return library.importFile(filename, categoryId);
  });
  handle('library:example', (categoryId = null) => library.importFile(path.join(__dirname, '../assets/demo.epub'), categoryId));
  handle('category:save', (id, name) => library.saveCategory(id, name));
  handle('category:remove', id => library.removeCategory(id));
  handle('book:move', (id, categoryId) => library.moveBook(id, categoryId));
  handle('book:open', id => library.open(id));
  handle('book:chapter', (id, index) => library.chapter(id, index));
  handle('book:progress', (id, progress) => library.saveProgress(id, progress));
  handle('book:listening-position', (id, position) => library.saveListeningPosition(id, position));
  handle('book:remove', id => library.remove(id));
  handle('bookmark:add', (id, value) => library.addBookmark(id, value));
  handle('bookmark:remove', (id, bookmarkId) => library.removeBookmark(id, bookmarkId));
  handle('annotation:save', (id, value) => library.saveAnnotation(id, value));
  handle('annotation:remove', (id, annotationId) => library.removeAnnotation(id, annotationId));
  handle('notes:export', async (bookId, format = 'markdown') => {
    const book = await library.open(bookId);
    const extension = format === 'text' ? 'txt' : 'md';
    const safeTitle = book.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || '拾页摘录';
    const result = await dialog.showSaveDialog(window, {
      title: '导出摘录与笔记',
      defaultPath: `${safeTitle} - 摘录与笔记.${extension}`,
      filters: format === 'text'
        ? [{ name: '纯文本', extensions: ['txt'] }]
        : [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (result.canceled || !result.filePath) return null;
    return exportNotes(book, result.filePath, format);
  });
  handle('backup:export', async () => {
    const result = await dialog.showSaveDialog(window, { title: '导出拾页备份', defaultPath: '拾页书架备份.readingtext', filters: [{ name: '拾页备份', extensions: ['readingtext'] }] });
    if (result.canceled || !result.filePath) return null;
    return exportBackup(library, result.filePath);
  });
  handle('backup:preview', async () => {
    pendingRestore = null;
    const result = await dialog.showOpenDialog(window, { title: '选择拾页备份', filters: [{ name: '拾页备份', extensions: ['readingtext'] }], properties: ['openFile'] });
    if (result.canceled || !result.filePaths.length) return null;
    const backup = await readBackup(result.filePaths[0]);
    pendingRestore = { token: randomUUID(), backup };
    return { ...previewBackup(library, backup), token: pendingRestore.token };
  });
  handle('backup:restore', async token => {
    if (!pendingRestore || token !== pendingRestore.token || pendingRestore.applying) throw new Error('请重新选择需要恢复的备份。');
    const pending = pendingRestore; pending.applying = true;
    try {
      const result = await restoreBackup(library, pending.backup);
      if (pendingRestore === pending) pendingRestore = null;
      library.active = null; return result;
    } finally { pending.applying = false; }
  });
  handle('backup:cancel', () => { pendingRestore = null; });
  handle('settings:save', (settings, bookId) => library.saveSettings(settings, bookId));
  handle('voice:status', () => voice.status());
  handle('voice:install', () => voice.install());
  handle('voice:cancel-install', () => voice.cancelInstall());
  handle('voice:remove', () => voice.remove());
  handle('voice:choices', () => Object.entries(require('../assets/voice/voices.json')).map(([id, value]) => ({ id, name: value.name, description: value.description })));
  handle('voice:synthesize', (text, speaker) => voice.synthesize(text, speaker));
  handle('voice:stream', (text, style, speaker) => voice.openStream(text, style, speaker));
  handle('voice:stream-next', id => voice.readStream(id));
  handle('voice:warm', () => voice.start());
  handle('voice:settings', value => library.saveVoiceSettings(value));
  handle('voice:cancel', () => voice.cancel());
  handle('ai:status', () => ai.status());
  handle('ai:settings', value => { ai.cancel(); return ai.save(value); });
  handle('ai:models', draft => ai.models(draft));
  handle('ai:test', (id, key, model) => ai.test(id, key, model));
  handle('ai:cancel', () => ai.cancel());
  handle('ai:capture', async rect => {
    const frame = await window.webContents.executeJavaScript(`(() => { const frame = document.getElementById('book-frame'); const r = frame.getBoundingClientRect(); return document.getElementById('reader-view').hidden ? null : { x:r.x,y:r.y,width:r.width,height:r.height }; })()`);
    if (!frame || !rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.x < 0 || rect.y < 0 || rect.width < 16 || rect.height < 16 || rect.x + rect.width > frame.width + 1 || rect.y + rect.height > frame.height + 1) throw new Error('请在当前阅读区域内重新选择截图范围。');
    let image = await window.webContents.capturePage({ x: Math.round(frame.x + rect.x), y: Math.round(frame.y + rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) });
    let size = image.getSize(); const scale = Math.min(1, 1600 / Math.max(size.width, size.height));
    if (scale < 1) image = image.resize({ width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) });
    size = image.getSize(); let jpeg = image.toJPEG(75);
    if (jpeg.length > 500000) jpeg = image.toJPEG(40);
    const result = { dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'), ...size };
    return validateImage(result);
  });
  handle('ai:ask', (requestId, bookId, annotationId, question, replaceId = null, image = null) => {
    const book = structuredClone(library.book(bookId));
    const annotation = book.annotations.find(item => item.id === annotationId);
    if (!annotation) throw new Error('这条摘录已不存在。');
    let replaced = null;
    if (replaceId !== null) {
      const last = annotation.discussion.at(-1);
      if (!last || last.id !== replaceId) throw new Error('只能重新生成当前最后一条回答，请重新打开讨论。');
      question = last.question; image = last.image || null; replaced = image; annotation.discussion.pop();
    }
    if (image) image = validateImage(image);
    ensureImageBudget(library.state, image, replaced);
    return ai.ask(requestId, book, annotation, question, image);
  });
  handle('ai:save-turn', (bookId, annotationId, turn, replaceId) => library.appendDiscussion(bookId, annotationId, turn, replaceId));
  handle('ai:trim', (bookId, annotationId, fromId, expectedLastId) => library.trimDiscussion(bookId, annotationId, fromId, expectedLastId));
  handle('ai:copy', (bookId, annotationId, turnId) => {
    const book = library.book(bookId); const turn = book.annotations.find(item => item.id === annotationId)?.discussion.find(item => item.id === turnId);
    if (!turn) throw new Error('这条回答已不存在。');
    const sources = turn.sources?.length ? '\n\n原文依据（《' + book.title + '》）：\n' + turn.sources.map((source, index) => `[原文 ${index + 1}] 第 ${source.chapter + 1} 节：${source.quote}`).join('\n') : '';
    clipboard.writeText(turn.answer + sources);
  });
  handle('window:fullscreen', enabled => {
    if (typeof enabled !== 'boolean') throw new Error('全屏设置无效。');
    window.setFullScreen(enabled);
  });
  ipcMain.on('window:close-ready', async event => {
    if (!authorized(event) || !waitingForClose) return;
    await library.queue;
    ai.cancel(); await ai.queue;
    voice.cancelInstall();
    await voice.shutdown();
    mayClose = true;
    window.close();
  });
  ipcMain.on('window:close-cancel', event => { if (authorized(event)) waitingForClose = false; });
  window = new BrowserWindow({
    width: 1280, height: 880, minWidth: 900, minHeight: 640, show: false,
    title: '拾页 · EPUB 阅读器', backgroundColor: '#faf9f6',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false,
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false }
  });
  window.setMenu(null);
  window.on('enter-full-screen', () => window.webContents.send('window:fullscreen-changed', true));
  window.on('leave-full-screen', () => window.webContents.send('window:fullscreen-changed', false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event, url) => {
    const target = event.url || url;
    if (target !== APP_URL && target !== 'about:srcdoc' && target !== 'about:blank') event.preventDefault();
  });
  window.on('close', event => {
    if (mayClose) return;
    event.preventDefault();
    if (!waitingForClose) {
      waitingForClose = true;
      window.webContents.send('window:before-close');
    }
  });
  await window.loadURL(APP_URL);
  rendererReady = true;
  window.show();
  const startupFiles = pendingOpenFiles.splice(0);
  for (const filename of startupFiles) queueOpenFile(filename);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, commandLine) => {
    focusWindow();
    const filename = epubPathFromArgs(commandLine);
    if (filename) queueOpenFile(filename);
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('无法启动拾页', `${error.message}\n\n本地数据位置：${app.getPath('userData')}`);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
}
