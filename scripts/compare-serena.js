const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Voice } = require('../src/voice');

const paragraphs = [
  '傍晚，窗边的光渐渐淡了。她把书放在膝上，听着远处偶尔传来的脚步声，心里慢慢安静下来。',
  '刚才读到的那句话，依然留在她的脑海里。她并不急着翻页，只是轻轻吸了一口气，又顺着那些文字想了下去。',
  '窗外，一阵风吹动了树叶。她重新低下头，接着读下一段，像是和一位熟悉的朋友，继续一场没有说完的交谈。'
];
function pcm(bytes) {
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  let position = 12;
  while (position + 8 <= bytes.length) {
    const id = bytes.subarray(position, position + 4).toString(); const length = bytes.readUInt32LE(position + 4);
    if (id === 'fmt ') { assert.equal(bytes.readUInt16LE(position + 10), 1); assert.equal(bytes.readUInt32LE(position + 12), 24000); }
    if (id === 'data') return bytes.subarray(position + 8, position + 8 + length);
    position += 8 + length + length % 2;
  }
  throw new Error('WAV 中没有音频。');
}
function wav(data) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
(async () => {
  if (!process.env.READINGTEXT_VOICE_HOME || !process.argv[2]) throw new Error('请设置 READINGTEXT_VOICE_HOME，并传入旧版 worker 路径以生成对照。');
  const root = path.resolve(__dirname, '..'); const report = { paragraphs, samples: {} };
  for (const [label, worker, gap] of [['0.5', path.resolve(process.argv[2]), 0], ['0.6', path.join(root, 'src/voice_worker.py'), .18]]) {
    const voice = new Voice(path.join(process.env.READINGTEXT_VOICE_HOME, 'serena'), worker);
    const pieces = []; const stats = [];
    try {
      for (const text of paragraphs) {
        const began = performance.now(); const bytes = pcm(await voice.synthesize(text));
        let energy = 0; let peak = 0;
        for (let index = 0; index < bytes.length; index += 2) { const sample = bytes.readInt16LE(index) / 32768; energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
        stats.push({ generateSeconds: (performance.now() - began) / 1000, audioSeconds: bytes.length / 48000,
          rmsDb: 20 * Math.log10(Math.sqrt(energy / (bytes.length / 2))), peak });
        if (pieces.length && gap) pieces.push(Buffer.alloc(Math.round(48000 * gap)));
        pieces.push(bytes); console.log(`${label}：第 ${stats.length} 段已生成`);
      }
      await fs.writeFile(path.join(root, `dist/Serena-${label}-comparison.wav`), wav(Buffer.concat(pieces)));
      report.samples[label] = stats;
    } finally { await voice.shutdown(); }
  }
  await fs.writeFile(path.join(root, 'dist/serena-comparison.json'), JSON.stringify(report, null, 2));
  console.log('同一组连续三段文字的新旧试听已生成；语气自然度仍需实际试听判断。');
})().catch(error => { console.error(error); process.exitCode = 1; });
