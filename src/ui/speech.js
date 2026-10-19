window.ReadAloud = (() => {
  const byId = id => document.getElementById(id);
  const digits = '零一二三四五六七八九';
  function numberText(value) {
    const [integer, decimal] = value.split('.');
    let result = ''; let zero = false;
    for (let i = 0; i < integer.length; i++) {
      const n = Number(integer[i]);
      if (!n) { zero = Boolean(result); continue; }
      if (zero) result += '零';
      result += digits[n] + ['', '十', '百', '千'][integer.length - i - 1]; zero = false;
    }
    result = (result || '零').replace(/^一十/, '十');
    return result + (decimal ? '点' + [...decimal].map(n => digits[Number(n)]).join('') : '');
  }
  function normalizeText(value) {
    let text = value.replace(/[\u00ad\u200b\ufeff]/g, '').replace(/[０-９％．]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1').replace(/\s+/g, ' ').trim();
    if (/^(?:第\s*[\d一二三四五六七八九十百千万零〇两]+\s*[页頁]|(?:page|p\.)\s*\d+(?:\s*(?:of|\/)\s*\d+)?|[-—–]\s*\d+\s*[-—–])$/i.test(text)
      || /^[*＊#＃_＿—–·•…※◆◇●○═=~～-]+$/.test(text)) return '';
    text = text.replace(/(?<![\w./-])(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?![\w./-])/g, (original, year, month, day) => {
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return original;
      return [...year].map(n => digits[Number(n)]).join('') + '年' + numberText(String(Number(month))) + '月' + numberText(String(Number(day))) + '日';
    });
    text = text.replace(/(?<![\w.])(\d{4})年/g, (_, year) => [...year].map(n => digits[Number(n)]).join('') + '年')
      .replace(/(?<![\w.])([+-]?)(\d{1,4}(?:\.\d+)?)\s*[%％]/g, (_, sign, value) => '百分之' + (sign === '-' ? '负' : sign === '+' ? '正' : '') + numberText(value))
      .replace(/第\s*(\d{1,4})\s*(章|节|卷|部|段|回)/g, (_, value, unit) => '第' + numberText(value) + unit)
      .replace(/(?<![\w.])(\d{1,4}(?:\.\d+)?)(元|岁|个月|小时|分钟|秒|公里|千米|米|公斤|千克|毫升|升)/g, (_, value, unit) => numberText(value) + unit)
      .replace(/\.{3,}|…{2,}/g, '……');
    return text;
  }
  const pageMarker = '[role="doc-pagebreak"],[epub\\:type~="pagebreak"]';
  function chunks(text) {
    const parts = []; let rest = normalizeText(text);
    while (rest) {
      let end = Math.min(360, rest.length);
      if (end < rest.length) {
        const candidate = rest.slice(0, end).search(/[。！？；.!?;][^。！？；.!?;]*$/);
        if (candidate >= 35) end = candidate + 1;
        if (/^[\uDC00-\uDFFF]$/.test(rest[end])) end--;
      }
      parts.push(rest.slice(0, end)); rest = rest.slice(end).trim();
    }
    return parts;
  }
  function units(doc) {
    let previousHeading = '';
    return window.ReadingContent.blocks(doc).flatMap((node, block) => {
      if (node.matches(`img,figure,.chapter-end,${pageMarker}`) || node.closest(pageMarker)
        || node.querySelector('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote')) return [];
      const copy = node.cloneNode(true);
      copy.querySelectorAll(pageMarker).forEach(marker => marker.remove());
      copy.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      const text = normalizeText(copy.textContent);
      if (!text) return [];
      const heading = node.matches('h1,h2,h3,h4,h5,h6,[role="heading"]');
      if (heading && text === previousHeading) return [];
      previousHeading = heading ? text : '';
      return chunks(text).map((text, part) => ({ node, text, block, part }));
    });
  }
  class StreamingPlayer {
    constructor(api, id, onError) {
      this.controller = new AbortController();
      this.source = new MediaSource();
      this.url = URL.createObjectURL(this.source);
      this.audio = new Audio(this.url);
      this.ready = new Promise((resolve, reject) => { this.firstReady = resolve; this.firstError = reject; });
      this.feed(api, id).catch(error => {
        this.firstError(error);
        if (!this.controller.signal.aborted) onError(error);
      });
    }
    event(target, name) {
      const signal = this.controller.signal;
      return new Promise((resolve, reject) => {
        const cleanup = () => { target.removeEventListener(name, success); target.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
        const success = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('声音缓冲失败，请重试。')); };
        const aborted = () => { cleanup(); reject(new Error('朗读已停止。')); };
        if (signal.aborted) { aborted(); return; }
        target.addEventListener(name, success, { once: true }); target.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true });
      });
    }
    async feed(api, id) {
      await this.event(this.source, 'sourceopen');
      const buffer = this.source.addSourceBuffer('audio/mpeg');
      let received = false;
      while (!this.controller.signal.aborted) {
        const packet = await api.readSpeechStream(id);
        if (this.controller.signal.aborted) return;
        if (packet.done) {
          if (!received) throw new Error('没有生成可播放的声音。');
          this.source.endOfStream(); return;
        }
        const appended = this.event(buffer, 'updateend');
        try { buffer.appendBuffer(packet.data); } catch (error) { this.controller.abort(); await appended.catch(() => {}); throw error; }
        await appended;
        received = true; this.firstReady();
      }
    }
    dispose() { this.controller.abort(); URL.revokeObjectURL(this.url); }
  }
  class ReadAloud {
    constructor(api, getDocument, onError, context) {
      this.api = api; this.getDocument = getDocument; this.onError = onError;
      this.context = context;
      this.version = 0; this.rate = .9; this.prewarm = true; this.active = false; this.loading = false; this.paused = false; this.following = true;
      this.autoAdvance = true; this.speaker = 'Serena'; this.voices = [];
      for (const id of ['speech-voice', 'voice-choice']) byId(id).onchange = () => this.chooseVoice(byId(id).value);
      api.voiceChoices().then(voices => {
        this.voices = voices;
        for (const id of ['speech-voice', 'voice-choice']) byId(id).replaceChildren(...voices.map(voice => {
          const option = document.createElement('option'); option.value = voice.id; option.textContent = `${voice.name} · ${voice.description}`; return option;
        }));
        this.voiceUi();
      }).catch(onError);
      this.prepared = new Map(); this.index = 0;
      byId('speech-play').onclick = () => this.toggle().catch(onError);
      byId('speech-stop').onclick = () => this.stop();
      byId('speech-previous').onclick = () => this.jump(-1);
      byId('speech-next').onclick = () => this.jump(1);
      byId('speech-resume').onclick = () => this.resume().catch(onError);
      byId('speech-follow').onclick = () => { this.following = true; this.follow(true); };
      byId('speech-toggle').onclick = () => this.panel(byId('speech-bar').hidden);
      byId('speech-close').onclick = () => { this.panel(false); byId('speech-toggle').focus(); };
      byId('speech-rate').oninput = () => { this.rate = Number(byId('speech-rate').value); this.rateUi(); this.prefetch(); };
      byId('speech-rate').onchange = () => this.savePreferences();
      byId('speech-rate-reset').onclick = () => { this.rate = 1; this.rateUi(); this.savePreferences(); };
      byId('speech-prewarm').onchange = () => { this.prewarm = byId('speech-prewarm').checked; this.savePreferences(); if (this.prewarm) this.warm(); };
      byId('speech-auto-advance').onchange = () => { this.autoAdvance = byId('speech-auto-advance').checked; this.savePreferences(); };
      byId('speech-timer').onchange = () => this.setTimer(byId('speech-timer').value);
      byId('voice-manage-shelf').onclick = byId('voice-manage-reader').onclick = () => this.openManager().catch(onError);
      byId('voice-close').onclick = () => byId('voice-dialog').close();
      byId('voice-install').onclick = async () => {
        byId('voice-error').textContent = '';
        try { this.packState({ phase: 'installing', message: '正在准备下载…' }); await api.installVoice(); }
        catch (error) { byId('voice-error').textContent = error.message; }
        finally { this.packState(await api.voiceStatus()); }
      };
      byId('voice-cancel-install').onclick = () => api.cancelVoiceInstall().catch(onError);
      byId('voice-remove').onclick = async () => {
        this.stop(); byId('voice-error').textContent = '';
        try { this.packState({ phase: 'removing', message: '正在移除…' }); this.packState(await api.removeVoice()); }
        catch (error) { byId('voice-error').textContent = error.message; this.packState(await api.voiceStatus()); }
      };
      byId('voice-preview').onclick = () => {
        this.start([{ node: null, text: '清晨，窗边的光落在翻开的书页上。你不必急着读完，只要在这一刻，给自己留一点安静的时间。' }], 0);
      };
      byId('voice-dialog').addEventListener('close', () => { if (this.active && this.items?.[0]?.node === null) this.stop(); });
      api.onVoiceStatus(state => this.packState(state));
    }
    configure(value = { rate: .9, prewarm: true, autoAdvance: true, speaker: 'Serena' }) { this.rate = value.rate; this.prewarm = value.prewarm; this.autoAdvance = value.autoAdvance; this.speaker = value.speaker || 'Serena'; this.voiceUi(); this.rateUi(); byId('speech-prewarm').checked = this.prewarm; byId('speech-auto-advance').checked = this.autoAdvance; }
    voiceLabel() { const voice = this.voices.find(voice => voice.id === this.speaker); return voice ? `${voice.name} · ${voice.description}` : this.speaker; }
    voiceUi() {
      for (const id of ['speech-voice', 'voice-choice']) byId(id).value = this.speaker;
      byId('speech-voice-name').textContent = this.speaker;
      byId('voice-preview').textContent = `试听 ${this.speaker}`;
      if (!this.active) this.message(this.voiceLabel());
    }
    chooseVoice(speaker) {
      if (speaker === this.speaker || !this.voices.some(voice => voice.id === speaker)) return;
      this.speaker = speaker; this.voiceUi(); this.savePreferences();
      if (!this.active) return;
      const node = this.items?.[this.index]?.node;
      if (this.nextChapter != null || !this.items?.length || (node && node.ownerDocument !== this.getDocument())) {
        this.stop('音色已切换 · 点击继续上次听读', true); return;
      }
      this.start(this.items, this.index, { paused: this.paused, following: this.following });
    }
    rateUi() { byId('speech-rate').value = this.rate; byId('speech-rate-value').textContent = `${this.rate.toFixed(2)}×`; if (this.audio) this.audio.playbackRate = this.rate; }
    savePreferences() { this.context.saveVoiceSettings({ rate: this.rate, prewarm: this.prewarm, autoAdvance: this.autoAdvance, speaker: this.speaker }).catch(this.onError); }
    setTimer(mode) {
      if (!['off', '15', '30', '60', 'chapter'].includes(mode)) return;
      clearInterval(this.sleepTicker);
      this.sleepMode = mode; this.sleepUntil = ['15', '30', '60'].includes(mode) ? Date.now() + Number(mode) * 60000 : null;
      byId('speech-timer').value = mode;
      this.checkTimer();
      if (this.sleepUntil) this.sleepTicker = setInterval(() => this.checkTimer(), 1000);
    }
    checkTimer() {
      if (this.sleepUntil && Date.now() >= this.sleepUntil) { this.stop('定时结束 · 已停止朗读'); return true; }
      const seconds = this.sleepUntil ? Math.ceil((this.sleepUntil - Date.now()) / 1000) : 0;
      byId('speech-timer-status').textContent = this.sleepUntil ? `还剩 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · 暂停时也计时` : this.sleepMode === 'chapter' ? '本章结束后停止，不进入下一章' : '';
      return false;
    }
    panel(open) { byId('speech-bar').hidden = !open; byId('speech-toggle').setAttribute('aria-expanded', String(open)); byId('speech-toggle').setAttribute('aria-label', open ? '收起朗读面板' : '打开朗读面板'); }
    fullscreenChanged(enabled) { if (enabled) { this.panelBeforeFullscreen = !byId('speech-bar').hidden; this.panel(false); } else this.panel(Boolean(this.panelBeforeFullscreen)); }
    async warm() {
      if (!this.prewarm) return;
      try { if ((await this.api.voiceStatus()).phase === 'ready') await this.api.warmVoice(); }
      catch { if (!this.active) this.message('准备未完成，点击朗读可重试'); }
    }
    prefetch() {
      if (!this.active || !this.audio || this.audio.paused) return;
      for (let ahead = 1; ahead <= (this.rate >= 1.5 ? 2 : 1); ahead++) {
        if (this.index + ahead < this.items.length) this.prepare(this.index + ahead).catch(() => {});
      }
    }
    packState(state) {
      const working = ['installing', 'removing'].includes(state.phase);
      byId('voice-pack-status').textContent = state.message;
      byId('voice-install').hidden = working || state.phase === 'ready';
      byId('voice-cancel-install').hidden = state.phase !== 'installing';
      byId('voice-preview').hidden = state.phase !== 'ready';
      byId('voice-remove').hidden = !['ready', 'upgrade'].includes(state.phase);
      byId('voice-install').textContent = state.phase === 'upgrade' ? '更新语音包' : '下载语音包';
      if (state.phase === 'missing' && byId('voice-error').textContent) byId('voice-install').textContent = '重新下载';
    }
    async openManager() {
      byId('voice-error').textContent = '';
      this.packState(await this.api.voiceStatus());
      byId('voice-dialog').showModal();
    }
    attach(doc) {
      this.warm();
      byId('speech-resume').hidden = !this.context.getBook()?.listeningPosition;
      doc.addEventListener('click', event => {
        if (!this.active || event.target.closest('a') || doc.getSelection()?.toString()) return;
        const items = units(doc); const index = items.findIndex(item => item.node.contains(event.target));
        if (index >= 0) { event.preventDefault(); this.start(items, index); }
      });
      const detach = () => {
        if (!this.active || !this.items?.[this.index]?.node) return;
        this.following = false; byId('speech-follow').hidden = false;
      };
      doc.addEventListener('wheel', detach, { passive: true });
      doc.addEventListener('touchmove', detach, { passive: true });
      doc.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) detach(); });
      doc.addEventListener('pointerdown', event => { if (event.clientX >= doc.documentElement.clientWidth) detach(); });
    }
    message(value) {
      byId('speech-status').textContent = value;
      byId('speech-toggle').title = `朗读：${value}`;
      byId('speech-toggle').classList.toggle('is-active', this.active);
      byId('speech-toggle').classList.toggle('is-paused', this.paused);
      if (byId('voice-dialog').open && this.items?.[0]?.node === null) byId('voice-pack-status').textContent = value;
    }
    async toggle() {
      if (this.checkTimer()) return;
      if (this.failed) {
        if (this.nextChapter != null) {
          this.failed = false; const version = this.version;
          try { await this.finishChapter(version); } catch (error) { this.error(error, version); }
        }
        else this.start(this.items, this.index);
        return;
      }
      if (!this.active) {
        if ((await this.api.voiceStatus()).phase !== 'ready') { await this.openManager(); return; }
        const doc = this.getDocument(); if (!doc?.querySelector('article')) return;
        const items = units(doc); let index = items.findIndex(item => item.node.getBoundingClientRect().bottom > 24);
        if (!items.length) throw new Error('本章没有可朗读的文字。');
        this.start(items, Math.max(0, index)); return;
      }
      this.paused = !this.paused;
      if (this.paused) {
        this.audio?.pause();
        if (this.gap) { clearTimeout(this.gapTimer); this.gap.remaining = Math.max(0, this.gap.remaining - (performance.now() - this.gap.started)); }
        this.message('已暂停');
      }
      else {
        this.message(this.loading ? '正在准备声音…' : `正在朗读 · ${this.speaker}`);
        if (this.gap) this.scheduleGap();
        else if (this.audio && !this.audio.ended) {
          const version = this.version;
          this.audio.play().catch(error => this.error(error, version));
        }
      }
      byId('speech-play').textContent = this.paused ? '▷ 继续' : 'Ⅱ 暂停';
    }
    stop(message = this.voiceLabel(), keepTimer = false) {
      this.version++; this.active = false; this.paused = false; this.failed = false; this.loading = false;
      this.nextChapter = null;
      if (!keepTimer) this.setTimer('off');
      this.release(); this.prepared.clear();
      clearTimeout(this.gapTimer); this.gap = null;
      this.getDocument()?.querySelectorAll('.reader-speaking').forEach(node => node.classList.remove('reader-speaking'));
      byId('speech-follow').hidden = true; byId('speech-play').textContent = '▷ 朗读'; byId('speech-stop').disabled = true;
      byId('speech-previous').disabled = byId('speech-next').disabled = true;
      this.message(message); this.api.cancelSpeech().catch(() => {});
    }
    release() {
      this.player?.dispose(); this.player = null;
      if (this.audio) { this.audio.onended = null; this.audio.onplaying = null; this.audio.onerror = null; this.audio.onwaiting = null; this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.audio = null; }
      if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    }
    async start(items, index, options = {}) {
      if (this.checkTimer()) return;
      this.stop(undefined, true); this.items = items; this.index = index; this.active = true; this.following = options.following ?? true; this.paused = options.paused ?? false;
      byId('speech-stop').disabled = false; byId('speech-play').textContent = this.paused ? '▷ 继续' : 'Ⅱ 暂停';
      const version = this.version;
      try { await this.api.cancelSpeech(); if (version === this.version) await this.play(index, version); }
      catch (error) { this.error(error, version); }
    }
    adjacent(direction) {
      const node = this.items?.[this.index]?.node;
      if (!node) return -1;
      let index = this.index;
      while (index >= 0 && index < this.items.length && this.items[index].node === node) index += direction;
      if (index < 0 || index >= this.items.length) return -1;
      while (index > 0 && this.items[index - 1].node === this.items[index].node) index--;
      return index;
    }
    jump(direction) {
      if (!this.active) return;
      const index = this.adjacent(direction);
      if (index >= 0) this.start(this.items, index);
    }
    async resume() {
      if (this.checkTimer()) return;
      const book = this.context.getBook(); const saved = book?.listeningPosition;
      if (!saved) return;
      let version = this.version;
      if ((await this.api.voiceStatus()).phase !== 'ready') { await this.openManager(); return; }
      if (this.context.getBook() !== book || version !== this.version || this.checkTimer()) return;
      const crossing = saved.chapter !== this.context.getChapter();
      if (crossing) {
        this.stop(undefined, true); version = this.version;
        this.active = true; this.loading = true; this.following = true;
        byId('speech-stop').disabled = false; byId('speech-play').textContent = 'Ⅱ 暂停';
        this.message('正在恢复上次听读…');
      }
      try {
        if (crossing) {
          const opened = await this.context.advanceChapter(saved.chapter);
          if (version !== this.version || this.context.getBook() !== book || this.checkTimer()) return;
          if (!opened) throw new Error('听读章节暂时无法打开，请重试。');
        }
        const items = units(this.getDocument());
        let index = items.findIndex(item => item.block === saved.block && item.part === saved.part);
        if (index < 0) index = items.findIndex(item => item.block === saved.block);
        if (index < 0) throw new Error('上次听读的段落已无法定位，请从当前段落开始。');
        if (crossing) { this.items = items; await this.play(index, version); }
        else this.start(items, index);
      } catch (error) {
        if (version !== this.version) return;
        if (crossing) this.stop('恢复未完成 · 请重试');
        throw error;
      }
    }
    remember(item) {
      const book = this.context.getBook();
      if (!item.node || !book) return;
      const saved = { chapter: this.context.getChapter(), block: item.block, part: item.part };
      if (JSON.stringify(saved) === JSON.stringify(book.listeningPosition)) return;
      this.context.savePosition(book.id, saved).then(() => {
        book.listeningPosition = saved;
        if (this.context.getBook() === book) byId('speech-resume').hidden = false;
      }).catch(this.onError);
    }
    scheduleGap() {
      const gap = this.gap;
      gap.started = performance.now();
      this.gapTimer = setTimeout(() => {
        if (this.gap !== gap || this.paused || gap.version !== this.version) return;
        this.gap = null;
        this.play(gap.index, gap.version).catch(error => this.error(error, gap.version));
      }, gap.remaining);
    }
    prepare(index) {
      if (!this.prepared.has(index)) this.prepared.set(index, this.api.openSpeechStream(this.items[index].text, 'calm', this.speaker));
      return this.prepared.get(index);
    }
    async finishChapter(version) {
      if (version !== this.version || this.checkTimer()) return;
      const book = this.context.getBook();
      if (this.sleepMode === 'chapter') { this.stop('本章已读完 · 定时停止'); return; }
      if (!this.autoAdvance || !book || !this.items.some(item => item.node)) { this.stop('本章已读完'); return; }
      this.loading = true; this.prepared.clear();
      for (let next = this.nextChapter ?? this.context.getChapter() + 1; next < book.chapters.length; next++) {
        this.nextChapter = next; this.message(this.paused ? '已暂停 · 正在切换章节' : '正在进入下一章…');
        const opened = await this.context.advanceChapter(next);
        if (version !== this.version || this.context.getBook() !== book || this.checkTimer()) return;
        if (!opened) throw new Error('下一章暂时无法打开，请重试。');
        if (!this.autoAdvance || this.sleepMode === 'chapter') { this.stop('已停止自动续读'); return; }
        const items = units(this.getDocument());
        if (!items.length) continue;
        this.items = items; this.index = 0; this.nextChapter = null;
        await this.play(0, version); return;
      }
      this.stop('全书已读完');
    }
    async play(index, version) {
      if (version !== this.version || this.checkTimer()) return;
      if (index >= this.items.length) { await this.finishChapter(version); return; }
      this.index = index; this.loading = true; this.message(this.paused ? '已暂停 · 正在准备声音' : '正在准备声音…');
      byId('speech-previous').disabled = this.adjacent(-1) < 0;
      byId('speech-next').disabled = this.adjacent(1) < 0;
      const stream = await this.prepare(index);
      if (version !== this.version) return;
      this.prepared.delete(index); this.release();
      const player = this.player = new StreamingPlayer(this.api, stream, error => this.error(error, version));
      const audio = this.audio = player.audio; audio.playbackRate = this.rate; audio.preservesPitch = true;
      audio.onplaying = () => {
        if (version !== this.version || this.checkTimer()) return;
        const node = this.items[index].node;
        this.getDocument()?.querySelectorAll('.reader-speaking').forEach(item => item.classList.remove('reader-speaking'));
        node?.classList.add('reader-speaking'); this.follow(); this.message(`正在朗读 · ${this.speaker}`);
        this.remember(this.items[index]);
        this.prefetch();
      };
      audio.onended = () => {
        if (version !== this.version) return;
        this.release();
        this.gap = { index: index + 1, version, remaining: this.items[index + 1]?.node === this.items[index].node ? 30 : 180 };
        if (!this.paused) this.scheduleGap();
      };
      audio.onerror = () => this.error(new Error('声音播放失败，请重试。'), version);
      audio.onwaiting = () => { if (version === this.version && !this.paused) this.message('正在缓冲声音…'); };
      await player.ready;
      if (version !== this.version || this.checkTimer()) return;
      this.loading = false;
      if (!this.paused) await audio.play(); else this.message('已暂停');
    }
    follow(force = false) {
      const node = this.items?.[this.index]?.node;
      byId('speech-follow').hidden = this.following || !node;
      if (!node || !this.following) return;
      const rect = node.getBoundingClientRect(); const win = node.ownerDocument.defaultView;
      if (force || rect.top < 20 || rect.top > win.innerHeight - 80) win.scrollTo({ top: win.scrollY + rect.top - 55, behavior: 'instant' });
    }
    error(error, version) {
      if (version !== this.version) return;
      this.failed = true; this.loading = false; this.audio?.pause();
      this.message('准备失败 · 点击重试'); byId('speech-play').textContent = '重试';
      if (byId('voice-dialog').open) byId('voice-error').textContent = error.message;
      this.onError(error);
    }
  }
  ReadAloud.chunks = chunks; ReadAloud.units = units; ReadAloud.normalizeText = normalizeText;
  return ReadAloud;
})();
