const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Voice, REVISION, MODEL } = require('../src/voice');

(async () => {
  const home = process.env.READINGTEXT_VOICE_HOME;
  if (!home) throw new Error('请设置 READINGTEXT_VOICE_HOME，指向包含 serena 的语音包目录。');
  const voice = new Voice(path.join(home, 'serena'), path.resolve(__dirname, '../src/voice_worker.py'));
  const report = {};
  try {
    assert.equal((await voice.status()).phase, 'ready');
    const cold = performance.now(); await voice.start(); report.loadSeconds = (performance.now() - cold) / 1000;
    const started = performance.now();
    const audio = await voice.synthesize('你好，我是 Serena。留一点时间，给阅读。愿这些文字，陪你度过一段安静的时光。');
    assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
    assert.equal(audio.subarray(8, 12).toString(), 'WAVE');
    report.generateSeconds = (performance.now() - started) / 1000;
    report.audioBytes = audio.length;
    let position = 12;
    while (position + 8 <= audio.length) {
      const size = audio.readUInt32LE(position + 4);
      if (audio.subarray(position, position + 4).toString() === 'data') { report.audioSeconds = size / 48000; break; }
      position += 8 + size + size % 2;
    }
    assert.ok(report.audioSeconds > 2);
    await fs.mkdir(path.resolve(__dirname, '../dist'), { recursive: true });
    await fs.writeFile(path.resolve(__dirname, '../dist/Serena-preview.wav'), audio);
    const warm = performance.now();
    const next = await voice.synthesize('清晨，窗边的光落在翻开的书页上。你不必急着读完，只要在这一刻，给自己留一点安静的时间。');
    report.warmGenerateSeconds = (performance.now() - warm) / 1000;
    report.warmAudioSeconds = (next.length - 44) / 48000;
    const obsolete = voice.synthesize('这一段声音应当在取消后被丢弃，不能继续播放。');
    const cancelled = assert.rejects(obsolete, /取消/);
    setTimeout(() => voice.cancel(), 200); await cancelled;
    const after = await voice.synthesize('取消之后，也能继续读下一段。');
    assert.ok(after.length > 44);
    report.model = MODEL; report.revision = REVISION; report.offline = true; report.cancelAndRetry = true;
    await fs.writeFile(path.resolve(__dirname, '../dist/serena-validation.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await voice.shutdown(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
