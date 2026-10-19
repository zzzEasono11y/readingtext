const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Voice } = require('../src/voice');

// Original continuous prose; keep the voice reference, seed and wording identical.
const paragraphs = [
  '清晨，她推开窗，远处的树梢刚刚亮起来。桌上放着一封迟来的信，她没有立刻拆开，只是轻轻摸了摸信封的边缘。',
  '“你终于回来了。”她笑着说，声音很轻，像是怕惊动这来之不易的相逢。他放下行李，看着她，也慢慢笑了。',
  '可是到了傍晚，屋子又安静下来。她望着窗外渐暗的天空，想起那些没有说出口的话，心里有一点遗憾，也有一点温暖。'
];

(async () => {
  if (!process.env.READINGTEXT_VOICE_HOME) throw new Error('请设置 READINGTEXT_VOICE_HOME。');
  const root = path.resolve(__dirname, '..');
  const voice = new Voice(path.join(process.env.READINGTEXT_VOICE_HOME, 'serena'), path.join(root, 'src/voice_worker.py'));
  const report = { paragraphs, modes: {} };
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  try {
    const cold = performance.now(); await voice.start(); report.coldLoadSeconds = (performance.now() - cold) / 1000;
    for (const style of ['calm', 'natural']) {
      const audio = []; const timings = [];
      for (const text of paragraphs) {
        const started = performance.now(); const id = await voice.openStream(text, style);
        let first; let packets = 0;
        while (true) {
          const packet = await voice.readStream(id);
          if (packet.done) break;
          first ??= (performance.now() - started) / 1000;
          packets++; audio.push(packet.data);
        }
        timings.push({ firstAudioSeconds: first, totalSeconds: (performance.now() - started) / 1000, packets });
        assert.ok(packets > 1); assert.ok(first < timings.at(-1).totalSeconds);
      }
      // Concatenated MPEG audio frames are independently decodable; each paragraph keeps its own encoder edges.
      await fs.writeFile(path.join(root, `dist/Serena-0.7-${style}.mp3`), Buffer.concat(audio));
      report.modes[style] = timings;
    }
    const id = await voice.openStream('这段声音需要及时取消，不能残留到下一段。');
    const waiting = assert.rejects(voice.readStream(id), /取消/);
    setTimeout(() => voice.cancel(), 100); await waiting;
    const retry = await voice.openStream('取消之后，继续阅读。');
    let bytes = 0;
    while (true) { const packet = await voice.readStream(retry); if (packet.done) break; bytes += packet.data.length; }
    assert.ok(bytes > 1000); report.cancelAndRetry = true;
    await fs.writeFile(path.join(root, 'dist/serena-stream-validation.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await voice.shutdown(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
