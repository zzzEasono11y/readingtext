const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Voice, REVISION } = require('../src/voice');
const { createHash } = require('node:crypto');
const VOICES = require('../assets/voice/voices.json');

test('All three reference voices match their shipped transcript and pinned audio', async () => {
  const hashes = ['915413eddfe08e690b1e69d656b18a7d5cb22f5451c1201ad9163b2c570412fe', '9bc30e1b246b200e108c681c0b67c00650bfe4c99941c5b48ab20c9efecb3218', '61399c7cae8e1b049dea06b871bbcff0ad960ea038998d7d44d569ec58685153'];
  assert.deepEqual(Object.keys(VOICES), ['Serena', 'Vivian', 'Uncle_Fu']);
  for (const [index, voice] of Object.values(VOICES).entries()) {
    const bytes = await fs.readFile(path.join(__dirname, '../assets/voice', voice.reference));
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
    assert.equal(voice.sha256, hashes[index]); assert.equal(createHash('sha256').update(bytes).digest('hex'), voice.sha256);
    assert.ok(voice.text.length > 20);
  }
});

test('Streams keep voice-specific caches and immutable speaker requests; switching cancels obsolete audio', async () => {
  const voice = new Voice('unused', 'unused.py'); const commands = [];
  voice.start = async () => {}; voice.child = { stdin: { writable: true, write: line => commands.push(JSON.parse(line)) } };
  voice.cache.set('stream:Serena:calm:相同文字', [Buffer.from('Serena audio')]);
  const first = await voice.openStream('相同文字'); assert.equal((await voice.readStream(first)).data.toString(), 'Serena audio'); await voice.readStream(first);
  const next = await voice.openStream('相同文字', 'calm', 'Vivian'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands[0].speaker, 'Vivian'); assert.equal(voice.streams.get(next).queue.length, 0);
  const rejected = assert.rejects(voice.readStream(next), /取消/); voice.cancel(); await rejected;
  await voice.openStream('相同文字', 'calm', 'Uncle_Fu'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.at(-1).speaker, 'Uncle_Fu'); voice.cancel();
  for (const speaker of [null, {}, ['Serena'], '../voice.wav', 'constructor']) {
    await assert.rejects(voice.openStream('文字', 'calm', speaker), /音色无效/);
    await assert.rejects(voice.synthesize('文字', speaker), /音色无效/);
  }
});

test('Serena reference stays pinned to the generated voice sample used by the transcript', async () => {
  const bytes = await fs.readFile(path.join(__dirname, '../assets/voice/Serena-reference.wav'));
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '915413eddfe08e690b1e69d656b18a7d5cb22f5451c1201ad9163b2c570412fe');
});

test('Speech chunking preserves all text, bounds long paragraphs and keeps surrogate pairs intact', async () => {
  const window = {}; vm.runInNewContext(await fs.readFile(path.join(__dirname, '../src/ui/speech.js'), 'utf8'), { window });
  const text = '长段落里的文字，'.repeat(90) + '。' + '😀'.repeat(100) + '结束。';
  const parts = window.ReadAloud.chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => part.length <= 360 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part)));
  assert.equal(window.ReadAloud.chunks('  ').length, 0);
});

test('Speech cleanup joins wrapped Chinese, keeps English word boundaries and normalizes explicit numeric units', async () => {
  const window = {}; vm.runInNewContext(await fs.readFile(path.join(__dirname, '../src/ui/speech.js'), 'utf8'), { window });
  const clean = window.ReadAloud.normalizeText;
  assert.equal(clean('窗边的\n光落在\u200b书页上。 Hello\nworld!'), '窗边的光落在书页上。 Hello world!');
  assert.equal(clean('第 12 章：2026-10-15，增长１２．５％，花费3.50元，步行2公里。'), '第十二章：二零二六年十月十五日，增长百分之十二点五，花费三点五零元，步行二公里。');
  assert.equal(clean('下降-0.5%，增加+10%。'), '下降百分之负零点五，增加百分之正十。');
  assert.equal(clean('1984，电话号码13800138000，版本v1.2，日期2026-02-30。'), '1984，电话号码13800138000，版本v1.2，日期2026-02-30。');
  assert.equal(clean('他的第101次尝试...终于成功。'), '他的第101次尝试……终于成功。');
  for (const label of ['第 12 页', '第十二頁', 'Page 12 of 99', 'p. 5', '— 12 —', '***', '···']) assert.equal(clean(label), '');
  for (const keep of ['1984', '123', '第12页记载着一个故事。', 'page 12 is missing', '10000元', 'chapter2026-10-15.html']) assert.equal(clean(keep), keep);
  for (const text of ['第101章', '第1001章', '第1010章']) assert.ok(!clean(text).includes('undefined'));
});

test('Voice validates requests, requires a complete matching pack and removes only its own directory', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-voice-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const voice = new Voice(path.join(parent, 'serena'), 'unused.py');
  await fs.writeFile(path.join(parent, 'book.epub'), 'keep');
  assert.equal((await voice.status()).phase, 'missing');
  for (const text of [null, '', ' ', '字'.repeat(401)]) await assert.rejects(voice.synthesize(text), /1–400/);
  await assert.rejects(voice.synthesize('你好'), /先下载/);
  await fs.mkdir(path.join(voice.root, 'python'), { recursive: true });
  await fs.mkdir(path.join(voice.root, 'model-continuous/speech_tokenizer'), { recursive: true });
  await fs.writeFile(path.join(voice.root, 'ready.json'), JSON.stringify({ revision: 'legacy' }));
  assert.equal((await voice.status()).phase, 'upgrade');
  for (const file of ['python/python.exe', 'model-continuous/model.safetensors', 'model-continuous/speech_tokenizer/model.safetensors']) await fs.writeFile(path.join(voice.root, file), 'test');
  await fs.writeFile(path.join(voice.root, 'continuous-ready.json'), JSON.stringify({ revision: REVISION }));
  assert.equal((await voice.status()).phase, 'ready');
  await voice.remove();
  assert.equal((await voice.status()).phase, 'missing');
  assert.equal(await fs.readFile(path.join(parent, 'book.epub'), 'utf8'), 'keep');
  await assert.rejects(new Voice(parent, 'unused.py').remove(), /位置无效/);
});

test('Cancellation rejects pending synthesis and discards audio from an obsolete request; retry and cache recover', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-voice-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'audio'));
  const voice = new Voice(root, 'unused.py'); let sent;
  voice.start = async () => {};
  voice.child = { stdin: { writable: true, write: line => { sent = JSON.parse(line); } } };
  const obsolete = voice.synthesize('旧段落');
  await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(obsolete, /已取消/);
  voice.cancel(); await rejected; assert.equal(voice.pending.size, 0);
  const fresh = voice.synthesize('新段落');
  await new Promise(resolve => setImmediate(resolve));
  const id = sent.id;
  await fs.writeFile(path.join(root, 'audio', `${id}.wav`), 'RIFF-valid-fixture');
  voice.pending.get(id).resolve({ id }); voice.pending.delete(id);
  assert.equal((await fresh).toString(), 'RIFF-valid-fixture');
  assert.equal((await voice.synthesize('新段落')).toString(), 'RIFF-valid-fixture');
  await assert.rejects(fs.access(path.join(root, 'audio', `${id}.wav`)));
});

test('Installer failures remain retryable and never mark incomplete downloads ready', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-voice-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const voice = new Voice(root, 'unused.py'); let attempts = 0;
  voice.unpack = async () => { attempts++; throw new Error('网络中断'); };
  await assert.rejects(voice.install(), /网络中断/);
  assert.equal(voice.installation, null); assert.equal((await voice.status()).phase, 'missing');
  await assert.rejects(voice.install(), /网络中断/); assert.equal(attempts, 2);
  await assert.rejects(fs.access(path.join(root, 'continuous-ready.json')));
});

test('Speech streams return before loading, wait for packets, bound jobs, cancel readers and replay cached audio', async () => {
  const voice = new Voice('unused', 'unused.py');
  let loaded; const commands = [];
  voice.start = () => new Promise(resolve => { loaded = resolve; });
  voice.child = { stdin: { writable: true, write: line => commands.push(JSON.parse(line)) } };
  const first = await voice.openStream('第一段');
  assert.equal(commands.length, 0);
  let settled = false; const waiting = voice.readStream(first).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  await assert.rejects(voice.readStream(first), /等待/);
  loaded(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands[0].text, '第一段'); assert.equal(commands[0].stream, true);
  const entry = voice.streams.get(first); entry.queue.push(Buffer.from('first MP3 frames')); entry.wake();
  assert.equal((await waiting).data.toString(), 'first MP3 frames');
  const second = await voice.openStream('第二段'); await voice.openStream('第三段');
  await assert.rejects(voice.openStream('第四段'), /稍候/);
  const cancelled = assert.rejects(voice.readStream(second), /取消/);
  voice.cancel(); await cancelled; assert.equal(voice.streams.size, 0);
  assert.equal(commands.at(-1).cancel, true);
  voice.cache.set('stream:Serena:calm:缓存段落', [Buffer.from('MP3 head'), Buffer.from('MP3 tail')]);
  const cached = await voice.openStream('缓存段落');
  assert.equal((await voice.readStream(cached)).data.toString(), 'MP3 head');
  assert.equal((await voice.readStream(cached)).data.toString(), 'MP3 tail');
  assert.deepEqual(await voice.readStream(cached), { done: true });
  for (const text of ['', null, '字'.repeat(401)]) await assert.rejects(voice.openStream(text), /无效/);
  await assert.rejects(voice.openStream('文字', 'unknown'), /无效/);
});

test('Stream startup errors reach the waiting reader and can be retried', async () => {
  const voice = new Voice('unused', 'unused.py');
  voice.start = async () => { throw new Error('启动失败'); };
  const id = await voice.openStream('测试'); await assert.rejects(voice.readStream(id), /启动失败/);
  assert.equal(voice.streams.size, 0);
  const retry = await voice.openStream('测试'); await assert.rejects(voice.readStream(retry), /启动失败/);
});
