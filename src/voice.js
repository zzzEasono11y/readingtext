const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const JSZip = require('jszip');
const VOICES = require('../assets/voice/voices.json');
function validateSpeaker(speaker) {
  if (typeof speaker !== 'string' || !Object.hasOwn(VOICES, speaker)) throw new Error('朗读音色无效。');
}

const MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const REVISION = 'fd4b254389122332181a7c3db7f27e918eec64e3';
const PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip';
const PIP_URL = 'https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl';
const CANCELLED = '朗读任务已取消。';

class Voice {
  constructor(root, worker, notify = () => {}, downloadFetch = fetch, reference = path.join(__dirname, '../assets/voice/Serena-reference.wav')) {
    this.root = path.resolve(root);
    this.worker = worker;
    this.reference = reference;
    this.notify = notify;
    this.downloadFetch = downloadFetch;
    this.state = { phase: 'missing', message: '尚未安装本地语音包。' };
    this.pending = new Map(); this.cache = new Map(); this.streams = new Map(); this.epoch = 0;
  }
  python() { return path.join(this.root, 'python/python.exe'); }
  async status() {
    if (['installing', 'removing'].includes(this.state.phase)) return this.state;
    try {
      const marker = JSON.parse(await fs.readFile(path.join(this.root, 'continuous-ready.json'), 'utf8'));
      if (marker.revision !== REVISION) throw new Error('版本不同');
      await fs.access(this.python());
      await fs.access(path.join(this.root, 'model-continuous/model.safetensors'));
      await fs.access(path.join(this.root, 'model-continuous/speech_tokenizer/model.safetensors'));
      this.state = { phase: 'ready', message: '本地语音包已安装 · 三个音色可离线朗读' };
    } catch {
      let legacy = false; try { await fs.access(path.join(this.root, 'ready.json')); legacy = true; } catch {}
      this.state = { phase: legacy ? 'upgrade' : 'missing', message: legacy ? '更新本地语音包以启用更连贯的朗读。' : '尚未安装完整的本地语音包。' };
    }
    return this.state;
  }
  update(phase, message) { this.state = { phase, message }; this.notify(this.state); }
  async unpack(url, digest, directory, signal) {
    const response = await this.downloadFetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
    if (!response.ok) throw new Error('下载未完成，请检查网络后重试。');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('下载文件校验失败，请重试。');
    const zip = await JSZip.loadAsync(bytes);
    for (const entry of Object.values(zip.files)) {
      const target = path.resolve(directory, entry.name);
      if (!target.startsWith(path.resolve(directory) + path.sep)) throw new Error('安装包路径无效。');
      if (entry.dir) await fs.mkdir(target, { recursive: true });
      else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, await entry.async('nodebuffer')); }
    }
  }
  run(args, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python(), args, { windowsHide: true, signal, env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      child.stdout.on('data', chunk => { tail = (tail + chunk).slice(-4000); });
      child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-4000); });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`语音包准备失败，请检查网络和磁盘空间后重试。\n${tail.slice(-700)}`)));
    });
  }
  environment() {
    return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HOME: path.join(this.root, 'hub'), PIP_CACHE_DIR: path.join(this.root, 'pip-cache'), TOKENIZERS_PARALLELISM: 'false' };
  }
  async install() {
    if (this.installation || this.removing) throw new Error('语音包正在处理中，请稍后。');
    const controller = new AbortController(); this.installation = controller;
    this.update('installing', '正在下载独立语音环境…');
    try {
      const python = path.join(this.root, 'python');
      await fs.mkdir(this.root, { recursive: true });
      await fs.rm(path.join(this.root, 'continuous-ready.json'), { force: true });
      await this.unpack(PYTHON_URL, '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3', python, controller.signal);
      await fs.writeFile(path.join(python, 'python312._pth'), 'python312.zip\n.\nLib/site-packages\nimport site\n');
      await this.unpack(PIP_URL, '9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd', path.join(python, 'Lib/site-packages'), controller.signal);
      this.update('installing', '正在安装本地语音组件，首次需要下载数 GB 文件，请稍候…');
      const pip = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '--no-cache-dir',
        '--constraint', path.join(path.dirname(this.worker), 'voice-constraints.txt')];
      await this.run([...pip, 'torch==2.10.0', 'torchaudio==2.10.0', '--index-url', 'https://download.pytorch.org/whl/cu128'], controller.signal);
      await this.run([...pip, 'qwen-tts==0.1.1', 'faster-qwen3-tts==0.3.0'], controller.signal);
      this.update('installing', '正在下载本地语音模型，完成后即可离线朗读…');
      await this.run([this.worker, '--download', this.root, MODEL, REVISION], controller.signal);
      await this.run([this.worker, '--check', this.root], controller.signal);
      await fs.writeFile(path.join(this.root, 'continuous-ready.json'), JSON.stringify({ model: MODEL, revision: REVISION, speaker: 'Serena', style: 'fixed-reference' }));
      this.update('ready', '本地语音包已安装 · 三个音色可离线朗读');
    } catch (error) {
      this.update('missing', controller.signal.aborted ? '下载已取消，可以稍后重试。' : '安装未完成，可以重试。');
      if (!controller.signal.aborted) throw error;
    } finally { this.installation = null; }
    return this.state;
  }
  cancelInstall() { this.installation?.abort(); }
  async remove() {
    if (this.installation || this.removing) throw new Error('请先取消下载并等待结束。');
    this.removing = true; this.update('removing', '正在移除语音包…');
    try {
      await this.shutdown();
      // root is fixed by the main process, never accepted from a renderer request.
      if (path.basename(this.root) !== 'serena' || path.dirname(this.root) === this.root) throw new Error('语音包位置无效。');
      await fs.rm(this.root, { recursive: true, force: true });
      this.update('missing', '本地语音包已移除，书籍和阅读进度不受影响。');
    } catch (error) {
      this.state = { phase: 'missing', message: '移除未完成，可以重试。' };
      this.notify(await this.status());
      throw error;
    } finally { this.removing = false; }
    return this.state;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.status().then(state => {
      if (state.phase !== 'ready') throw new Error('请先下载本地语音包。');
      return new Promise((resolve, reject) => {
      const child = spawn(this.python(), ['-u', this.worker, '--serve', this.root, this.reference], {
        windowsHide: true, env: { ...this.environment(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child = child; let details = '';
      const startupTimer = setTimeout(() => { child.kill(); }, 120000);
      child.stdin.on('error', () => {});
      child.stderr.on('data', chunk => { details = (details + chunk).slice(-1200); });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let result; try { result = JSON.parse(line); } catch { return; }
        if (result.ready) { clearTimeout(startupTimer); child.stdin.write(JSON.stringify({ cancel: true, epoch: this.epoch }) + '\n'); resolve(); return; }
        const stream = this.streams.get(result.id);
        if (stream) {
          if (stream.done) return;
          if (result.chunk) {
            const bytes = Buffer.from(result.chunk, 'base64');
            stream.bytes += bytes.length;
            if (stream.bytes > 5 * 1024 * 1024) { this.cancel(); return; }
            stream.queue.push(bytes); stream.all.push(bytes);
          } else {
            stream.done = true; stream.error = result.error;
            clearTimeout(stream.timer);
            if (!result.error) { if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value); this.cache.set(stream.key, stream.all); }
          }
          stream.wake?.();
          return;
        }
        const request = this.pending.get(result.id);
        if (!request) return;
        this.pending.delete(result.id);
        if (result.error) request.reject(new Error(result.error)); else request.resolve(result);
      });
      const failed = error => {
        clearTimeout(startupTimer);
        if (this.child !== child) return;
        this.child = null; this.starting = null;
        reject(error); this.pending.forEach(request => request.reject(error)); this.pending.clear();
        for (const stream of this.streams.values()) { clearTimeout(stream.timer); stream.done = true; stream.error = error.message; stream.wake?.(); }
      };
      child.on('error', () => failed(new Error('无法启动本地语音，请重新安装语音包后重试。')));
      child.on('exit', () => failed(new Error(`本地语音已退出，请重试。${details ? '\n' + details.slice(-350) : ''}`)));
      });
    }).catch(error => { this.starting = null; throw error; });
    return this.starting;
  }
  async synthesize(text, speaker = 'Serena') {
    validateSpeaker(speaker);
    if (typeof text !== 'string' || !text.trim() || text.length > 400) throw new Error('朗读文本需为 1–400 个字符。');
    if (this.removing || this.installation) throw new Error('语音包正在处理中。');
    if (this.pending.size >= 3) throw new Error('正在准备声音，请稍候。');
    const epoch = this.epoch;
    const key = createHash('sha256').update(`${speaker}:${text}`).digest('hex');
    if (this.cache.has(key)) return this.cache.get(key);
    await this.start();
    if (epoch !== this.epoch) throw new Error(CANCELLED);
    if (this.pending.size >= 3) throw new Error('正在准备声音，请稍候。');
    const id = randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.cancel(); reject(new Error('准备声音超时，请停止后重试。')); }, 180000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(JSON.stringify({ id, text, epoch, speaker }) + '\n');
    });
    const file = path.join(this.root, 'audio', `${id}.wav`);
    try {
      if (epoch !== this.epoch) throw new Error(CANCELLED);
      const bytes = await fs.readFile(file);
      if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, bytes);
      return bytes;
    } finally { await fs.rm(file, { force: true }); }
  }
  async openStream(text, style = 'calm', speaker = 'Serena') {
    validateSpeaker(speaker);
    if (typeof text !== 'string' || !text.trim() || text.length > 400 || !['calm', 'natural'].includes(style)) throw new Error('朗读文本或模式无效。');
    if (this.removing || this.installation || this.streams.size + this.pending.size >= 3) throw new Error('正在准备声音，请稍候。');
    const id = randomUUID(); const epoch = this.epoch;
    const key = `stream:${speaker}:${style}:${text}`;
    const cached = this.cache.get(key);
    const stream = { queue: cached ? [...cached] : [], all: [], key, bytes: 0, done: Boolean(cached), error: null };
    this.streams.set(id, stream);
    if (!cached) {
      stream.timer = setTimeout(() => { this.cancel(); stream.error = '准备声音超时，请重试。'; }, 240000);
      this.start().then(() => {
        if (epoch !== this.epoch || !this.streams.has(id)) return;
        this.child.stdin.write(JSON.stringify({ id, text, epoch, stream: true, style, speaker }) + '\n');
      }).catch(error => { clearTimeout(stream.timer); stream.error = error.message; stream.done = true; stream.wake?.(); });
    }
    return id;
  }
  async readStream(id) {
    const stream = this.streams.get(id);
    if (!stream) throw new Error(CANCELLED);
    if (stream.wake) throw new Error('请等待当前声音片段。');
    if (!stream.queue.length && !stream.done) await new Promise(resolve => { stream.wake = resolve; });
    stream.wake = null;
    if (stream.queue.length && !stream.error) return { data: stream.queue.shift() };
    this.streams.delete(id);
    if (stream.error) throw new Error(stream.error);
    return { done: true };
  }
  cancel() {
    this.epoch++;
    this.pending.forEach(request => request.reject(new Error(CANCELLED))); this.pending.clear();
    for (const stream of this.streams.values()) { clearTimeout(stream.timer); stream.done = true; stream.error = CANCELLED; stream.queue = []; stream.wake?.(); }
    this.streams.clear();
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify({ cancel: true, epoch: this.epoch }) + '\n');
  }
  async shutdown() {
    this.cancel(); this.cache.clear();
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
}
module.exports = { Voice, MODEL, REVISION };
