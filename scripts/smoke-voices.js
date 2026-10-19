const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Voice } = require('../src/voice');
const voices = require('../assets/voice/voices.json');
const { version } = require('../package.json');

function pcm(wav) {
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt16LE(34), 16);
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.subarray(offset, offset + 4).toString() === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  throw new Error('WAV 没有声音数据');
}
function wav(data) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

(async () => {
  if (!process.env.READINGTEXT_VOICE_HOME) throw new Error('请设置 READINGTEXT_VOICE_HOME。');
  const voice = new Voice(path.join(process.env.READINGTEXT_VOICE_HOME, 'serena'), path.resolve(__dirname, '../src/voice_worker.py'));
  const directory = path.resolve(__dirname, '../dist'); await fs.mkdir(directory, { recursive: true });
  const report = { voices: {} };
  try {
    const cold = performance.now(); await voice.start(); report.loadSeconds = (performance.now() - cold) / 1000;
    const child = voice.child; const hashes = [];
    for (const speaker of Object.keys(voices)) {
      const started = performance.now(); const parts = [];
      for (const text of ['窗外的风渐渐安静下来，她把书翻到夹着落叶的那一页。许久没有重读的句子，仍像老朋友一样熟悉。', '灯光落在桌边，夜色已经很深。她轻轻合上书，心里却还留着那个遥远的春天。']) parts.push(pcm(await voice.synthesize(text, speaker)));
      const audio = wav(Buffer.concat([parts[0], Buffer.alloc(8640), parts[1]]));
      assert.ok(audio.length > 48000 * 5); assert.equal(voice.child, child);
      hashes.push(createHash('sha256').update(audio).digest('hex'));
      await fs.writeFile(path.join(directory, `${speaker}-${version}-preview.wav`), audio);
      report.voices[speaker] = { generateSeconds: (performance.now() - started) / 1000, audioSeconds: (audio.length - 44) / 48000 };
      console.log(speaker, JSON.stringify(report.voices[speaker]));
    }
    assert.equal(new Set(hashes).size, 3);
    const old = await voice.openStream('这段声音会在切换音色时被取消。', 'calm', 'Vivian');
    assert.ok((await voice.readStream(old)).data.length); voice.cancel(); await assert.rejects(voice.readStream(old), /取消/);
    const started = performance.now(); const fresh = await voice.openStream('切换之后，仍然可以安静地继续阅读。', 'calm', 'Uncle_Fu'); const packets = [];
    while (true) {
      const packet = await voice.readStream(fresh); if (packet.done) break;
      if (!packets.length) report.switchFirstPacketSeconds = (performance.now() - started) / 1000;
      packets.push(packet.data);
    }
    assert.ok(Buffer.concat(packets).length > 1000); assert.equal(voice.child, child);
    report.sameModelProcess = true; report.cancelAndRetry = true;
    await fs.writeFile(path.join(directory, `voices-${version}-validation.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await voice.shutdown(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
