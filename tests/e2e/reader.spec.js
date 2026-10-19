const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const { makeEpub } = require('../fixtures');
const ROOT = path.resolve(__dirname, '../..');
let application;
let page;
let directory;
let errors;

async function launch(extraArgs = []) {
  const executablePath = process.env.READINGTEXT_EXECUTABLE;
  application = await electron.launch({ executablePath, args: executablePath ? extraArgs : [ROOT, ...extraArgs],
    env: { ...process.env, READINGTEXT_DATA: directory } });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect.poll(async () => await page.locator('#import-button').isVisible() || await page.locator('#reader-view').isVisible()).toBe(true);
}
async function example() {
  await page.locator('#example-button').click();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.locator('.book-open').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#save-status')).toHaveText('进度已保存');
  // Chapter loading clears scroll suppression on the following animation frame.
  await expect.poll(() => page.evaluate(() => !busy && !suppressScroll)).toBe(true);
}
async function chooseFile(filename, categoryName) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, filename);
  await page.locator('#import-button').click();
  if (await page.locator('#import-dialog').isVisible()) {
    if (categoryName) await page.locator('#import-category').selectOption({ label: categoryName });
    await page.locator('#confirm-import').click();
  }
}
async function createCategory(name) {
  await page.locator('#new-folder-button').click();
  await page.locator('#folder-name').fill(name);
  await page.locator('#save-folder').click();
  await expect(page.getByRole('button', { name: `打开分类 ${name}`, exact: true })).toBeVisible();
}
async function dropFiles(files) {
  const session = await page.context().newCDPSession(page);
  const bounds = await page.locator('#book-grid').boundingBox();
  const data = { items: [], files, dragOperationsMask: 1 };
  const point = { x: bounds.x + 20, y: bounds.y + 10, data };
  try {
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point });
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...point });
    await expect(page.locator('#drop-overlay')).toBeVisible();
    await session.send('Input.dispatchDragEvent', { type: 'drop', ...point });
    await expect(page.locator('#drop-overlay')).toBeHidden();
  } finally { await session.detach(); }
}
async function dragBook(target, cancel = false) {
  const book = page.locator('.book-open').first(); await book.scrollIntoViewIfNeeded();
  const source = await book.boundingBox(); const destination = await target.boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + 45);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 12 });
  await expect(page.locator('.drag-ghost')).toBeVisible();
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
}
async function currentPosition() {
  return page.evaluate(() => window.ReadingContent.location(document.getElementById('book-frame').contentDocument, 0));
}
async function stubSpeech({ missing = false, upgrade = false, delay = 150, fail = false, tailDelay = 0 } = {}) {
  const audio = (await fs.readFile(path.join(ROOT, 'tests/speech-fixture.mp3'))).toString('base64');
  await application.evaluate(({ ipcMain, BrowserWindow }, options) => {
    let state = { phase: options.upgrade ? 'upgrade' : options.missing ? 'missing' : 'ready', message: options.upgrade ? '需要更新语音包' : options.missing ? '尚未安装' : 'Serena 已安装' };
    let installVersion = 0; let fail = options.fail;
    globalThis.speechTest = { requests: [], voices: [], cancels: 0, warms: 0, finished: 0 };
    let sequence = 0; const streams = new Map();
    const update = (phase, message) => { state = { phase, message }; BrowserWindow.getAllWindows()[0].webContents.send('voice:status-changed', state); };
    const handle = (channel, action) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, async (_event, ...args) => {
      try { return { ok: true, data: await action(...args) }; } catch (error) { return { ok: false, error: error.message }; }
    }); };
    handle('voice:status', () => state);
    handle('voice:cancel', () => { globalThis.speechTest.cancels++; streams.clear(); });
    handle('voice:warm', () => { globalThis.speechTest.warms++; });
    handle('voice:install', async () => {
      const version = ++installVersion; update('installing', '正在下载 Serena…');
      await new Promise(resolve => setTimeout(resolve, 650));
      if (version === installVersion) update('ready', 'Serena 已安装'); return state;
    });
    handle('voice:cancel-install', () => { installVersion++; update('missing', '下载已取消'); });
    handle('voice:remove', () => { update('missing', '语音包已移除'); return state; });
    handle('voice:stream', (text, style, speaker) => {
      globalThis.speechTest.voices.push({text, style, speaker});
      globalThis.speechTest.requests.push(text);
      const id = String(++sequence); streams.set(id, { phase: 0 }); return id;
    });
    handle('voice:stream-next', async id => {
      const stream = streams.get(id); if (!stream) throw new Error('朗读已取消');
      const phase = stream.phase++;
      await new Promise(resolve => setTimeout(resolve, phase === 0 ? options.delay : phase === 1 ? options.tailDelay : 0));
      if (!streams.has(id)) throw new Error('朗读已取消');
      if (phase === 0 && fail) { fail = false; throw new Error('测试声音准备失败'); }
      const bytes = Buffer.from(options.audio, 'base64'); const half = Math.floor(bytes.length / 2);
      if (phase === 0) return { data: bytes.subarray(0, half) };
      if (phase === 1) return { data: bytes.subarray(half) };
      streams.delete(id); globalThis.speechTest.finished++; return { done: true };
    });
  }, { missing, upgrade, delay, fail, tailDelay, audio });
}
async function setRate(value) {
  await page.locator('#speech-rate').evaluate((input, rate) => {
    input.value = String(rate); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function speechChapters(chapters) {
  const zip = await JSZip.loadAsync(await makeEpub({ count: chapters.length, title: '连续听读测试' }));
  chapters.forEach((html, i) => zip.file(`OPS/chapters/第${i + 1}章.xhtml`, `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>${html}</body></html>`));
  const filename = path.join(directory, 'speech.epub'); await fs.writeFile(filename, await zip.generateAsync({ type: 'nodebuffer' }));
  await chooseFile(filename); await page.locator('.book-open').click();
  await expect(page.locator('#chapter-loading')).toBeHidden(); await page.locator('#speech-toggle').click();
}
async function finishAudio() { await page.evaluate(() => speech.audio.dispatchEvent(new Event('ended'))); }
async function selectPassage(first = '#p25', last = first) {
  const frame = page.frameLocator('#book-frame'); await frame.locator(first).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frame.locator(first).evaluate((node, endSelector) => {
    const doc = node.ownerDocument; const range = doc.createRange(); range.selectNodeContents(node);
    if (endSelector) range.setEndAfter(doc.querySelector(endSelector));
    doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
  }, last === first ? null : last);
  await expect(page.locator('#selection-tools')).toBeVisible();
}
async function closeNormally() {
  await Promise.all([
    application.waitForEvent('close'),
    application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  ]);
  application = null;
}
test.beforeEach(async ({}, info) => {
  directory = path.join(ROOT, '.test-data', `${info.testIndex}-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  errors = [];
  await launch();
});
test.afterEach(async () => {
  if (application) { await application.close(); application = null; }
  expect(errors).toEqual([]);
});

test('Empty shelf, example, images, nested TOC, links and chapter controls', async () => {
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#book-count')).toHaveText('0');
  await example();
  const body = page.frameLocator('#book-frame');
  await expect(body.locator('h1')).toHaveText('慢下来，翻开一页');
  expect(await body.locator('img').first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.toc-item')).toHaveCount(4);
  await expect(page.locator('#previous-chapter')).toBeDisabled();
  await body.getByText('跳到第二十一段').click();
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(15);
  await page.locator('.toc-item').nth(2).click();
  await expect(page.locator('#chapter-title')).toHaveText('在文字里，遇见风景');
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(15);
  await page.locator('#next-chapter').click();
  await expect(page.locator('#chapter-title')).toHaveText('让阅读成为日常');
  await expect(page.locator('#next-chapter')).toBeDisabled();
  await page.locator('#previous-chapter').click();
  await expect(page.locator('#chapter-title')).toHaveText('在文字里，遇见风景');
  await page.locator('#back-button').click();
  await expect(page.locator('#continue-title')).toHaveText('给阅读留一点时间');
  await page.locator('#toast').evaluate(node => { node.hidden = true; });
  await page.screenshot({ path: path.join(ROOT, 'test-results/shelf.png') });
});

test('Save a paragraph, change layout, resize, close and restore after relaunch', async () => {
  await example();
  await page.frameLocator('#book-frame').locator('#p35').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(30);
  await expect(page.locator('#save-status')).toHaveText('进度已保存');
  const before = await currentPosition();
  await page.locator('#settings-button').click();
  await page.locator('#font-size').evaluate(input => { input.value = '26'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#font-size-value')).toHaveText('26 px');
  await expect(page.locator('#save-status')).toHaveText('进度已保存');
  expect(Math.abs((await currentPosition()).block - before.block)).toBeLessThanOrEqual(1);
  await page.locator('#line-height').evaluate(input => { input.value = '2.2'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#line-height-value')).toHaveText('2.2');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1020, 740));
  await expect.poll(async () => Math.abs((await currentPosition()).block - before.block)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(ROOT, 'test-results/reader.png') });
  await closeNormally();
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
  expect(saved.settings.fontSize).toBe(26);
  expect(saved.settings.lineHeight).toBe(2.2);
  expect(saved.books[0].progress.block).toBeGreaterThan(30);
  await launch();
  await expect(page.locator('#continue-section')).toBeVisible();
  await page.locator('#continue-button').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#font-size-value')).toHaveText('26 px');
  expect(Math.abs((await currentPosition()).block - saved.books[0].progress.block)).toBeLessThanOrEqual(1);
});

test('Native import: duplicate, cancelled dialog, invalid archive and DRM errors', async () => {
  const filename = path.join(directory, 'my-book.epub');
  await fs.writeFile(filename, await makeEpub({ title: '本地导入测试' }));
  await chooseFile(filename);
  await expect(page.locator('.book-card')).toHaveCount(1);
  await chooseFile(filename);
  await expect(page.locator('#toast')).toContainText('已在书架');
  await expect(page.locator('.book-card')).toHaveCount(1);
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.locator('#import-button').click();
  await expect(page.locator('#import-button')).toBeEnabled();
  const broken = path.join(directory, 'broken.epub'); await fs.writeFile(broken, 'broken');
  await chooseFile(broken);
  await expect(page.locator('#toast')).toContainText('完整的 EPUB');
  const drm = path.join(directory, 'drm.epub'); await fs.writeFile(drm, await makeEpub({ drm: true }));
  await chooseFile(drm);
  await expect(page.locator('#toast')).toContainText('DRM');
  await expect(page.locator('.book-card')).toHaveCount(1);
});

test('Dropping real EPUB files without File.path imports into the current category and detects duplicates', async () => {
  const filename = path.join(directory, '拖入的书 （中文路径）.EPUB'); await fs.writeFile(filename, await makeEpub({ title: '拖入的书' }));
  await createCategory('文学'); await page.getByRole('button', { name: '打开分类 文学', exact: true }).click();
  await page.evaluate(() => {
    document.addEventListener('drop', event => {
      window.dropEvidence = [...event.dataTransfer.files].map(file => ({ legacyPath: file.path || '', resolved: reader.filePath(file) }));
    }, { once: true, capture: true });
  });
  await dropFiles([filename]);
  expect(await page.evaluate(() => window.dropEvidence)).toEqual([{ legacyPath: '', resolved: filename }]);
  await expect(page.locator('.drop-overlay')).toBeHidden();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await expect(page.locator('.book-card')).toContainText('拖入的书');
  await expect(page.locator('#toast')).toContainText('已导入 1 本 EPUB');
  const state = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
  expect(state.books[0].categoryId).toBe(state.categories[0].id);
  await dropFiles([filename]);
  await expect(page.locator('#toast')).toContainText('1 本已在书架中');
  await expect(page.locator('.book-card')).toHaveCount(1);
});

test('Dropping mixed files imports valid EPUBs and reports a damaged EPUB without blocking retry', async () => {
  const valid = path.join(directory, 'valid.epub'); await fs.writeFile(valid, await makeEpub({ title: '有效的书' }));
  const broken = path.join(directory, 'broken.epub'); await fs.writeFile(broken, 'not an EPUB');
  const other = path.join(directory, 'other.txt'); await fs.writeFile(other, 'other file');
  await dropFiles([valid, broken, other]);
  await expect(page.locator('#toast')).toContainText('已导入 1 本');
  await expect(page.locator('#toast')).toContainText('broken.epub');
  await expect(page.locator('#toast')).toContainText('完整的 EPUB');
  await expect(page.locator('.book-card')).toHaveCount(1);
  await dropFiles([valid]); await expect(page.locator('#toast')).toContainText('1 本已在书架中');
});

test('Dropping an EPUB without a filesystem path explains how to retry', async () => {
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['epub'], '没有路径.epub', { type: 'application/epub+zip' }));
    const shelf = document.getElementById('shelf-view');
    shelf.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
    shelf.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
    shelf.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  });
  await expect(page.locator('.drop-overlay')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('无法读取拖入的 EPUB 文件路径');
  await expect(page.locator('.book-card')).toHaveCount(0);
});

test('Launching with an EPUB path imports and opens the book directly', async () => {
  const filename = path.join(directory, 'associated.epub'); await fs.writeFile(filename, await makeEpub({ title: '双击打开的书' }));
  await application.close(); application = null;
  await launch([filename]);
  await expect(page.locator('#reader-view')).toBeVisible();
  await expect(page.locator('#reader-title')).toHaveText('双击打开的书');
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  const state = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
  expect(state.books).toHaveLength(1); expect(state.books[0].title).toBe('双击打开的书');
});

test('Book content cannot execute scripts, load external resources or access desktop APIs', async () => {
  const filename = path.join(directory, 'unsafe.epub');
  await fs.writeFile(filename, await makeEpub({ malicious: true }));
  await chooseFile(filename);
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.locator('.book-open').click();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  const frame = page.frameLocator('#book-frame');
  await expect(frame.locator('script,iframe,form,input')).toHaveCount(0);
  await expect(frame.locator('[onerror],[style]')).toHaveCount(0);
  expect(await frame.locator('body').evaluate(() => window.bookScriptRan)).toBeUndefined();
  expect(await page.evaluate(() => typeof require)).toBe('undefined');
  expect(await page.locator('#book-frame').getAttribute('sandbox')).toBe('allow-same-origin');
  expect(await frame.locator('img[src^="http"]').count()).toBe(0);
  expect(application.windows()).toHaveLength(1);
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://example.com'); return false; } catch { return true; }
  });
  expect(blocked).toBe(true);
});

test('Delete confirmation preserves the original file and stays deleted after restart', async () => {
  const filename = path.join(directory, 'keep-original.epub');
  await fs.writeFile(filename, await makeEpub());
  await chooseFile(filename);
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.locator('.remove-book').click();
  await page.locator('#cancel-delete').click();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.locator('.remove-book').click();
  await page.locator('#confirm-delete').click();
  await expect(page.locator('#empty-state')).toBeVisible();
  await fs.access(filename);
  await closeNormally();
  await launch();
  await expect(page.locator('.book-card')).toHaveCount(0);
});

test('Disk write failure is visible, prevents normal close, and recovers on retry', async () => {
  await example();
  const temp = path.join(directory, 'library.json.tmp');
  await fs.mkdir(temp);
  try {
    await page.frameLocator('#book-frame').locator('#p30').evaluate(node => node.scrollIntoView());
    await expect(page.locator('#save-status')).toHaveText('保存失败，请重试');
    await expect(page.locator('#toast')).toContainText('检查磁盘空间和文件夹权限');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect(page.locator('#toast')).toContainText('暂未关闭窗口');
    expect(application.windows()).toHaveLength(1);
  } finally { await fs.rmdir(temp); }
  await page.locator('#back-button').click();
  await expect(page.locator('#shelf-view')).toBeVisible();
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
  expect(saved.books[0].progress.block).toBeGreaterThan(25);
});

test('Bookmark create, deduplicate, restore after restart, jump, return and delete', async () => {
  await example();
  await page.frameLocator('#book-frame').locator('#p30').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(25);
  const original = await currentPosition();
  await page.locator('#bookmarks-button').click();
  await page.locator('#add-bookmark').click();
  await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await page.locator('#add-bookmark').click();
  await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await closeNormally();
  await launch();
  await page.locator('#continue-button').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#next-chapter').click();
  await expect(page.locator('#chapter-title')).toHaveText('在文字里，遇见风景');
  await page.locator('#bookmarks-button').click();
  await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await page.locator('.bookmark-entry .reading-result').click();
  await expect(page.locator('#chapter-title')).toHaveText('慢下来，翻开一页');
  expect(Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
  await page.locator('#return-position-button').click();
  await expect(page.locator('#chapter-title')).toHaveText('在文字里，遇见风景');
  await page.locator('#bookmarks-button').click();
  await page.locator('.delete-bookmark').click();
  await expect(page.locator('.bookmark-entry')).toHaveCount(0);
});

test('Whole-book search highlights results, returns to reading position and handles no matches and caps', async () => {
  await example();
  await page.frameLocator('#book-frame').locator('#p12').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(10);
  const original = await currentPosition();
  await page.locator('#search-button').click();
  await page.locator('#search-input').fill('第 61 段');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#search-status')).toHaveText('找到 3 处匹配。');
  await page.screenshot({ path: path.join(ROOT, 'test-results/search.png') });
  await page.locator('#search-results .reading-result').last().click();
  await expect(page.locator('#chapter-title')).toHaveText('让阅读成为日常');
  await expect(page.locator('#chapter-loading')).toBeHidden();
  expect(await page.frameLocator('#book-frame').locator('body').evaluate(() => CSS.highlights.has('reader-search'))).toBe(true);
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(50);
  await page.locator('#return-position-button').click();
  await expect(page.locator('#chapter-title')).toHaveText('慢下来，翻开一页');
  expect(Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
  await page.locator('#search-button').click();
  await page.locator('#search-input').fill('不存在的特殊词语abcdef');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#search-status')).toHaveText('没有找到匹配内容。');
  await page.locator('#search-input').fill('阅读');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#search-status')).toContainText('前 200');
  await expect(page.locator('#search-results .reading-result')).toHaveCount(200);
});

test('TOC and in-book links preserve a stack of prior reading positions', async () => {
  await example();
  await page.frameLocator('#book-frame').locator('#p30').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(25);
  const original = await currentPosition();
  await page.locator('.toc-item').nth(1).click();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect.poll(async () => (await currentPosition()).block).toBeLessThan(20);
  await page.locator('.toc-item').last().click();
  await expect(page.locator('#chapter-title')).toHaveText('让阅读成为日常');
  await page.locator('#return-position-button').click();
  await expect(page.locator('#chapter-title')).toHaveText('慢下来，翻开一页');
  await page.locator('#return-position-button').click();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  expect(Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
  await expect(page.locator('#return-position-button')).toBeDisabled();
});

test('Fullscreen button, F11 and Escape preserve the reading paragraph', async () => {
  await example();
  await page.frameLocator('#book-frame').locator('#p25').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(20);
  const original = await currentPosition();
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveText('退出全屏');
  await expect(page.locator('#fullscreen-button')).toHaveAccessibleName('退出全屏');
  await expect(page.locator('#fullscreen-button svg')).toBeVisible();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#fullscreen-button')).toHaveText('全屏');
  await page.keyboard.press('F11');
  await expect(page.locator('#fullscreen-button')).toHaveText('退出全屏');
  await page.keyboard.press('F11');
  await expect(page.locator('#fullscreen-button')).toHaveText('全屏');
  await expect.poll(async () => Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
});

test('Quiet reading reveals edge controls without moving the page and restores the reading position', async () => {
  await example();
  const frame = page.frameLocator('#book-frame');
  await frame.locator('#p30').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(25);
  const original = await currentPosition(); const text = await frame.locator('article').textContent();
  await page.locator('#speech-toggle').click();
  await page.locator('#quiet-button').click();
  await expect(page.locator('#quiet-button')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.reader-toolbar')).toBeHidden();
  await expect(page.locator('.reader-footer')).toBeHidden();
  await expect(page.locator('#toc-panel')).toBeHidden();
  await expect(page.locator('#speech-toggle')).toBeHidden();
  await expect(page.locator('#speech-bar')).toBeHidden();
  await expect.poll(() => page.evaluate(() => !suppressScroll)).toBe(true);
  expect(Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
  expect(await frame.locator('article').textContent()).toBe(text);
  const bounds = await page.locator('#book-frame').boundingBox();
  expect(bounds.y).toBe(0); expect(bounds.height).toBe(await page.evaluate(() => innerHeight));
  await page.locator('#toast').evaluate(node => { node.hidden = true; });
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-quiet.png`) });
  await page.mouse.move(20, 2);
  await expect(page.locator('.reader-toolbar')).toBeVisible();
  expect(await page.locator('#book-frame').boundingBox()).toEqual(bounds);
  await page.mouse.move(400, 250); await expect(page.locator('.reader-toolbar')).toBeHidden();
  await page.mouse.move(20, bounds.height - 2); await expect(page.locator('.reader-footer')).toBeVisible();
  expect(await page.locator('#book-frame').boundingBox()).toEqual(bounds);
  await page.mouse.move(20, 2); await page.locator('#quiet-button').click();
  await expect(page.locator('#quiet-button')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#toc-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !suppressScroll)).toBe(true);
  expect(Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
});

test('Quiet reading keyboard navigation coexists with fullscreen and restores a hidden TOC', async () => {
  await example(); await page.locator('#toc-button').click();
  await expect(page.locator('#toc-panel')).toBeHidden();
  await page.keyboard.press('Control+Shift+Q');
  await expect(page.locator('#reader-view')).toHaveClass(/quiet-reading/);
  await page.keyboard.press('F11');
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await expect(page.locator('#toc-panel')).toBeHidden();
  await page.keyboard.press('F11');
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
  await page.keyboard.press('Control+Shift+Q'); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#chapter-title')).toHaveText('在文字里，遇见风景');
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#reader-view')).toHaveClass(/quiet-reading/);
  await page.keyboard.press('Control+f'); await expect(page.locator('#search-input')).toBeFocused();
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
  await page.keyboard.press('Control+Shift+Q');
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
});

test('Quiet reading keeps speech running, opens requested tools and resets on bookshelf return', async () => {
  await stubSpeech({ delay: 100 }); await example();
  await page.locator('#speech-toggle').click(); await page.locator('#speech-play').click();
  await expect(page.frameLocator('#book-frame').locator('.reader-speaking')).not.toHaveCount(0);
  const version = await page.evaluate(() => speech.version);
  await page.locator('#quiet-button').click();
  expect(await page.evaluate(() => speech.active && !speech.paused && speech.version)).toBe(version);
  await page.mouse.move(20, 2); await page.locator('#settings-button').click();
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator('#quiet-button').click(); await expect(page.locator('#settings-panel')).toBeHidden();
  await page.mouse.move(20, 2); await page.locator('#ai-open-reader').click();
  await expect(page.locator('#ai-panel')).toBeVisible();
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
  await page.locator('#quiet-button').click(); await expect(page.locator('#ai-panel')).toBeHidden();
  await page.mouse.move(20, 2); await page.locator('#toc-button').click();
  await expect(page.locator('#toc-panel')).toBeVisible();
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
  await page.locator('#quiet-button').click(); await page.mouse.move(20, 2); await page.locator('#back-button').click();
  await expect(page.locator('#shelf-view')).toBeVisible();
  await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
  await expect(page.locator('.reader-toolbar')).toBeVisible();
});

test('Quiet reading in a small window respects modal Escape and saves the position across restart', async () => {
  await example();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  await expect.poll(() => page.evaluate(() => !suppressScroll)).toBe(true);
  await page.locator('#quiet-button').click();
  await expect.poll(() => page.evaluate(() => !suppressScroll)).toBe(true);
  await selectPassage(); await page.locator('#selection-note').click();
  await page.locator('#note-text').fill('尚未保存的想法'); await page.keyboard.press('Escape');
  await expect(page.locator('#note-dialog')).toBeHidden();
  await expect(page.locator('#reader-view')).toHaveClass(/quiet-reading/);
  expect(await page.evaluate(() => current.annotations.length)).toBe(0);
  await page.frameLocator('#book-frame').locator('#p60').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8')).books[0].progress.block).toBeGreaterThan(55);
  const original = await currentPosition();
  await page.mouse.move(20, 2); await expect(page.locator('.reader-toolbar')).toBeVisible();
  const right = await page.locator('.toolbar-actions').evaluate(node => node.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await page.mouse.move(400, 250); await expect(page.locator('.reader-toolbar')).toBeHidden();
  await closeNormally();
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8')).books[0].progress;
  expect(Math.abs(saved.block - original.block)).toBeLessThanOrEqual(1);
  await launch(); await page.locator('#continue-button').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#reader-view')).not.toHaveClass(/quiet-reading/);
  expect(Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
});

test('Category create, rename, validation, book move, restart and safe folder deletion', async () => {
  await example();
  await page.locator('#bookmarks-button').click(); await page.locator('#add-bookmark').click();
  await expect(page.locator('.bookmark-entry')).toHaveCount(1);
  await page.locator('#back-button').click();
  await createCategory('文学小说'); await createCategory('待读');
  await page.getByRole('button', { name: '重命名分类 文学小说', exact: true }).click();
  await page.locator('#folder-name').fill('外国文学'); await page.locator('#save-folder').click();
  await expect(page.getByRole('button', { name: '打开分类 外国文学', exact: true })).toBeVisible();
  await page.locator('#new-folder-button').click(); await page.locator('#folder-name').fill('待读');
  await page.locator('#save-folder').click(); await expect(page.locator('#folder-error')).toContainText('同名分类');
  await page.locator('#cancel-folder').click();
  await page.locator('.organize-book').click(); await page.locator('#move-category').selectOption({ label: '外国文学' });
  await page.locator('#confirm-move').click(); await expect(page.locator('#move-dialog')).not.toBeVisible();
  await page.locator('#uncategorized-button').click(); await expect(page.locator('.book-card')).toHaveCount(0);
  await expect(page.locator('#category-empty')).toBeVisible();
  await page.getByRole('button', { name: '打开分类 外国文学', exact: true }).click();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await closeNormally(); await launch();
  await expect(page.locator('.folder-row')).toHaveCount(2);
  await page.getByRole('button', { name: '打开分类 外国文学', exact: true }).click();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.getByRole('button', { name: '删除分类 外国文学', exact: true }).click();
  await page.locator('#cancel-delete-folder').click();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.getByRole('button', { name: '删除分类 外国文学', exact: true }).click();
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try {
    await page.locator('#confirm-delete-folder').click();
    await expect(page.locator('#delete-folder-error')).toContainText('检查磁盘空间和文件夹权限');
    await expect(page.locator('.book-card')).toHaveCount(1);
  } finally { await fs.rmdir(temp); }
  await page.locator('#confirm-delete-folder').click();
  await expect(page.locator('#shelf-title')).toHaveText('未分类');
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.locator('.book-open').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#bookmarks-button').click(); await expect(page.locator('.bookmark-entry')).toHaveCount(1);
});

test('Import directly into a category and display the actual continue-reading cover', async () => {
  await createCategory('文学');
  const filename = path.join(directory, 'covered.epub'); await fs.writeFile(filename, await makeEpub({ cover: true }));
  await chooseFile(filename, '文学'); await expect(page.locator('.book-card')).toHaveCount(1);
  await page.getByRole('button', { name: '打开分类 文学', exact: true }).click();
  await expect(page.locator('.book-card')).toHaveCount(1);
  await page.locator('.book-open').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#back-button').click();
  const cover = page.locator('#continue-cover img');
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate(image => image.naturalWidth)).toBe(400);
  expect(await cover.getAttribute('src')).toBe(await page.locator('.book-cover img').last().getAttribute('src'));
  expect(await cover.evaluate(image => getComputedStyle(image).objectFit)).toBe('contain');
});

test('Fog and glass shelf stays usable at minimum width and provides a generated cover fallback', async () => {
  await example(); await page.locator('#back-button').click();
  await createCategory('文学小说'); await createCategory('生活随笔'); await createCategory('待读清单');
  for (const [index, title] of ['窗边的慢时光', '生活的另一种节奏', '森林与清晨'].entries()) {
    const filename = path.join(directory, `visual-${index}.epub`); await fs.writeFile(filename, await makeEpub({ title }));
    await chooseFile(filename); await expect(page.locator('.book-card')).toHaveCount(index + 2);
  }
  await page.locator('#toast').evaluate(node => { node.hidden = true; });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 1020));
  await page.screenshot({ path: path.join(ROOT, 'test-results/glass-shelf.png') });
  const fog = await page.locator('body').evaluate(node => getComputedStyle(node).backgroundImage);
  expect(fog).toContain('radial-gradient');
  await page.getByRole('button', { name: '阅读 窗边的慢时光', exact: true }).click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#back-button').click();
  await expect(page.locator('#continue-cover .generated-cover')).toBeVisible();
  await expect(page.locator('#continue-cover')).toContainText('窗边的慢时光');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  await expect(page.locator('#import-button')).toBeVisible();
  const bounds = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, width: innerWidth }));
  expect(bounds.page).toBeLessThanOrEqual(bounds.width);
  for (const id of ['ai-settings-shelf', 'backup-button', 'voice-manage-shelf', 'import-button']) {
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box.x).toBeGreaterThan(220);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
  }
  await page.screenshot({ path: path.join(ROOT, 'test-results/glass-shelf-small.png') });
});

test('Compact reading toolbar keeps accessible controls, title space and quiet keyboard feedback', async () => {
  await example();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680));
  await expect(page.locator('#chapter-loading')).toBeHidden();
  const layout = await page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    return { width: innerWidth, scroll: document.documentElement.scrollWidth,
      heading: rect(document.querySelector('.reader-heading')), actions: rect(document.querySelector('.toolbar-actions')),
      controls: Array.from(document.querySelectorAll('.reader-toolbar button'), rect) };
  });
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  expect(layout.heading.width).toBeGreaterThanOrEqual(80);
  expect(layout.heading.right).toBeLessThanOrEqual(layout.actions.left);
  for (let i = 1; i < layout.controls.length; i++) {
    expect(layout.controls[i].left).toBeGreaterThanOrEqual(layout.controls[i - 1].right);
    expect(layout.controls[i].right).toBeLessThanOrEqual(layout.width);
  }
  for (const [id, name] of [['bookmarks-button', '书签'], ['notes-button', '摘录'], ['search-button', '搜索'], ['fullscreen-button', '全屏']]) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(name);
    await expect(page.locator(`#${id} svg`)).toBeVisible();
  }
  await page.locator('#notes-button').click();
  await expect(page.locator('#notes-button')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#note-tools')).toBeVisible();
  await page.locator('#close-tools').click();
  await page.locator('#settings-button').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#settings-panel')).toBeVisible();
  expect(await page.locator('#settings-button').evaluate(node => getComputedStyle(node).transform)).toBe('none');
  await page.locator('#close-settings').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const toggle = page.locator('#speech-toggle'); const box = await toggle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.waitForTimeout(180); // Let press feedback settle while the pointer remains down.
  expect(await toggle.evaluate(node => getComputedStyle(node).transform)).toBe('none');
  await page.mouse.up(); await expect(page.locator('#speech-bar')).toBeVisible();
  await page.locator('#speech-close').click();
  await page.screenshot({ path: path.join(ROOT, 'test-results/glass-reader-small.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 960));
  await expect(page.locator('#notes-button .compact-label')).toBeVisible();
  await page.screenshot({ path: path.join(ROOT, 'test-results/glass-reader.png') });
});

test('Right-button drag moves into and out of categories and supports undo without opening the book', async () => {
  await example(); await page.locator('#back-button').click();
  await createCategory('文学'); await createCategory('待读');
  const literary = page.getByRole('button', { name: '打开分类 文学', exact: true });
  const later = page.getByRole('button', { name: '打开分类 待读', exact: true });
  await dragBook(literary); await expect(page.locator('.toast-action')).toBeVisible();
  await expect(page.locator('#reader-view')).toBeHidden();
  await literary.click(); await expect(page.locator('.book-card')).toHaveCount(1);
  await dragBook(later); await expect(page.locator('.book-card')).toHaveCount(0);
  await page.locator('.toast-action').click(); await expect(page.locator('.book-card')).toHaveCount(1);
  await dragBook(page.locator('#all-books-button')); await expect(page.locator('.book-card')).toHaveCount(0);
  await page.locator('.toast-action').click(); await expect(page.locator('.book-card')).toHaveCount(1);
  await dragBook(page.locator('#uncategorized-button')); await expect(page.locator('.book-card')).toHaveCount(0);
  await page.locator('#uncategorized-button').click(); await expect(page.locator('.book-card')).toHaveCount(1);
  await closeNormally(); await launch();
  await page.getByRole('button', { name: '打开分类 文学', exact: true }).click();
  await expect(page.locator('.book-card')).toHaveCount(0);
  await page.locator('#uncategorized-button').click(); await expect(page.locator('.book-card')).toHaveCount(1);
});

test('Right-button drag cancels on Escape or blank space; failed moves keep the book and can retry', async () => {
  await example(); await page.locator('#back-button').click(); await createCategory('文学');
  const target = page.getByRole('button', { name: '打开分类 文学', exact: true });
  await dragBook(target, true);
  await expect(page.locator('.toast-action')).toHaveCount(0);
  await dragBook(page.locator('.shelf-header'));
  const original = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
  expect(original.books[0].categoryId).toBeNull();
  await expect(page.locator('#reader-view')).toBeHidden();
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try {
    await dragBook(target);
    await expect(page.locator('#toast')).toContainText('检查磁盘空间和文件夹权限');
    await expect(page.locator('.toast-action')).toHaveCount(0);
  } finally { await fs.rmdir(temp); }
  await dragBook(target); await expect(page.locator('.toast-action')).toBeVisible();
  await target.click(); await expect(page.locator('.book-card')).toHaveCount(1);
});

test('All bundled fonts load offline, paragraph spacing preserves position and each book remembers its font', async () => {
  await example();
  await page.frameLocator('#book-frame').locator('#p30').evaluate(node => node.scrollIntoView());
  await expect.poll(async () => (await currentPosition()).block).toBeGreaterThan(25);
  const original = await currentPosition();
  await page.locator('#settings-button').click();
  for (const [id, family] of [['serif', 'ReaderSerif'], ['wenkai', 'ReaderWenKai'], ['sans', 'ReaderSans']]) {
    await page.locator('#font-family').selectOption(id);
    await expect.poll(() => page.frameLocator('#book-frame').locator('body').evaluate((node, selected) =>
      [...node.ownerDocument.fonts].some(font => font.family === selected && font.status === 'loaded'), family)).toBe(true);
    await expect.poll(async () => Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
  }
  await page.locator('#font-family').selectOption('serif');
  await page.locator('#paragraph-gap').evaluate(input => { input.value = '1.8'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#paragraph-gap-value')).toHaveText('1.8 倍字号');
  await expect.poll(async () => Math.abs((await currentPosition()).block - original.block)).toBeLessThanOrEqual(1);
  const paragraph = page.frameLocator('#book-frame').locator('#p30');
  expect(await paragraph.evaluate(node => parseFloat(getComputedStyle(node).marginBottom) / parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(1.8, 2);
  await page.screenshot({ path: path.join(ROOT, 'test-results/reading-fonts.png') });
  await page.locator('#back-button').click();
  const filename = path.join(directory, 'font-inherit.epub'); await fs.writeFile(filename, await makeEpub({ title: '第二本字体测试' }));
  await chooseFile(filename); await expect(page.locator('.book-card')).toHaveCount(2);
  await page.getByRole('button', { name: '阅读 第二本字体测试', exact: true }).click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#font-family')).toHaveValue('serif');
  await page.locator('#settings-button').click(); await page.locator('#font-family').selectOption('wenkai');
  await expect(page.locator('#save-status')).toHaveText('进度已保存');
  await page.locator('#back-button').click();
  await page.getByRole('button', { name: '阅读 给阅读留一点时间', exact: true }).click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#font-family')).toHaveValue('serif');
  await closeNormally(); await launch(); await page.locator('#continue-button').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#font-family')).toHaveValue('serif');
  await expect(page.locator('#paragraph-gap')).toHaveValue('1.8');
});

test('Serena pack manager downloads, cancels, retries, previews and removes without changing the shelf', async () => {
  await stubSpeech({ missing: true });
  await page.locator('#voice-manage-shelf').click();
  await expect(page.locator('#voice-install')).toBeVisible();
  await page.locator('#voice-install').click(); await page.locator('#voice-cancel-install').click();
  await expect(page.locator('#voice-pack-status')).toContainText('取消');
  await expect(page.locator('#voice-install')).toBeVisible();
  await page.waitForTimeout(700);
  await page.locator('#voice-install').click(); await expect(page.locator('#voice-preview')).toBeVisible();
  await page.locator('#voice-preview').click(); await expect(page.locator('#voice-pack-status')).toContainText('正在朗读');
  await page.locator('#voice-close').click();
  await expect.poll(() => page.evaluate(() => speech.active)).toBe(false);
  await page.locator('#voice-manage-shelf').click(); await page.locator('#voice-remove').click();
  await expect(page.locator('#voice-pack-status')).toContainText('移除');
  await page.locator('#voice-close').click(); await expect(page.locator('#empty-state')).toBeVisible();
});

test('Serena highlights only playing paragraphs, pauses, changes speed and resumes following after manual scroll', async () => {
  await stubSpeech({ delay: 450 }); await example(); await page.locator('#speech-toggle').click();
  const frame = page.frameLocator('#book-frame');
  await frame.locator('#p30').evaluate(node => node.scrollIntoView());
  await page.locator('#speech-play').click();
  await expect(page.locator('#speech-status')).toContainText('准备');
  await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  await page.locator('#speech-play').click();
  await expect(page.locator('#speech-play')).toHaveText('▷ 继续');
  await page.waitForTimeout(550); await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  await page.locator('#speech-play').click(); await expect(frame.locator('#p30')).toHaveClass(/reader-speaking/);
  await setRate(1.15);
  expect(await page.evaluate(() => speech.audio.playbackRate)).toBe(1.15);
  await page.locator('#speech-play').click();
  await expect(frame.locator('#p30')).toHaveClass(/reader-speaking/);
  expect(await page.evaluate(() => speech.audio.paused)).toBe(true);
  await page.locator('#speech-play').click();
  await frame.locator('body').evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true }));
    node.ownerDocument.getElementById('p60').scrollIntoView();
  });
  await expect(page.locator('#speech-follow')).toBeVisible();
  const scrolled = await frame.locator('body').evaluate(node => node.ownerDocument.defaultView.scrollY);
  await page.evaluate(() => { speech.audio.currentTime = speech.audio.duration - .05; });
  await expect(frame.locator('#p31')).toHaveClass(/reader-speaking/);
  expect(await frame.locator('body').evaluate(node => node.ownerDocument.defaultView.scrollY)).toBe(scrolled);
  await page.locator('#speech-follow').click(); await expect(page.locator('#speech-follow')).toBeHidden();
  await expect.poll(() => frame.locator('#p31').evaluate(node => node.getBoundingClientRect().top)).toBeLessThan(100);
  await page.screenshot({ path: path.join(ROOT, 'test-results/serena-reading.png') });
  expect(await application.evaluate(() => globalThis.speechTest.requests.length)).toBeLessThanOrEqual(3);
  await page.locator('#speech-stop').click(); await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  await expect(page.locator('#speech-play')).toHaveText('▷ 朗读');
});

test('Serena retries errors, discards old audio after a jump and stops on chapter change and shelf return', async () => {
  await stubSpeech({ fail: true, delay: 300 }); await example(); await page.locator('#speech-toggle').click();
  const frame = page.frameLocator('#book-frame');
  await page.locator('#speech-play').click(); await expect(page.locator('#speech-play')).toHaveText('重试');
  await expect(page.locator('#toast')).toContainText('测试声音准备失败');
  await page.locator('#speech-play').click(); await expect(frame.locator('.reader-speaking')).toHaveCount(1);
  await frame.locator('#p20').click(); await page.locator('#speech-stop').click();
  await page.waitForTimeout(500); await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  expect(await page.evaluate(() => speech.audio === null)).toBe(true);
  await page.locator('#speech-play').click(); await expect(frame.locator('.reader-speaking')).toHaveCount(1);
  await page.locator('#next-chapter').click(); await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  await expect(page.locator('#speech-stop')).toBeDisabled();
  await page.locator('#speech-play').click(); await expect(frame.locator('.reader-speaking')).toHaveCount(1);
  await page.locator('#back-button').click(); await expect(page.locator('#shelf-view')).toBeVisible();
  expect(await page.evaluate(() => speech.active)).toBe(false);
});

test('Serena supports paragraph jumps, long paragraph splitting and stops cleanly at chapter end', async () => {
  await stubSpeech(); await example(); await page.locator('#speech-toggle').click();
  await page.locator('#speech-auto-advance').uncheck();
  const frame = page.frameLocator('#book-frame');
  const stats = await frame.locator('article').evaluate(article => {
    article.innerHTML = '<h1>朗读测试</h1><p id="long">' + '这里是一段很长的文字，需要拆分生成声音。'.repeat(25) + '</p><p id="last">本章最后一段。</p>';
    return article.querySelector('#long').textContent.length;
  });
  expect(stats).toBeGreaterThan(240);
  await page.locator('#speech-play').click(); await expect(frame.locator('h1')).toHaveClass(/reader-speaking/);
  await frame.locator('#long').click(); await expect(frame.locator('#long')).toHaveClass(/reader-speaking/);
  const sent = await application.evaluate(() => globalThis.speechTest.requests);
  expect(sent.every(text => text.length <= 360)).toBe(true);
  await frame.locator('#last').click(); await expect(frame.locator('#last')).toHaveClass(/reader-speaking/);
  await page.evaluate(() => { speech.audio.currentTime = speech.audio.duration - .05; });
  await expect(page.locator('#speech-status')).toHaveText('本章已读完');
  await expect(frame.locator('.reader-speaking')).toHaveCount(0);
});

test('Listening position survives restart independently of reading position and resumes across chapters', async () => {
  await stubSpeech(); await example(); await page.locator('#speech-toggle').click();
  let frame = page.frameLocator('#book-frame');
  await expect(page.locator('#speech-resume')).toBeHidden();
  await frame.locator('#p30').evaluate(node => node.scrollIntoView());
  await page.locator('#speech-play').click(); await expect(frame.locator('#p30')).toHaveClass(/reader-speaking/);
  await expect(page.locator('#speech-resume')).toBeVisible();
  await page.locator('#speech-next').click(); await expect(frame.locator('#p31')).toHaveClass(/reader-speaking/);
  await page.locator('#speech-previous').click(); await expect(frame.locator('#p30')).toHaveClass(/reader-speaking/);
  await page.locator('#speech-stop').click(); await page.locator('#next-chapter').click();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await closeNormally(); await launch(); await stubSpeech();
  frame = page.frameLocator('#book-frame');
  await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#speech-toggle').click();
  await expect(page.locator('#chapter-title')).toHaveText('在文字里，遇见风景');
  await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  await page.locator('#speech-timer').selectOption('30');
  await page.locator('#speech-resume').click(); await expect(frame.locator('#p30')).toHaveClass(/reader-speaking/);
  await expect(page.locator('#speech-timer')).toHaveValue('30');
  await expect(page.locator('#chapter-title')).toHaveText('慢下来，翻开一页');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  for (const id of ['speech-play', 'speech-previous', 'speech-next', 'speech-resume']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
    const box = await page.locator(`#${id}`).boundingBox(); expect(box.y + box.height).toBeLessThanOrEqual(640);
  }
});

test('Paragraph gap can pause and stop without advancing audio or the saved listening position', async () => {
  await stubSpeech(); await example(); await page.locator('#speech-toggle').click(); const frame = page.frameLocator('#book-frame');
  await frame.locator('article').evaluate(article => { article.innerHTML = '<h1>停顿测试</h1><p id="p0">第一段。</p><p id="p1">第二段。</p>'; });
  await page.locator('#speech-play').click(); await expect(frame.locator('h1')).toHaveClass(/reader-speaking/);
  await page.evaluate(() => { speech.audio.dispatchEvent(new Event('ended')); speech.toggle(); });
  await expect(page.locator('#speech-play')).toHaveText('▷ 继续');
  await page.waitForTimeout(300); await expect(frame.locator('h1')).toHaveClass(/reader-speaking/);
  expect(await page.evaluate(() => speech.audio)).toBeNull();
  await page.locator('#speech-play').click(); await expect(frame.locator('#p0')).toHaveClass(/reader-speaking/);
  await page.evaluate(() => { speech.audio.dispatchEvent(new Event('ended')); speech.stop(); });
  await page.waitForTimeout(300); await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  expect(await page.evaluate(() => speech.audio)).toBeNull();
  await page.locator('#speech-resume').click(); await expect(frame.locator('#p0')).toHaveClass(/reader-speaking/);
});

test('Previous and next paragraph skip internal chunks; listening write failures remain visible and retry', async () => {
  await stubSpeech(); await example(); await page.locator('#speech-toggle').click(); const frame = page.frameLocator('#book-frame');
  await frame.locator('article').evaluate(article => {
    article.innerHTML = '<h1>分段测试</h1><p id="long">' + '完整的一句话，不要在中间突然换气。'.repeat(40) + '</p><p id="last">最后一段。</p>';
  });
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try {
    await page.locator('#speech-play').click(); await expect(frame.locator('h1')).toHaveClass(/reader-speaking/);
    await expect(page.locator('#toast')).toContainText('检查磁盘空间和文件夹权限');
    await expect(page.locator('#speech-resume')).toBeHidden();
  } finally { await fs.rmdir(temp); }
  await page.locator('#speech-play').click(); await page.locator('#speech-play').click();
  await expect(page.locator('#speech-resume')).toBeVisible();
  await expect(page.locator('#speech-previous')).toBeDisabled();
  await page.locator('#speech-next').click(); await expect(frame.locator('#long')).toHaveClass(/reader-speaking/);
  await page.evaluate(() => { speech.audio.currentTime = speech.audio.duration - .05; });
  await expect.poll(() => page.evaluate(() => speech.items[speech.index].part)).toBe(1);
  await page.locator('#speech-next').click(); await expect(frame.locator('#last')).toHaveClass(/reader-speaking/);
  await expect(page.locator('#speech-next')).toBeDisabled();
  await page.locator('#speech-previous').click(); await expect(frame.locator('#long')).toHaveClass(/reader-speaking/);
  expect(await page.evaluate(() => speech.items[speech.index].part)).toBe(0);
});

test('Legacy voice packs offer upgrade and removal without starting an incompatible engine', async () => {
  await stubSpeech({ upgrade: true }); await example(); await page.locator('#speech-toggle').click();
  await page.locator('#speech-play').click(); await expect(page.locator('#voice-dialog')).toBeVisible();
  await expect(page.locator('#voice-install')).toHaveText('更新语音包');
  await expect(page.locator('#voice-preview')).toBeHidden(); await expect(page.locator('#voice-remove')).toBeVisible();
  expect(await application.evaluate(() => globalThis.speechTest.requests.length)).toBe(0);
  await page.locator('#voice-install').click(); await expect(page.locator('#voice-preview')).toBeVisible();
  await page.locator('#voice-close').click(); await page.locator('#speech-play').click();
  await expect(page.frameLocator('#book-frame').locator('h1')).toHaveClass(/reader-speaking/);
});


test('Stream plays before completion, hides in fullscreen, keeps pitch and persists continuous speed', async () => {
  await stubSpeech({ delay: 100, tailDelay: 3000 }); await example();
  await expect(page.locator('#speech-bar')).toBeHidden();
  await expect.poll(() => application.evaluate(() => globalThis.speechTest.warms)).toBeGreaterThan(0);
  await page.locator('#speech-toggle').click(); await setRate(.65);
  await expect(page.locator('#speech-rate')).toHaveAttribute('min', '0.6');
  await expect(page.locator('#speech-rate-value')).toHaveText('0.65×');
  await page.locator('#speech-prewarm').uncheck();
  await page.locator('#speech-auto-advance').uncheck();
  await page.locator('#speech-play').click();
  await expect.poll(() => page.evaluate(() => speech.audio && !speech.audio.paused && speech.audio.currentTime > 0)).toBe(true);
  expect(await application.evaluate(() => globalThis.speechTest.finished)).toBe(0);
  expect(await page.evaluate(() => speech.audio.preservesPitch)).toBe(true);
  expect(await page.evaluate(() => speech.audio.playbackRate)).toBe(.65);
  await page.locator('#speech-close').click();
  await expect(page.locator('#speech-bar')).toBeHidden();
  expect(await page.evaluate(() => speech.active && !speech.audio.paused)).toBe(true);
  await page.locator('#speech-toggle').click(); await page.keyboard.press('Escape');
  await expect(page.locator('#speech-bar')).toBeHidden();
  await page.locator('#speech-toggle').click(); await page.locator('#fullscreen-button').click();
  await expect(page.locator('#speech-bar')).toBeHidden();
  await page.keyboard.press('Escape'); await expect(page.locator('#speech-bar')).toBeVisible();
  await setRate(2); expect(await page.evaluate(() => speech.audio.playbackRate)).toBe(2);
  await page.locator('#speech-rate-reset').click(); await expect(page.locator('#speech-rate-value')).toHaveText('1.00×');
  await setRate(.85); await page.locator('#speech-stop').click();
  await closeNormally(); await launch(); await stubSpeech();
  await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#speech-toggle').click();
  await expect(page.locator('#speech-rate')).toHaveValue('0.85');
  await expect(page.locator('#speech-prewarm')).not.toBeChecked();
  await expect(page.locator('#speech-auto-advance')).not.toBeChecked();
  expect(await application.evaluate(() => globalThis.speechTest.warms)).toBe(0);
});

test('Automatic listening skips empty chapters, saves only audible positions and finishes at book end', async () => {
  await stubSpeech(); await speechChapters(['<p id="first">第一章正文。</p>', '<p>　</p><div role="doc-pagebreak">2</div>', '<p id="next">第二段正文。</p>', '<p id="last">最后一章。</p>']);
  const frame = page.frameLocator('#book-frame');
  await page.locator('#speech-play').click(); await expect(frame.locator('#first')).toHaveClass(/reader-speaking/);
  await finishAudio(); await expect(frame.locator('#next')).toHaveClass(/reader-speaking/);
  expect(await page.evaluate(() => chapterIndex)).toBe(2);
  await expect.poll(() => page.evaluate(() => current.listeningPosition?.chapter)).toBe(2);
  await finishAudio(); await expect(frame.locator('#last')).toHaveClass(/reader-speaking/);
  await finishAudio(); await expect(page.locator('#speech-status')).toHaveText('全书已读完');
  expect(await page.evaluate(() => speech.active)).toBe(false);
  expect(await application.evaluate(() => globalThis.speechTest.requests)).toEqual(['第一章正文。', '第二段正文。', '最后一章。']);
  await closeNormally();
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
  expect(saved.books[0].listeningPosition.chapter).toBe(3);
});

test('Sleep timer counts through pause, hidden panel and minimization; timer can be changed and cancelled', async () => {
  await stubSpeech(); await example(); await page.locator('#speech-toggle').click();
  await page.clock.install();
  await page.locator('#speech-timer').selectOption('30');
  await expect(page.locator('#speech-timer-status')).toContainText('30:00');
  await page.locator('#speech-play').click();
  await expect.poll(() => page.evaluate(() => speech.audio && !speech.audio.paused)).toBe(true);
  await page.locator('#speech-timer').selectOption('60'); await expect(page.locator('#speech-timer-status')).toContainText('60:00');
  await page.locator('#speech-timer').selectOption('off'); await expect(page.locator('#speech-timer-status')).toBeEmpty();
  await page.locator('#speech-timer').selectOption('15');
  await page.locator('#speech-play').click(); await page.locator('#speech-close').click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await page.clock.fastForward(15 * 60000);
  await expect.poll(() => page.evaluate(() => speech.active)).toBe(false);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.locator('#speech-toggle').click(); await expect(page.locator('#speech-status')).toHaveText('定时结束 · 已停止朗读');
  await expect(page.locator('#speech-timer')).toHaveValue('off');
  await expect(page.frameLocator('#book-frame').locator('.reader-speaking')).toHaveCount(0);
  await page.locator('#speech-play').click(); await expect.poll(() => page.evaluate(() => speech.audio && !speech.audio.paused)).toBe(true);
  await page.locator('#speech-timer').selectOption('30'); await page.locator('#speech-stop').click();
  await expect(page.locator('#speech-timer')).toHaveValue('off');
  await page.locator('#speech-timer').selectOption('15'); await page.locator('#back-button').click();
  await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#speech-timer')).toHaveValue('off');
  await closeNormally(); await launch(); await stubSpeech();
  await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#speech-toggle').click(); await expect(page.locator('#speech-timer')).toHaveValue('off');
});

test('End-of-chapter timer overrides automatic listening and does not advance into the next chapter', async () => {
  await stubSpeech(); await speechChapters(['<p id="first">第一章正文。</p>', '<p>不应该自动读到这里。</p>']);
  await page.locator('#speech-timer').focus(); await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => chapterIndex)).toBe(0);
  await page.locator('#speech-timer').selectOption('chapter'); await page.locator('#speech-play').click();
  await expect(page.frameLocator('#book-frame').locator('#first')).toHaveClass(/reader-speaking/);
  await finishAudio(); await expect(page.locator('#speech-status')).toHaveText('本章已读完 · 定时停止');
  expect(await page.evaluate(() => chapterIndex)).toBe(0);
  expect(await application.evaluate(() => globalThis.speechTest.requests)).toHaveLength(1);
});

test('Expired timer cancels voice preparation and late audio cannot restart playback', async () => {
  await stubSpeech({ delay: 1200 }); await example(); await page.locator('#speech-toggle').click();
  await page.clock.install(); await page.locator('#speech-timer').selectOption('15');
  await page.locator('#speech-play').click(); await expect(page.locator('#speech-status')).toContainText('准备');
  await page.clock.fastForward(15 * 60000);
  await expect(page.locator('#speech-status')).toHaveText('定时结束 · 已停止朗读');
  await page.waitForTimeout(1400);
  expect(await page.evaluate(() => speech.audio)).toBeNull();
  await expect(page.frameLocator('#book-frame').locator('.reader-speaking')).toHaveCount(0);
  await expect(page.locator('#speech-resume')).toBeHidden();
});

test('Chapter loading can retry repeatedly, pause before next playback and cancel without obsolete audio', async () => {
  await stubSpeech(); await speechChapters(['<p id="first">第一章正文。</p>', '<p id="next">下一章正文。</p>']);
  await page.evaluate(() => {
    const advance = speech.context.advanceChapter; let failures = 2;
    speech.context.advanceChapter = async index => {
      if (failures-- > 0) throw new Error('章节暂时无法读取');
      await new Promise(resolve => setTimeout(resolve, 700)); return advance(index);
    };
  });
  const frame = page.frameLocator('#book-frame');
  await page.locator('#speech-play').click(); await expect(frame.locator('#first')).toHaveClass(/reader-speaking/);
  await finishAudio(); await expect(page.locator('#speech-play')).toHaveText('重试');
  await page.locator('#speech-play').click(); await expect(page.locator('#speech-play')).toHaveText('重试');
  await page.locator('#speech-play').click(); await expect(page.locator('#speech-status')).toContainText('进入下一章');
  await page.locator('#speech-play').click();
  await expect(frame.locator('#next')).toBeVisible(); await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  await expect(page.locator('#speech-play')).toHaveText('▷ 继续');
  await page.locator('#speech-play').click(); await expect(frame.locator('#next')).toHaveClass(/reader-speaking/);
  await page.locator('#speech-stop').click(); await page.locator('#previous-chapter').click();
  await expect(frame.locator('#first')).toBeVisible();
  await page.locator('#speech-play').click(); await expect(frame.locator('#first')).toHaveClass(/reader-speaking/);
  await finishAudio(); await expect(page.locator('#speech-status')).toContainText('进入下一章');
  await page.locator('#speech-stop').click(); await page.waitForTimeout(1000);
  expect(await page.evaluate(() => speech.audio)).toBeNull(); expect(await page.evaluate(() => chapterIndex)).toBe(0);
  await expect(frame.locator('.reader-speaking')).toHaveCount(0);
});

test('A sleep deadline reached during automatic chapter loading cannot start the next audio', async () => {
  await stubSpeech(); await speechChapters(['<p id="first">第一章正文。</p>', '<p>不应该读到的下一章。</p>']);
  await page.locator('#speech-play').click(); await expect(page.frameLocator('#book-frame').locator('#first')).toHaveClass(/reader-speaking/);
  await page.clock.install(); await page.locator('#speech-timer').selectOption('15');
  await page.evaluate(() => {
    const advance = speech.context.advanceChapter;
    speech.context.advanceChapter = async index => { await new Promise(resolve => setTimeout(resolve, 1200)); return advance(index); };
  });
  await finishAudio(); await page.clock.runFor(200); await expect(page.locator('#speech-status')).toContainText('进入下一章');
  await page.clock.fastForward(15 * 60000); await page.clock.runFor(1500);
  await expect(page.locator('#speech-status')).toHaveText('定时结束 · 已停止朗读');
  expect(await page.evaluate(() => speech.audio)).toBeNull(); expect(await page.evaluate(() => chapterIndex)).toBe(0);
  expect(await application.evaluate(() => globalThis.speechTest.requests)).toHaveLength(1);
});

test('Resuming another chapter preserves the timer and honours pause or stop during restoration', async () => {
  await stubSpeech(); await speechChapters(['<p id="first">第一章正文。</p>', '<p id="second">第二章正文。</p>']);
  const frame = page.frameLocator('#book-frame');
  await page.locator('#speech-play').click(); await expect(frame.locator('#first')).toHaveClass(/reader-speaking/);
  await expect(page.locator('#speech-resume')).toBeVisible();
  await page.locator('#speech-stop').click(); await page.locator('#next-chapter').click();
  await expect(frame.locator('#second')).toBeVisible();
  await page.evaluate(() => {
    const advance = speech.context.advanceChapter;
    speech.context.advanceChapter = async index => { await new Promise(resolve => setTimeout(resolve, 700)); return advance(index); };
  });
  await page.locator('#speech-timer').selectOption('30'); await page.locator('#speech-resume').click();
  await expect(page.locator('#speech-status')).toContainText('恢复上次听读'); await page.locator('#speech-play').click();
  await expect(frame.locator('#first')).toBeVisible(); await expect(frame.locator('.reader-speaking')).toHaveCount(0);
  await expect(page.locator('#speech-play')).toHaveText('▷ 继续'); await expect(page.locator('#speech-timer')).toHaveValue('30');
  await page.locator('#speech-play').click(); await expect(frame.locator('#first')).toHaveClass(/reader-speaking/);
  await page.locator('#speech-stop').click(); await page.locator('#next-chapter').click(); await expect(frame.locator('#second')).toBeVisible();
  await page.locator('#speech-timer').selectOption('15'); await page.locator('#speech-resume').click();
  await expect(page.locator('#speech-status')).toContainText('恢复上次听读'); await page.locator('#speech-stop').click();
  await page.waitForTimeout(1000); expect(await page.evaluate(() => chapterIndex)).toBe(1);
  expect(await page.evaluate(() => speech.audio)).toBeNull(); await expect(page.locator('#speech-timer')).toHaveValue('off');
});

test('Speech cleanup skips marked pages and adjacent duplicate headings, preserves visible text and saved block mapping', async () => {
  const html = '<h1 id="spoken-title">第12章 重逢</h1><h2>第12章 重逢</h2><p role="doc-pagebreak">17</p><p>第 18 页</p><p id="spoken-body">清晨的<br>阳光，日期2026-10-15，增长１２．５％。<span epub:type="pagebreak">19</span></p><p id="year">1984</p><p id="english">Hello<br>world.</p>';
  await stubSpeech(); await speechChapters([html]);
  const frame = page.frameLocator('#book-frame');
  await page.locator('#speech-play').click(); await expect(frame.locator('#spoken-title')).toHaveClass(/reader-speaking/);
  await finishAudio(); await expect(frame.locator('#spoken-body')).toHaveClass(/reader-speaking/);
  await expect.poll(() => page.evaluate(() => current.listeningPosition?.block)).toBe(4);
  expect(await frame.locator('#spoken-body').textContent()).toBe('清晨的阳光，日期2026-10-15，增长１２．５％。19');
  await finishAudio(); await expect(frame.locator('#year')).toHaveClass(/reader-speaking/);
  await finishAudio(); await expect(frame.locator('#english')).toHaveClass(/reader-speaking/);
  expect(await application.evaluate(() => globalThis.speechTest.requests)).toEqual(['第十二章重逢', '清晨的阳光，日期二零二六年十月十五日，增长百分之十二点五。', '1984', 'Hello world.']);
  await finishAudio(); await expect(page.locator('#speech-status')).toHaveText('全书已读完');
});

test('Four soft backgrounds, tint and typography preserve the reading position and survive restart', async () => {
  await example(); const frame = page.frameLocator('#book-frame');
  await frame.locator('#p30').evaluate(node => node.scrollIntoView()); const before = await currentPosition();
  await page.locator('#settings-button').click();
  const colors = [];
  for (const theme of ['white', 'blue', 'gray', 'sand']) {
    await page.locator('#reading-background').selectOption(theme);
    colors.push(await frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor));
    await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-${theme}.png`) });
  }
  expect(new Set(colors).size).toBe(4);
  await page.locator('#reading-background').selectOption('blue');
  await page.locator('#background-tint').evaluate(input => { input.value = '1'; input.dispatchEvent(new Event('input')); });
  await expect.poll(() => frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(225, 239, 250)');
  expect(Math.abs((await currentPosition()).block - before.block)).toBeLessThanOrEqual(1);
  await closeNormally(); await launch(); await page.locator('#continue-button').click();
  await expect(page.locator('#chapter-loading')).toBeHidden(); await expect(page.locator('#reading-background')).toHaveValue('blue');
  await expect(page.locator('#background-tint')).toHaveValue('1');
  await page.locator('#settings-button').click(); await page.locator('#reset-settings').click();
  await expect(page.locator('#reading-background')).toHaveValue('white'); await expect(page.locator('#background-tint')).toHaveValue('0.6');
});

test('Mouse selection alone, changing selection color and cancelling a note never save an excerpt', async () => {
  await example(); const frame = page.frameLocator('#book-frame');
  await frame.locator('#p25').scrollIntoViewIfNeeded();
  await frame.locator('#p25').click({ clickCount: 3 });
  await expect(page.locator('#selection-tools')).toBeVisible();
  expect(await page.evaluate(() => current.annotations.length)).toBe(0);
  await page.locator('#selection-color').selectOption('blue');
  expect(await page.evaluate(() => current.annotations.length)).toBe(0);
  await page.locator('#selection-note').click(); await page.locator('#note-cancel').click();
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(0);
  expect(JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8')).books[0].annotations).toEqual([]);
  await closeNormally(); await launch(); await page.locator('#continue-button').click();
  await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(0);
  await selectPassage(); await page.locator('#selection-highlight').click();
  await expect(page.locator('.note-entry')).toHaveCount(1);
  const saved = await page.evaluate(() => current.annotations[0]);
  await selectPassage();
  expect(await page.evaluate(() => current.annotations[0])).toEqual(saved);
  await expect(page.locator('.note-entry')).toHaveCount(1);
});

test('Select, highlight, edit a note, reflow, restart, jump back and undo deletion', async () => {
  await example(); let frame = page.frameLocator('#book-frame');
  await selectPassage(); await page.locator('#selection-highlight').click();
  await expect.poll(() => page.evaluate(() => current.annotations?.length)).toBe(1);
  const original = await frame.locator('#p25').textContent();
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(1);
  await page.locator('.note-actions').getByText('编辑').click(); await page.locator('#note-text').fill('这句话值得记下来。');
  await page.locator('#note-save').click(); await expect(page.locator('#note-dialog')).not.toBeVisible();
  await expect(page.locator('.note-thought')).toHaveText('这句话值得记下来。');
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-notes.png`) });
  await page.locator('#close-tools').click(); await page.locator('#settings-button').click();
  await page.locator('#font-family').selectOption('wenkai'); await page.locator('#reading-background').selectOption('sand');
  await expect.poll(() => frame.locator('article').evaluate(node => node.ownerDocument.defaultView.CSS.highlights.get('reader-notes')?.size)).toBe(1);
  expect(await frame.locator('#p25').textContent()).toBe(original);
  await page.locator('#close-settings').click(); await page.locator('#next-chapter').click();
  await expect(page.locator('#chapter-loading')).toBeHidden(); await closeNormally(); await launch();
  await page.locator('#continue-button').click(); frame = page.frameLocator('#book-frame');
  await expect(frame.locator('article')).toBeVisible(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#notes-button').click(); await expect(page.locator('.note-thought')).toHaveText('这句话值得记下来。');
  await page.locator('.note-entry .reading-result').click(); await expect(page.locator('#chapter-title')).toHaveText('慢下来，翻开一页');
  await expect.poll(() => frame.locator('#p25').evaluate(node => node.getBoundingClientRect().top)).toBeLessThan(100);
  await expect(page.locator('#return-position-button')).toBeEnabled();
  await page.locator('#notes-button').click(); await page.locator('[aria-label="删除摘录"]').click();
  await expect(page.locator('.note-entry')).toHaveCount(0); await page.locator('#toast').getByText('撤销').click();
  await expect(page.locator('.note-entry')).toHaveCount(1);
});

test('Excerpt panel exports Markdown and plain text without AI-only passages', async () => {
  await example(); await selectPassage(); await page.locator('#selection-note').click();
  await page.locator('#note-text').fill('导出的阅读想法'); await page.locator('#note-save').click();
  await expect(page.locator('#note-dialog')).not.toBeVisible(); await page.locator('#notes-button').click();
  const markdown = path.join(directory, 'reading-notes.md');
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, markdown);
  await page.locator('#note-export-markdown').click(); await expect(page.locator('#toast')).toContainText('已导出 1 条摘录与笔记');
  const markdownText = await fs.readFile(markdown, 'utf8');
  expect(markdownText).toContain('# 给阅读留一点时间'); expect(markdownText).toContain('导出的阅读想法');
  const plain = path.join(directory, 'reading-notes.txt');
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, plain);
  await page.locator('#note-export-text').click(); await expect(page.locator('#toast')).toContainText('已导出 1 条摘录与笔记');
  expect(await fs.readFile(plain, 'utf8')).toContain('我的笔记：导出的阅读想法');
});

test('Cross-paragraph notes preserve exact text, escape markup and recover from failed saves', async () => {
  await example(); const frame = page.frameLocator('#book-frame');
  await selectPassage('#p20', '#p21'); await page.locator('#selection-note').click();
  await expect(page.locator('#note-quote')).toContainText('第 21 段。'); await expect(page.locator('#note-quote')).toContainText('第 22 段。');
  await page.locator('#note-text').fill('<img src=x onerror="window.noteRan=true">我的笔记');
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try { await page.locator('#note-save').click(); await expect(page.locator('#note-error')).toContainText('检查磁盘空间和文件夹权限'); }
  finally { await fs.rmdir(temp); }
  expect(await page.evaluate(() => current.annotations?.length || 0)).toBe(0);
  await page.locator('#note-save').click(); await expect(page.locator('#note-dialog')).not.toBeVisible();
  await page.locator('#notes-button').click(); await expect(page.locator('.note-thought')).toContainText('<img src=x');
  await expect(page.locator('.note-thought img')).toHaveCount(0);
  const annotation = await page.evaluate(() => current.annotations[0]);
  expect(await frame.locator('article').evaluate((node, value) => node.ownerDocument.defaultView.parent.ReadingContent.annotationRange(node.ownerDocument, value).toString(), annotation)).toBe(annotation.quote);
});

test('Backup export, preview, empty-shelf recovery and repeated merge preserve notes and backgrounds', async () => {
  await example(); await selectPassage(); await page.locator('#selection-note').click(); await page.locator('#note-text').fill('备份里的笔记'); await page.locator('#note-save').click();
  await expect(page.locator('#note-dialog')).not.toBeVisible();
  await page.locator('#settings-button').click(); await page.locator('#reading-background').selectOption('blue');
  await page.locator('#back-button').click();
  const filename = path.join(ROOT, '.test-data', `backup-${Date.now()}.readingtext`);
  await application.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, filename);
  await page.locator('#backup-button').click(); await page.locator('#backup-export').click(); await expect(page.locator('#backup-status')).toContainText('包含 1 本书');
  await page.locator('#backup-close').click();
  await page.locator('.remove-book').click(); await page.locator('#confirm-delete').click(); await expect(page.locator('#empty-state')).toBeVisible();
  await page.locator('#backup-button').click(); await page.locator('#backup-choose').click();
  await expect(page.locator('#restore-summary')).toContainText('新增 1 本'); await expect(page.locator('#restore-summary')).toContainText('1 条摘录');
  await expect(page.locator('#book-count')).toHaveText('0');
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try { await page.locator('#backup-restore').click(); await expect(page.locator('#backup-error')).toContainText('检查磁盘空间和文件夹权限'); }
  finally { await fs.rmdir(temp); }
  await expect(page.locator('#book-count')).toHaveText('0');
  await page.locator('#backup-restore').click(); await expect(page.locator('#backup-status')).toContainText('恢复完成');
  await page.locator('#backup-choose').click(); await expect(page.locator('#restore-summary')).toContainText('新增 0 本');
  await page.locator('#backup-restore').click(); await expect(page.locator('#backup-status')).toContainText('新增 0 本书、0 条摘录');
  await page.locator('#backup-close').click(); await page.locator('.book-open').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await expect(page.locator('#reading-background')).toHaveValue('blue'); await page.locator('#notes-button').click();
  await expect(page.locator('.note-entry')).toHaveCount(1); await expect(page.locator('.note-thought')).toHaveText('备份里的笔记');
});

test('Cancelled, damaged and failed backup operations leave the shelf available for retry', async () => {
  await example(); await page.locator('#back-button').click(); await page.locator('#backup-button').click();
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.locator('#backup-export').click(); await expect(page.locator('#backup-status')).toHaveText('已取消导出。');
  await page.locator('#backup-choose').click(); await expect(page.locator('#backup-status')).toHaveText('已取消选择。');
  const invalid = path.join(ROOT, '.test-data', `bad-backup-${Date.now()}.readingtext`); await fs.writeFile(invalid, 'not a backup');
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, invalid);
  await page.locator('#backup-choose').click(); await expect(page.locator('#backup-error')).toContainText('原有书架未改动');
  await expect(page.locator('#restore-preview')).toBeHidden(); await expect(page.locator('#book-count')).toHaveText('1');
  await page.locator('#backup-close').click(); await page.locator('.book-open').click(); await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
});

test('Highlighting during speech keeps the paragraph DOM and playback intact', async () => {
  await stubSpeech(); await example(); await page.locator('#speech-toggle').click();
  await page.locator('#speech-play').click(); await expect(page.frameLocator('#book-frame').locator('h1')).toHaveClass(/reader-speaking/);
  const before = await page.frameLocator('#book-frame').locator('article').textContent();
  await selectPassage('h1'); await page.locator('#selection-highlight').click();
  await expect.poll(() => page.evaluate(() => current.annotations?.length)).toBe(1);
  expect(await page.evaluate(() => speech.active && !speech.audio.paused)).toBe(true);
  expect(await page.frameLocator('#book-frame').locator('article').textContent()).toBe(before);
});

test('Four highlight colors survive selection, edits, filtering, reflow, chapter jumps and restart', async () => {
  await example(); let frame = page.frameLocator('#book-frame');
  const styles = await frame.locator('#p20').evaluate(node => ['', '-blue', '-green', '-purple'].map(suffix => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node, `::highlight(reader-notes${suffix})`);
    return { line: style.textDecorationLine, background: style.backgroundColor };
  }));
  expect(styles.every(style => style.line === 'none' && style.background !== 'rgba(0, 0, 0, 0)')).toBe(true);
  await expect(frame.locator('a').first()).toHaveCSS('text-decoration-line', 'underline');
  await expect(page.locator('#selection-highlight')).toHaveText('标注');
  const colors = ['yellow', 'blue', 'green', 'purple'];
  for (const [index, color] of colors.entries()) {
    await selectPassage(`#p${20 + index}`);
    await page.locator('#selection-color').selectOption(color);
    await page.locator('#selection-highlight').click();
    await expect.poll(() => page.evaluate(() => current.annotations?.length)).toBe(index + 1);
  }
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(4);
  await page.locator('#note-filter').selectOption('blue'); await expect(page.locator('.note-entry')).toHaveCount(1);
  await expect(page.locator('.note-entry')).toHaveAttribute('data-color', 'blue');
  await page.locator('.note-actions').getByText('编辑').click(); await page.locator('#note-text').fill('蓝色的想法');
  await page.locator('#note-color').selectOption('purple'); await page.locator('#note-save').click();
  await expect(page.locator('#note-dialog')).not.toBeVisible(); await expect(page.locator('.note-entry')).toHaveCount(0);
  await page.locator('#note-filter').selectOption('purple'); await expect(page.locator('.note-entry')).toHaveCount(2);
  await expect(page.locator('.note-thought')).toHaveText('蓝色的想法');
  await page.locator('#note-filter').selectOption('all');
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-colors.png`) });
  await page.locator('#close-tools').click(); await page.locator('#settings-button').click();
  await page.locator('#font-family').selectOption('wenkai'); await page.locator('#reading-background').selectOption('blue');
  expect(await frame.locator('article').evaluate(node => Object.fromEntries(['', '-blue', '-green', '-purple'].map(suffix => [suffix, node.ownerDocument.defaultView.CSS.highlights.get(`reader-notes${suffix}`)?.size])))).toEqual({ '': 1, '-blue': 0, '-green': 1, '-purple': 2 });
  await page.locator('#close-settings').click(); await page.locator('#next-chapter').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await closeNormally(); await launch(); await page.locator('#continue-button').click(); frame = page.frameLocator('#book-frame');
  await expect(frame.locator('article')).toBeVisible(); await expect.poll(() => page.evaluate(() => busy)).toBe(false);
  await page.locator('#notes-button').click(); await expect(page.locator('#tools-panel')).toBeVisible(); await expect(page.locator('.note-entry')).toHaveCount(4);
  const purple = page.locator('.note-entry').filter({ hasText: '蓝色的想法' }); await expect(purple).toHaveAttribute('data-color', 'purple');
  await purple.locator('.reading-result').click(); await expect(page.locator('#chapter-title')).toHaveText('慢下来，翻开一页');
  await expect.poll(() => frame.locator('article').evaluate(node => node.ownerDocument.defaultView.CSS.highlights.get('reader-note-active-purple')?.size)).toBe(1);
});

test('Voice switching cancels old preparation and preserves pause, speed, manual following and timer', async () => {
  await stubSpeech({ delay: 500 }); await example(); await page.locator('#speech-toggle').click();
  await expect(page.locator('#speech-voice option')).toHaveCount(3); await expect(page.locator('#speech-voice')).toHaveValue('Serena');
  await setRate(.7); await page.locator('#speech-play').click(); await page.locator('#speech-play').click();
  await page.locator('#speech-timer').selectOption('15');
  await page.locator('#speech-voice').selectOption('Vivian'); await expect(page.locator('#speech-voice-name')).toHaveText('Vivian');
  await expect(page.locator('#speech-status')).toHaveText('已暂停');
  expect(await page.evaluate(() => speech.audio.paused && speech.paused)).toBe(true);
  await expect(page.frameLocator('#book-frame').locator('.reader-speaking')).toHaveCount(0);
  await expect(page.locator('#speech-timer')).toHaveValue('15'); await expect(page.locator('#speech-rate')).toHaveValue('0.7');
  await page.locator('#speech-play').click(); await expect(page.locator('#speech-status')).toHaveText('正在朗读 · Vivian');
  await page.frameLocator('#book-frame').locator('body').evaluate(node => node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 })));
  await page.locator('#speech-voice').selectOption('Uncle_Fu'); await expect(page.locator('#speech-status')).toHaveText('正在朗读 · Uncle_Fu');
  await expect(page.locator('#speech-follow')).toBeVisible(); await expect(page.locator('#speech-timer')).toHaveValue('15');
  expect(await page.evaluate(() => speech.audio.playbackRate)).toBe(.7);
  const requests = await application.evaluate(() => globalThis.speechTest.voices);
  expect(requests.map(value => value.speaker)).toEqual(expect.arrayContaining(['Serena', 'Vivian', 'Uncle_Fu']));
  expect(requests.every(value => value.style === 'calm')).toBe(true);
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-voices.png`) });
  await closeNormally(); await launch(); await stubSpeech(); await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  if (await page.locator('#speech-bar').isHidden()) await page.locator('#speech-toggle').click();
  await expect(page.locator('#speech-voice')).toHaveValue('Uncle_Fu'); await expect(page.locator('#speech-rate')).toHaveValue('0.7'); await expect(page.locator('#speech-timer')).toHaveValue('off');
});

test('Manager auditions all voices and rapid switching never plays a cancelled voice', async () => {
  await stubSpeech({ delay: 450 }); await page.locator('#voice-manage-shelf').click();
  for (const voice of ['Vivian', 'Uncle_Fu', 'Serena']) {
    await page.locator('#voice-choice').selectOption(voice); await expect(page.locator('#voice-preview')).toHaveText(`试听 ${voice}`);
    await page.locator('#voice-preview').click(); await expect(page.locator('#voice-pack-status')).toHaveText(`正在朗读 · ${voice}`);
  }
  await page.locator('#voice-choice').selectOption('Vivian'); await page.locator('#voice-choice').selectOption('Uncle_Fu');
  await expect(page.locator('#voice-pack-status')).toHaveText('正在朗读 · Uncle_Fu');
  expect(await page.evaluate(() => speech.speaker)).toBe('Uncle_Fu');
  await page.locator('#voice-close').click(); expect(await page.evaluate(() => speech.active)).toBe(false);
  await page.waitForTimeout(500); expect(await page.evaluate(() => speech.audio)).toBe(null);
});
