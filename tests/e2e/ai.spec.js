const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const KEY = 'sk-test-not-real-local-fixture';
let application, page, directory, errors;
async function launch() {
  const executablePath = process.env.READINGTEXT_EXECUTABLE;
  application = await electron.launch({ executablePath, args: executablePath ? [] : [ROOT], env: { ...process.env, READINGTEXT_DATA: directory } });
  page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('#import-button')).toBeVisible();
}
async function mock({ status = 200, delay = 40, failModels = false, answer = '这是一种可能的理解：这句话把阅读写成一段可以慢慢走的小路。\n<script>这段文字不会执行。</script>' } = {}) {
  await application.evaluate(({ session }, options) => {
    globalThis.aiTest = { requests: [], status: options.status, failModels: options.failModels, answer: options.answer };
    session.fromPartition('ai-service', { cache: false }).fetch = async (url, init) => {
      const request = { url, redirect: init.redirect, authorized: init.headers.Authorization === `Bearer ${options.key}`, body: init.body ? JSON.parse(init.body) : null };
      globalThis.aiTest.requests.push(request);
      if (url.endsWith('/models')) return Response.json(globalThis.aiTest.failModels ? { error: 'no models' } : { data: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek Pro' }] }, { status: globalThis.aiTest.failModels ? 503 : 200 });
      if (globalThis.aiTest.status !== 200) return new Response('error body must not be shown', { status: globalThis.aiTest.status });
      const text = globalThis.aiTest.answer; const parts = [text.slice(0, 14), text.slice(14)]; let index = 0;
      return new Response(new ReadableStream({
        start(controller) { init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); },
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, options.delay));
          if (init.signal.aborted) return;
          if (index < parts.length) controller.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[index++], reasoning_content: '不应显示的推理' } }] }) + '\n\n'));
          else { controller.enqueue(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }) + '\n\ndata: [DONE]\n\n')); controller.close(); }
        }
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, { status, delay, failModels, answer, key: KEY });
}
async function configure() {
  await page.locator('#ai-settings-shelf').click(); await page.locator('#ai-key').fill(KEY);
  await page.locator('#ai-settings-save').click(); await expect(page.locator('#ai-settings-status')).toContainText('设置已保存');
  await page.locator('#ai-settings-close').click();
}
async function passage() {
  await page.locator('#example-button').click(); await page.locator('.book-open').click();
  await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.frameLocator('#book-frame').locator('#p0').evaluate(node => { const doc = node.ownerDocument; const range = doc.createRange(); range.selectNodeContents(node); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range); });
  await expect(page.locator('#selection-tools')).toBeVisible(); await page.locator('#selection-ai').click(); await expect(page.locator('#ai-panel')).toBeVisible();
  await expect(page.locator('#ai-open-reader')).toHaveAttribute('aria-expanded', 'true');
}
async function send(text) { await page.locator('#ai-question').fill(text); await page.locator('#ai-send').click(); }
async function capture() {
  await page.locator('#ai-capture').click(); await expect(page.locator('#ai-capture-layer')).toBeVisible();
  const rect = await page.locator('#ai-capture-layer').boundingBox();
  await page.mouse.move(rect.x + 80, rect.y + 140); await page.mouse.down();
  await page.mouse.move(rect.x + 480, rect.y + 380, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('#ai-image-dialog')).toBeVisible();
  await expect.poll(() => page.locator('#ai-image-preview').evaluate(node => node.naturalWidth)).toBeGreaterThan(16);
}
async function closeNormally() { await Promise.all([application.waitForEvent('close'), application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())]); application = null; }
test.beforeEach(async ({}, info) => { directory = path.join(ROOT, '.test-data', `ai-${info.testIndex}-${Date.now()}`); await fs.mkdir(directory, { recursive: true }); errors = []; await launch(); });
test.afterEach(async () => { if (application) await application.close(); expect(errors).toEqual([]); });

test('DeepSeek setup detects models, auditions, protects credentials, persists the choice and clears only the key', async () => {
  await mock(); await page.locator('#ai-settings-shelf').click(); await page.locator('#ai-key').fill(KEY);
  await expect(page.locator('#ai-key')).toHaveAttribute('type', 'password'); await page.locator('#ai-key-show').click(); await expect(page.locator('#ai-key')).toHaveAttribute('type', 'text');
  await page.locator('#ai-detect').click(); await expect(page.locator('#ai-settings-status')).toContainText('发现 2 个文字模型');
  await page.locator('#ai-model-picker').selectOption('deepseek-v4-pro'); await expect(page.locator('#ai-model')).toHaveValue('deepseek-v4-pro');
  await page.locator('#ai-test').click(); await expect(page.locator('#ai-settings-status')).toContainText('测试成功');
  await page.locator('#ai-settings-save').click(); await expect(page.locator('#ai-settings-status')).toContainText('设置已保存'); await expect(page.locator('#ai-key')).toHaveValue('');
  const encrypted = await fs.readFile(path.join(directory, 'ai-settings.json'), 'utf8'); expect(encrypted).not.toContain(KEY); expect(encrypted).not.toContain(Buffer.from(KEY).toString('base64'));
  const requests = await application.evaluate(() => globalThis.aiTest.requests); expect(requests.every(value => value.authorized && value.redirect === 'error')).toBe(true);
  expect(requests.map(value => value.url)).toEqual(['https://api.deepseek.com/models', 'https://api.deepseek.com/chat/completions']);
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-ai-settings.png`) });
  await page.locator('#ai-settings-close').click(); await closeNormally(); await launch(); await mock();
  expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(0);
  await page.locator('#ai-settings-shelf').click(); await expect(page.locator('#ai-model')).toHaveValue('deepseek-v4-pro'); await expect(page.locator('#ai-key-state')).toHaveText('本机已保存密钥');
  expect(await page.evaluate(async () => JSON.stringify(await window.reader.aiStatus()))).not.toContain(KEY);
  await page.locator('#ai-key-clear').click(); await expect(page.locator('#ai-key-state')).toHaveText('尚未保存密钥');
});

test('A selected passage starts a streaming discussion, escapes output, drafts notes and resumes after restart', async () => {
  await mock({ delay: 90 }); await configure(); await passage(); const quote = await page.locator('#ai-quote').textContent();
  const original = await page.frameLocator('#book-frame').locator('article').textContent();
  await send('这里为什么用小路作比喻？'); await expect(page.locator('.ai-assistant')).toContainText('这是一种可能的理解');
  await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await expect(page.locator('.ai-assistant script')).toHaveCount(0); await expect(page.locator('#ai-messages')).not.toContainText('不应显示的推理');
  await application.evaluate(() => { globalThis.aiTest.answer = '也可以把“小路”理解为读者自己的节奏。原文允许我们停留、回想，而不必急于到达终点。这个比喻既写阅读，也可能让人想到生活中的选择。'; });
  await send('能换一种角度理解吗？'); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(2);
  const requests = await application.evaluate(() => globalThis.aiTest.requests.filter(value => value.body));
  expect(requests[0].body.messages[1].content).toContain(quote); expect(requests[1].body.messages).toHaveLength(5);
  expect(JSON.stringify(requests)).not.toContain(KEY); expect(requests.every(value => value.body.thinking.type === 'disabled')).toBe(true);
  expect(await page.frameLocator('#book-frame').locator('article').textContent()).toBe(original);
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-ai-reading.png`) });
  await page.locator('#ai-draft').click(); await expect(page.locator('#note-dialog')).toBeVisible();
  await expect(page.locator('#note-text')).toHaveValue(/AI 讨论草稿/);
  await page.locator('#note-text').fill('我修改过的理解。'); await page.locator('#note-save').click(); await expect(page.locator('#note-dialog')).not.toBeVisible();
  await closeNormally(); await launch(); await page.locator('#continue-button').click(); await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible(); await expect.poll(() => page.evaluate(() => busy)).toBe(false);
  await page.locator('#notes-button').click(); await page.locator('.note-actions').getByText('继续讨论').click();
  await expect(page.locator('.ai-user')).toHaveCount(3); await expect(page.locator('.ai-assistant')).toHaveCount(3);
  expect(await page.evaluate(() => current.annotations[0].note)).toBe('我修改过的理解。');
});

test('Unconfigured questions open setup without sending text; detection errors allow manual models and quota errors retry', async () => {
  await mock({ failModels: true, status: 402 }); await passage(); await send('解释一下');
  await expect(page.locator('#ai-settings-dialog')).toBeVisible(); expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(0);
  await page.locator('#ai-key').fill(KEY); await page.locator('#ai-detect').click(); await expect(page.locator('#ai-settings-error')).toContainText('服务繁忙');
  await page.locator('#ai-model').fill('deepseek-v4-pro'); await page.locator('#ai-settings-save').click(); await expect(page.locator('#ai-settings-status')).toContainText('设置已保存'); await page.locator('#ai-settings-close').click();
  await send('解释一下'); await expect(page.locator('#ai-error')).toContainText('余额不足');
  expect(await page.evaluate(() => current.annotations[0].discussion.length)).toBe(0); await expect(page.locator('#ai-question')).toHaveValue('解释一下');
  await application.evaluate(() => { globalThis.aiTest.status = 200; }); await page.locator('#ai-send').click();
  await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
});

test('Stop discards partial audio-free answers, keeps the question and cannot leak responses into another view', async () => {
  await mock({ delay: 500 }); await configure(); await passage(); await send('请解释一下');
  await expect(page.locator('.ai-assistant')).toContainText('这是一种'); await page.locator('#ai-stop').click();
  await expect(page.locator('#ai-error')).toContainText('已停止'); await expect(page.locator('#ai-question')).toHaveValue('请解释一下');
  expect(await page.evaluate(() => current.annotations[0].discussion.length)).toBe(0);
  await page.locator('#ai-send').click(); await page.locator('#ai-close').click(); await expect(page.locator('#ai-panel')).toBeHidden();
  await expect(page.locator('#ai-open-reader')).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(650); expect(await page.evaluate(() => current.annotations[0].discussion.length)).toBe(0);
  await page.locator('#back-button').click(); await expect(page.locator('#shelf-view')).toBeVisible();
});

test('A failed discussion save retries locally without another model request and prevents closing before recovery', async () => {
  await mock(); await configure(); await passage(); await expect(page.locator('#save-status')).toHaveText('进度已保存');
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try {
    await send('保存失败时也别丢回答。'); await expect(page.locator('#ai-retry-save')).toBeVisible(); await expect(page.locator('#ai-error')).toContainText('不会重新调用模型');
    expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(1);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()); await expect(page.locator('#toast')).toContainText('暂未关闭');
  } finally { await fs.rmdir(temp); }
  await page.locator('#ai-retry-save').click(); await expect(page.locator('#ai-retry-save')).toBeHidden();
  expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(1); expect(await page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await closeNormally();
});

test('Deleting an excerpt cancels its pending discussion; undo restores saved discussion and small windows stay usable', async () => {
  await mock({ delay: 200 }); await configure(); await passage(); await send('先保存这一轮');
  await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await page.locator('#ai-save-excerpt').click();
  await send('这一轮将在删除后被取消');
  await page.locator('#notes-button').click(); await page.locator('[aria-label="删除摘录"]').click();
  await expect(page.locator('#ai-panel')).toBeHidden(); await expect(page.locator('.note-entry')).toHaveCount(0);
  await page.locator('#toast').getByText('撤销').click(); await expect(page.locator('.note-entry')).toHaveCount(1);
  await page.locator('.note-actions').getByText('继续讨论').click(); await expect(page.locator('.ai-assistant')).toHaveCount(1);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  expect((await page.locator('#ai-scroll').boundingBox()).height).toBeGreaterThanOrEqual(160);
  await page.locator('#ai-question').fill('小窗口也能提问'); await page.locator('#ai-send').scrollIntoViewIfNeeded();
  const sendRect = await page.locator('#ai-send').boundingBox(); const speechRect = await page.locator('#speech-toggle').boundingBox();
  expect(sendRect.x < speechRect.x + speechRect.width && sendRect.x + sendRect.width > speechRect.x && sendRect.y < speechRect.y + speechRect.height && sendRect.y + sendRect.height > speechRect.y).toBe(false);
  await page.locator('#ai-send').click();
  await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(2);
});

test('A full discussion can still put its last answer into a note without another paid request', async () => {
  await mock(); await configure(); await passage();
  await page.evaluate(async () => {
    let value = current.annotations[0];
    for (let index = 0; index < 20; index++) value = await window.reader.saveAiTurn(current.id, value.id, {
      id: crypto.randomUUID(), parentId: value.discussion.at(-1)?.id || null, question: '讨论问题', answer: '最后的解读', model: 'deepseek-flash', createdAt: new Date().toISOString(), usage: {}, truncated: false
    });
    current.annotations[0] = value; await companion.open(current, value);
  });
  await expect(page.locator('#ai-draft')).toHaveText('将回答加入笔记'); await page.locator('#ai-draft').click();
  await expect(page.locator('#note-text')).toHaveValue(/最后的解读/); expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(0);
  await page.locator('#note-cancel').click();
});

test('Each excerpt keeps a separate remembered conversation and draft, with same-passage reopening and restart', async () => {
  await mock(); await configure(); await passage(); const firstId = await page.evaluate(() => current.annotations[0].id);
  await send('只属于第一段的记忆暗号A'); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await page.evaluate(async () => { const value = current.annotations[0]; current.annotations[0] = await window.reader.saveAnnotation(current.id, { ...value, color: 'blue' }); });
  await page.locator('#ai-question').fill('第一段还没发出的草稿');
  await page.frameLocator('#book-frame').locator('#p1').scrollIntoViewIfNeeded();
  await page.frameLocator('#book-frame').locator('#p1').evaluate(node => { const range = node.ownerDocument.createRange(); range.selectNodeContents(node); const selection = node.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await expect(page.locator('#selection-tools')).toBeVisible(); await page.locator('#selection-ai').click();
  await expect(page.locator('#ai-messages .ai-user')).toHaveCount(0); await expect(page.locator('#ai-question')).toHaveValue('');
  await send('只属于第二段的记忆暗号B'); await expect.poll(() => page.evaluate(() => current.annotations[1].discussion.length)).toBe(1);
  const secondRequest = await application.evaluate(() => globalThis.aiTest.requests.at(-1).body);
  expect(JSON.stringify(secondRequest)).not.toContain('记忆暗号A'); expect(JSON.stringify(secondRequest)).toContain('记忆暗号B');
  await page.locator('#ai-conversation').selectOption(firstId); await expect(page.locator('#ai-question')).toHaveValue('第一段还没发出的草稿');
  await expect(page.locator('#ai-messages')).toContainText('记忆暗号A'); await expect(page.locator('#ai-messages')).not.toContainText('记忆暗号B');
  await page.locator('#ai-close').click(); await page.frameLocator('#book-frame').locator('#p0').scrollIntoViewIfNeeded();
  await page.frameLocator('#book-frame').locator('#p0').evaluate(node => { const range = node.ownerDocument.createRange(); range.selectNodeContents(node); const selection = node.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await expect(page.locator('#selection-tools')).toBeVisible(); await page.locator('#selection-ai').click();
  await expect(page.locator('#ai-conversation')).toHaveValue(firstId); expect(await page.evaluate(() => current.annotations.length)).toBe(2);
  expect(await page.evaluate(() => current.annotations[0].color)).toBe('blue');
  expect(await page.locator('#ai-scroll #ai-quote').count()).toBe(1);
  expect((await page.locator('#ai-scroll').boundingBox()).height).toBeGreaterThanOrEqual(160);
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-ai-memory.png`) });
  await closeNormally(); await launch(); await page.locator('#continue-button').click(); await expect(page.frameLocator('#book-frame').locator('article')).toBeVisible(); await expect.poll(() => page.evaluate(() => busy)).toBe(false);
  await page.locator('#ai-open-reader').click(); await page.locator('#ai-conversation').selectOption(firstId);
  await expect(page.locator('#ai-conversation option')).toHaveCount(2); await expect(page.locator('#ai-messages')).toContainText('记忆暗号A');
});

test('Asking AI never adds an excerpt or highlight; independent discussions resume and only explicit saving creates an excerpt', async () => {
  await mock(); await configure(); await passage();
  const frame = page.frameLocator('#book-frame');
  expect(await frame.locator('article').evaluate(node => node.ownerDocument.getSelection().isCollapsed)).toBe(true);
  await page.locator('#ai-close').click();
  await frame.locator('#p1').evaluate(node => { const range = node.ownerDocument.createRange(); range.selectNodeContents(node); const selection = node.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await expect(page.locator('#selection-tools')).toBeVisible(); await page.locator('#ai-open-reader').click();
  expect(await frame.locator('article').evaluate(node => node.ownerDocument.getSelection().isCollapsed)).toBe(true);
  await expect(page.locator('#selection-tools')).toBeHidden();
  expect(await page.evaluate(() => current.annotations[0].isExcerpt)).toBe(false);
  expect(await frame.locator('article').evaluate(node => [...node.ownerDocument.defaultView.CSS.highlights].filter(([name]) => name.startsWith('reader-note')).every(([, ranges]) => ranges.size === 0))).toBe(true);
  expect(await page.frameLocator('#book-frame').locator('article').evaluate(node => node.ownerDocument.defaultView.CSS.highlights.get('reader-notes').size)).toBe(0);
  await send('只想讨论，不要自动摘录'); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await page.locator('#ai-draft').click(); await expect(page.locator('#note-dialog')).toBeVisible(); await page.locator('#note-cancel').click();
  expect(await page.evaluate(() => current.annotations[0].isExcerpt)).toBe(false);
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(0);
  await closeNormally(); await launch(); await mock(); await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(0);
  await page.locator('#ai-open-reader').click(); await expect(page.locator('.ai-assistant')).toHaveCount(2);
  await expect(page.locator('#ai-messages')).toContainText('只想讨论，不要自动摘录');
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try {
    await page.locator('#ai-save-excerpt').click(); await expect(page.locator('#ai-error')).toContainText('检查磁盘空间');
    expect(await page.evaluate(() => current.annotations[0].isExcerpt)).toBe(false);
  } finally { await fs.rmdir(temp); }
  const firstId = await page.locator('#ai-conversation').inputValue();
  const secondId = await page.evaluate(async () => {
    const doc = document.getElementById('book-frame').contentDocument; const range = doc.createRange(); range.selectNodeContents(doc.querySelector('#p1'));
    doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
    const value = window.ReadingContent.selection(doc); doc.getSelection().removeAllRanges();
    const saved = await window.reader.saveAnnotation(current.id, { ...value, chapter: 0, isExcerpt: false }); current.annotations.push(saved); companion.render();
    const original = companion.context.saveExcerpt;
    companion.context.saveExcerpt = (...args) => new Promise((resolve, reject) => { window.releaseExcerptSave = () => original(...args).then(resolve, reject); });
    return saved.id;
  });
  await page.locator('#ai-save-excerpt').click(); await page.locator('#ai-conversation').selectOption(secondId);
  await page.evaluate(() => window.releaseExcerptSave());
  await expect(page.locator('#ai-conversation')).toHaveValue(secondId);
  await page.locator('#ai-conversation').selectOption(firstId); await expect(page.locator('#ai-save-excerpt')).toBeHidden();
  expect(await page.evaluate(() => current.annotations.length)).toBe(2);
  expect(await page.evaluate(() => current.annotations[0].isExcerpt)).toBe(true);
  expect(await page.evaluate(() => current.annotations[0].discussion.length)).toBe(2);
  expect(await application.evaluate(() => globalThis.aiTest?.requests.length || 0)).toBe(0);
  expect(await page.frameLocator('#book-frame').locator('article').evaluate(node => node.ownerDocument.defaultView.CSS.highlights.get('reader-notes').size)).toBe(1);
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(1);
});

test('Regeneration keeps the old answer on failure, replaces only the last answer and copies saved text', async () => {
  await mock({ delay: 120 }); await configure(); await passage(); await send('同一个问题');
  await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  const original = await page.evaluate(() => current.annotations[0].discussion[0]);
  await page.locator('#ai-question').fill('不应丢失的未发送问题');
  await application.evaluate(() => { globalThis.aiTest.status = 402; }); await page.locator('.ai-regenerate').click(); await expect(page.locator('#ai-error')).toContainText('余额不足');
  expect(await page.evaluate(() => current.annotations[0].discussion[0].id)).toBe(original.id);
  await application.evaluate(() => { globalThis.aiTest.status = 200; globalThis.aiTest.answer = '重新生成的另一种解读'; });
  await page.locator('.ai-regenerate').click();
  expect(await page.evaluate(() => current.annotations[0].discussion[0].id)).toBe(original.id);
  await expect(page.locator('.ai-assistant')).toHaveCount(1); await expect(page.locator('.ai-assistant')).toContainText('另一种解读');
  await expect(page.locator('#ai-question')).toHaveValue('不应丢失的未发送问题');
  const turns = await page.evaluate(() => current.annotations[0].discussion); expect(turns).toHaveLength(1); expect(turns[0].id).not.toBe(original.id); expect(turns[0].question).toBe(original.question);
  const request = await application.evaluate(() => globalThis.aiTest.requests.at(-1).body); expect(request.messages).toHaveLength(3); expect(JSON.stringify(request)).not.toContain(original.answer);
  await application.evaluate(({ clipboard }) => { clipboard.writeText = text => { globalThis.aiTest.copied = text; }; });
  await page.locator('.ai-copy').click(); await expect(page.locator('#toast')).toContainText('已复制');
  expect(await application.evaluate(() => globalThis.aiTest.copied)).toBe('重新生成的另一种解读');
});

test('Typing during a reply preserves the next question; cancelled and unsaved regeneration preserve the original answer', async () => {
  await mock({ delay: 250 }); await configure(); await passage(); await send('先回答这个问题');
  await page.locator('#ai-question').fill('等待时写好的下一个问题');
  await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await expect(page.locator('#ai-question')).toHaveValue('等待时写好的下一个问题');
  const original = await page.evaluate(() => current.annotations[0].discussion[0]);
  await page.locator('.ai-regenerate').click(); await page.locator('#ai-stop').click();
  expect(await page.evaluate(() => current.annotations[0].discussion[0].id)).toBe(original.id);
  await page.waitForTimeout(300);
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try {
    await application.evaluate(() => { globalThis.aiTest.answer = '保存重试后的新回答'; });
    await page.locator('.ai-regenerate').click(); await expect(page.locator('#ai-retry-save')).toBeVisible();
    expect(await page.evaluate(() => current.annotations[0].discussion[0].id)).toBe(original.id);
  } finally { await fs.rmdir(temp); }
  const calls = await application.evaluate(() => globalThis.aiTest.requests.length);
  await page.locator('#ai-retry-save').click(); await expect(page.locator('#ai-retry-save')).toBeHidden();
  expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(calls);
  expect(await page.evaluate(() => current.annotations[0].discussion[0].answer)).toBe('保存重试后的新回答');
  await expect(page.locator('#ai-question')).toHaveValue('等待时写好的下一个问题');
});

test('Deleting a turn removes its dependent tail, supports cancel and write retry, and clearing preserves notes', async () => {
  await mock(); await configure(); await passage();
  for (let index = 0; index < 3; index++) { await send(`问题${index}`); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(index + 1); }
  await page.evaluate(async () => { const value = current.annotations[0]; await window.reader.saveAnnotation(current.id, { ...value, note: '始终保留的笔记', isExcerpt: true }); });
  await page.locator('#ai-clear').click(); await expect(page.locator('#ai-delete-description')).toContainText('共 3 轮'); await page.locator('#ai-delete-cancel').click();
  expect(await page.evaluate(() => current.annotations[0].discussion.length)).toBe(3);
  await page.locator('.ai-remove').nth(1).click(); await expect(page.locator('#ai-delete-description')).toContainText('共 2 轮');
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try { await page.locator('#ai-delete-confirm').click(); await expect(page.locator('#ai-delete-error')).toContainText('检查磁盘空间'); } finally { await fs.rmdir(temp); }
  expect(await page.evaluate(() => current.annotations[0].discussion.length)).toBe(3);
  await page.locator('#ai-delete-confirm').click(); await expect(page.locator('#ai-delete-dialog')).not.toBeVisible(); await expect(page.locator('.ai-assistant')).toHaveCount(1);
  await page.locator('#ai-clear').click(); await page.locator('#ai-delete-confirm').click(); await expect(page.locator('#ai-delete-dialog')).not.toBeVisible(); await expect(page.locator('.ai-assistant')).toHaveCount(0);
  expect(await page.evaluate(() => current.annotations[0].note)).toBe('始终保留的笔记'); expect(await page.evaluate(() => current.annotations.length)).toBe(1);
});

test('Verified original quotations link back to exact text; invented citations stay unverified and restart preserves the evidence', async () => {
  await mock({ answer: '这可以理解为给自己留出空间。【原文：清晨，窗边的光落在翻开的书页上。】另一句【原文：原文没有这句话】不能当作依据。' }); await configure(); await passage();
  await send('你的理解依据是什么？'); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await expect(page.locator('.ai-assistant')).toContainText('引文未匹配'); await expect(page.locator('.ai-assistant')).toContainText('原文 1');
  expect(await page.evaluate(() => current.annotations[0].discussion[0].sources.length)).toBe(1);
  await page.locator('.ai-assistant .ai-source-link').first().click();
  await expect.poll(() => page.frameLocator('#book-frame').locator('article').evaluate(node => node.ownerDocument.defaultView.CSS.highlights.get('reader-source')?.size)).toBe(1);
  expect(await page.evaluate(() => current.annotations[0].isExcerpt)).toBe(false);
  await page.locator('.ai-sources summary').click(); await expect(page.locator('.ai-sources')).toContainText('外部说法未经联网核验');
  await page.locator('.ai-sources p').last().scrollIntoViewIfNeeded();
  await application.evaluate(({ clipboard }) => { clipboard.writeText = text => { globalThis.aiTest.copied = text; }; }); await page.locator('.ai-copy').click();
  expect(await application.evaluate(() => globalThis.aiTest.copied)).toContain('原文依据（《给阅读留一点时间》）');
  await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-citations.png`) });
  await closeNormally(); await launch(); await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#ai-open-reader').click(); await expect(page.locator('.ai-source-link').first()).toBeVisible();
  expect(await page.evaluate(() => current.annotations[0].discussion[0].sources[0].quote)).toBe('清晨，窗边的光落在翻开的书页上。');
});

test('Reading-region screenshots require preview and Send, persist as independent image discussions and regenerate with the same picture', async () => {
  await mock(); await configure(); await page.locator('#example-button').click(); await page.locator('.book-open').click(); await expect(page.locator('#chapter-loading')).toBeHidden();
  await page.locator('#ai-open-reader').click(); await capture();
  expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(0);
  await page.locator('#ai-image-cancel').click(); expect(await page.evaluate(() => current.annotations.length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('#ai-capture').focus(); await page.keyboard.press('Enter'); await expect(page.locator('#ai-capture-layer')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('#ai-capture-layer')).toBeHidden(); await expect(page.locator('#ai-capture')).toBeFocused();
  await page.locator('#ai-capture').click(); await expect(page.locator('#ai-capture-layer')).toBeVisible(); await page.locator('#back-button').click();
  await expect(page.locator('#shelf-view')).toBeVisible(); await expect(page.locator('#ai-capture-layer')).toBeHidden();
  await page.locator('.book-open').click(); await expect(page.locator('#chapter-loading')).toBeHidden(); await page.locator('#ai-open-reader').click();
  await page.locator('#ai-question').fill('先写下的问题'); await capture(); await page.locator('#ai-image-use').click(); await expect(page.locator('#ai-image-draft')).toBeVisible();
  await expect(page.locator('#ai-question')).toHaveValue('先写下的问题');
  expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(0); expect(await page.evaluate(() => current.annotations[0].kind)).toBe('image');
  await send('解释截图中的图和文字'); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(1);
  await expect(page.locator('#ai-image-draft')).toBeHidden(); await expect(page.locator('.ai-saved-image')).toBeVisible(); await expect(page.locator('#ai-save-excerpt')).toBeHidden();
  const original = await page.evaluate(() => current.annotations[0].discussion[0]);
  const sent = await application.evaluate(() => globalThis.aiTest.requests.at(-1).body.messages.at(-1)); expect(sent.content[1].image_url.url).toBe(original.image.dataUrl);
  await page.locator('.ai-regenerate').click(); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion[0].id)).not.toBe(original.id);
  expect(await application.evaluate(() => globalThis.aiTest.requests.at(-1).body.messages.at(-1).content[1].image_url.url)).toBe(original.image.dataUrl);
  await page.locator('.ai-saved-image').click(); await expect(page.locator('#ai-image-use')).toBeHidden(); await page.screenshot({ path: path.join(ROOT, `dist/ReadingText-${require('../../package.json').version}-screenshot.png`) }); await page.locator('#ai-image-cancel').click();
  await closeNormally(); await launch(); await mock(); await page.locator('#continue-button').click(); await expect(page.locator('#chapter-loading')).toBeHidden(); await page.locator('#ai-open-reader').click();
  await expect(page.locator('.ai-saved-image')).toBeVisible(); await send('继续说明'); await expect.poll(() => page.evaluate(() => current.annotations[0].discussion.length)).toBe(2);
  expect(await application.evaluate(() => globalThis.aiTest.requests[0].body.messages[2].content[1].image_url.url)).toBe(original.image.dataUrl);
  await page.locator('#notes-button').click(); await expect(page.locator('.note-entry')).toHaveCount(0);
});

test('Screenshot drafts stay local on model mismatch and write failure; retrying saves without another API call', async () => {
  await mock(); await configure(); await passage(); await capture(); await page.locator('#ai-image-use').click();
  await page.evaluate(() => window.reader.saveAiSettings({ model: 'deepseek-v4-pro' })); await send('查看这张图'); await expect(page.locator('#ai-error')).toContainText('deepseek-flash');
  expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(0); await expect(page.locator('#ai-image-draft')).toBeVisible();
  await page.evaluate(() => window.reader.saveAiSettings({ model: 'deepseek-flash' }));
  const temp = path.join(directory, 'library.json.tmp'); await fs.mkdir(temp);
  try { await page.locator('#ai-send').click(); await expect(page.locator('#ai-retry-save')).toBeVisible(); await expect(page.locator('#ai-image-draft')).toBeVisible(); } finally { await fs.rmdir(temp); }
  await page.locator('#ai-retry-save').click(); await expect(page.locator('#ai-retry-save')).toBeHidden(); await expect(page.locator('#ai-image-draft')).toBeHidden();
  expect(await application.evaluate(() => globalThis.aiTest.requests.length)).toBe(1);
  await expect(page.locator('.ai-saved-image')).toBeVisible();
  await expect(page.evaluate(() => window.reader.captureReading({ x: -100, y: 0, width: 200, height: 200 }))).rejects.toThrow('阅读区域');
});
