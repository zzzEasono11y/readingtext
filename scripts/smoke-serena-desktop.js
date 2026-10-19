const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { version } = require('../package.json');
const JSZip = require('jszip');
const { makeEpub } = require('../tests/fixtures');

(async () => {
  if (!process.env.READINGTEXT_VOICE_HOME) throw new Error('请设置 READINGTEXT_VOICE_HOME。');
  const root = path.resolve(__dirname, '..');
  const executablePath = process.env.READINGTEXT_EXECUTABLE;
  const directory = path.join(root, '.test-data', `real-serena-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [root],
    env: { ...process.env, READINGTEXT_DATA: directory } });
  try {
    const page = await app.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.argv.includes('--install')) {
      await page.exposeFunction('reportVoiceInstall', message => console.log(message));
      await page.evaluate(async () => {
        window.reader.onVoiceStatus(state => window.reportVoiceInstall(state.message));
        await window.reader.installVoice();
      });
    }
    await page.locator('#example-button').click();
    await expect(page.locator('.book-card')).toHaveCount(1); await page.locator('.book-open').click();
    await expect(page.locator('#chapter-loading')).toBeHidden();
    await page.locator('#speech-toggle').click();
    const coldStarted = performance.now();
    await page.locator('#speech-play').click();
    const body = page.frameLocator('#book-frame');
    await expect(body.locator('h1')).toHaveClass(/reader-speaking/, { timeout: 120000 });
    console.log('首次打开书籍到播放等待秒数:', ((performance.now() - coldStarted) / 1000).toFixed(2));
    await expect(page.locator('#speech-status')).toContainText('正在朗读');
    await page.locator('#speech-play').click();
    await expect(page.locator('#speech-play')).toHaveText('▷ 继续');
    await page.locator('#speech-rate').evaluate(input => { input.value = '.8'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); }); await page.locator('#speech-play').click();
    await expect(body.locator('#p0')).toHaveClass(/reader-speaking/, { timeout: 60000 });
    await page.screenshot({ path: path.join(root, `dist/ReadingText-${version}-preview.png`) });
    await page.locator('#speech-next').click(); await expect(body.locator('#p1')).toHaveClass(/reader-speaking/, { timeout: 60000 });
    await page.locator('#speech-previous').click(); await expect(body.locator('#p0')).toHaveClass(/reader-speaking/, { timeout: 60000 });
    await page.locator('#speech-stop').click(); await expect(body.locator('.reader-speaking')).toHaveCount(0);
    await page.locator('#speech-resume').click(); await expect(body.locator('#p0')).toHaveClass(/reader-speaking/, { timeout: 60000 });
    await page.locator('#back-button').click(); await expect(page.locator('#continue-section')).toBeVisible();
    // Exercise the normal importer and a real chapter boundary with short original prose.
    const zip = await JSZip.loadAsync(await makeEpub({ count: 2, title: '跨章与数字朗读测试' }));
    const original = '在2026-10-15这天，增长12.5%，买书花了35元。';
    const spoken = '在二零二六年十月十五日这天，增长百分之十二点五，买书花了三十五元。';
    zip.file('OPS/chapters/第1章.xhtml', `<html><body><p id="numbers">${original}</p></body></html>`);
    zip.file('OPS/chapters/第2章.xhtml', '<html><body><p id="end">下一章已经接上，今天的阅读到这里告一段落。</p></body></html>');
    const filename = path.join(directory, 'listening.epub'); await fs.writeFile(filename, await zip.generateAsync({ type: 'nodebuffer' }));
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, filename);
    await page.locator('#import-button').click();
    await page.locator('.book-card').filter({ hasText: '跨章与数字朗读测试' }).locator('.book-open').click();
    await expect(page.locator('#chapter-loading')).toBeHidden();
    if (await page.locator('#speech-bar').isHidden()) await page.locator('#speech-toggle').click();
    await page.locator('#speech-play').click(); await expect(body.locator('#numbers')).toHaveClass(/reader-speaking/, { timeout: 60000 });
    expect(await page.evaluate(() => speech.items[0].text)).toBe(spoken);
    await expect.poll(() => page.evaluate(() => speech.player?.source.readyState), { timeout: 60000 }).toBe('ended');
    await page.evaluate(() => speech.audio.dispatchEvent(new Event('ended')));
    await expect(body.locator('#end')).toHaveClass(/reader-speaking/, { timeout: 60000 });
    await page.locator('#speech-timer').selectOption('chapter');
    await expect.poll(() => page.evaluate(() => speech.player?.source.readyState), { timeout: 60000 }).toBe('ended');
    await page.evaluate(() => speech.audio.dispatchEvent(new Event('ended')));
    await expect(page.locator('#speech-status')).toHaveText('本章已读完 · 定时停止');
    await expect(page.locator('#speech-timer')).toHaveValue('off');
    expect(await page.evaluate(() => current.listeningPosition.chapter)).toBe(1);
    const bytes = await page.evaluate(async text => Array.from(await window.reader.synthesize(text)), spoken);
    await fs.writeFile(path.join(root, `dist/Serena-${version}-numbers.wav`), Buffer.from(bytes));
    // Exercise the shared model through the actual UI, including a switch while paused.
    await page.locator('#speech-voice').selectOption('Vivian'); await page.locator('#speech-play').click();
    await expect(page.locator('#speech-status')).toHaveText('正在朗读 · Vivian', { timeout: 60000 });
    await expect.poll(() => page.evaluate(() => speech.player?.source.readyState), { timeout: 60000 }).toBe('ended');
    await page.locator('#speech-play').click(); await expect(page.locator('#speech-play')).toHaveText('▷ 继续');
    await page.locator('#speech-voice').selectOption('Uncle_Fu');
    await expect(page.locator('#speech-status')).toHaveText('已暂停', { timeout: 60000 });
    expect(await page.evaluate(() => speech.audio.paused)).toBe(true);
    await page.locator('#speech-play').click(); await expect(page.locator('#speech-status')).toHaveText('正在朗读 · Uncle_Fu', { timeout: 60000 });
    await expect(body.locator('#end')).toHaveClass(/reader-speaking/);
    await page.screenshot({ path: path.join(root, `dist/ReadingText-${version}-real-voices.png`) });
    await page.locator('#speech-stop').click(); await page.locator('#voice-manage-reader').click();
    await page.locator('#voice-choice').selectOption('Serena'); await page.locator('#voice-preview').click();
    await expect(page.locator('#voice-pack-status')).toHaveText('正在朗读 · Serena', { timeout: 60000 });
    await page.locator('#voice-close').click(); await expect.poll(() => page.evaluate(() => speech.active)).toBe(false);
    expect(errors).toEqual([]);
    await Promise.all([app.waitForEvent('close'), app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())]);
    console.log('真实语音：三种音色、暂停切换、试听、离线播放、高亮、语速、跳段、恢复、自动跨章、数字朗读、定时与退出均通过。');
  } finally { await app.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
