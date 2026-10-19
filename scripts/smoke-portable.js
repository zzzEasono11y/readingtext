const { chromium, expect } = require('@playwright/test');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { version } = require('../package.json');

(async () => {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, '.test-data', `portable-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(path.join(root, `dist/ReadingText-${version}-Windows.exe`),
    [`--remote-debugging-port=${port}`], { windowsHide: true,
      env: { ...process.env, READINGTEXT_DATA: directory }, stdio: 'ignore' });
  let browser;
  try {
    const address = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { ready = (await fetch(`${address}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await delay(250);
    }
    if (!ready) throw new Error('免安装程序未能在规定时间内启动。');
    browser = await chromium.connectOverCDP(address);
    const page = browser.contexts()[0].pages()[0];
    await expect(page.locator('#empty-state')).toBeVisible();
    await page.locator('#example-button').click();
    await expect(page.locator('.book-card')).toHaveCount(1);
    await page.locator('.book-open').click();
    await expect(page.frameLocator('#book-frame').locator('h1')).toHaveText('慢下来，翻开一页');
    await expect(page.locator('#chapter-loading')).toBeHidden();
    await page.locator('#next-chapter').click();
    await expect(page.locator('#chapter-title')).toHaveText('在文字里，遇见风景');
    await page.locator('#back-button').click();
    await expect(page.locator('#continue-section')).toBeVisible();
    const filename = process.env.READINGTEXT_SMOKE_EPUB || path.join(root, 'assets/demo.epub');
    const id = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    const session = await page.context().newCDPSession(page);
    const bounds = await page.locator('#book-grid').boundingBox();
    const point = { x: bounds.x + 20, y: bounds.y + 10, data: { items: [], files: [filename], dragOperationsMask: 1 } };
    try {
      await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point });
      await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...point });
      await expect(page.locator('#drop-overlay')).toBeVisible();
      await session.send('Input.dispatchDragEvent', { type: 'drop', ...point });
      await expect(page.locator('#drop-overlay')).toBeHidden();
      await expect(page.locator('#toast')).toContainText(/已导入/);
      await page.locator(`.book-open[data-book-id="${id}"]`).click();
      await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible();
      await expect(page.locator('#chapter-loading')).toBeHidden();
      const state = JSON.parse(await fs.readFile(path.join(directory, 'library.json'), 'utf8'));
      if (!state.books.some(book => book.id === id)) throw new Error('拖入的 EPUB 未写入书架。');
    } finally { await session.detach(); }
    await page.evaluate(() => window.close());
    await Promise.race([once(child, 'exit'), delay(10000, null, { ref: false }).then(() => { throw new Error('免安装程序未正常退出。'); })]);
    console.log('免安装程序启动、示例导入、阅读、章节切换、真实文件拖入、进度保存和正常退出检查通过。');
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
