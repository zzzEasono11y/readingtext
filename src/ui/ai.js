window.ReaderAi = class {
  constructor(api, context) {
    this.api = api; this.context = context; this.$ = id => document.getElementById(id); this.settingsVersion = 0; this.drafts = new Map();
    const $ = this.$;
    $('ai-settings-shelf').onclick = $('ai-settings-reader').onclick = () => this.openSettings().catch(context.onError);
    $('ai-settings-close').onclick = () => $('ai-settings-dialog').close();
    $('ai-key-show').onclick = () => { const visible = $('ai-key').type === 'password'; $('ai-key').type = visible ? 'text' : 'password'; $('ai-key-show').textContent = visible ? '隐藏' : '显示'; };
    $('ai-settings-dialog').addEventListener('close', () => { this.settingsVersion++; $('ai-key').value = ''; this.api.cancelAi().catch(context.onError); });
    $('ai-detect').onclick = () => this.settingAction(async () => {
      const models = await api.aiModels($('ai-key').value.trim());
      if (!$('ai-settings-dialog').open) return;
      $('ai-models').replaceChildren(...models.map(value => { const option = document.createElement('option'); option.value = value.id; option.label = value.name; return option; }));
      $('ai-model-picker').replaceChildren(...models.map(value => { const option = document.createElement('option'); option.value = value.id; option.textContent = value.name; return option; }));
      $('ai-detected-models').hidden = false;
      if (!models.some(value => value.id === $('ai-model').value)) $('ai-model').value = models[0].id;
      $('ai-model-picker').value = $('ai-model').value;
      $('ai-settings-status').textContent = `连接成功，发现 ${models.length} 个文字模型。选择后请保存设置。`;
    });
    $('ai-model-picker').onchange = () => { $('ai-model').value = $('ai-model-picker').value; };
    $('ai-test').onclick = () => this.settingAction(async () => {
      $('ai-settings-status').textContent = '正在测试回答…';
      const result = await api.testAi(crypto.randomUUID(), $('ai-key').value.trim(), $('ai-model').value.trim());
      if ($('ai-settings-dialog').open) $('ai-settings-status').textContent = `测试成功：${result.answer}\n${this.usage(result.usage)}`;
    });
    $('ai-settings-form').onsubmit = event => { event.preventDefault(); this.settingAction(async () => {
      const value = await api.saveAiSettings({ model: $('ai-model').value.trim(), key: $('ai-key').value.trim() });
      this.settings = value; $('ai-key').value = ''; this.keyUi(); $('ai-settings-status').textContent = '设置已保存，密钥仅保存在这台电脑。';
    }); };
    $('ai-key-clear').onclick = () => this.settingAction(async () => {
      this.settings = await api.saveAiSettings({ model: $('ai-model').value.trim(), clearKey: true });
      $('ai-key').value = ''; this.keyUi(); $('ai-settings-status').textContent = '已清除本机密钥，讨论记录仍保留。';
    });
    $('ai-close').onclick = () => this.close();
    this.images = new window.ReaderAiImages(this);
    $('ai-stop').onclick = () => this.cancel();
    $('ai-conversation').onchange = () => {
      const target = this.book?.annotations.find(value => value.id === $('ai-conversation').value);
      if (target) this.open(this.book, target).catch(error => { $('ai-conversation').value = this.annotation?.id || ''; context.onError(error); });
    };
    $('ai-clear').onclick = () => this.confirmTrim(this.annotation?.discussion?.[0]?.id);
    $('ai-save-excerpt').onclick = async () => {
      const book = this.book; const annotation = this.annotation;
      try {
        const saved = await context.saveExcerpt(book, annotation);
        if (this.book?.id === book.id && this.annotation?.id === saved.id) { this.annotation = saved; this.render(); }
        context.toast('已加入摘录并保存标注。');
      }
      catch (error) { $('ai-error').textContent = error.message; }
    };
    $('ai-delete-cancel').onclick = () => $('ai-delete-dialog').close();
    $('ai-delete-dialog').addEventListener('close', () => { this.trimTarget = null; });
    $('ai-delete-dialog').addEventListener('cancel', event => { if (this.mutating) event.preventDefault(); });
    $('ai-delete-confirm').onclick = () => this.trim().catch(error => { $('ai-delete-error').textContent = error.message; });
    $('ai-form').onsubmit = event => { event.preventDefault(); this.send().catch(context.onError); };
    $('ai-explain').onclick = () => { $('ai-question').value = '请用容易理解的话解释这段原文。'; $('ai-question').focus(); };
    $('ai-discuss').onclick = () => { $('ai-question').value = '我对这段话的理解是：'; $('ai-question').focus(); };
    $('ai-draft').onclick = () => {
      if (this.annotation?.discussion?.length >= 20) { this.draft(this.annotation, this.annotation.discussion.at(-1).answer); return; }
      this.send('请把这条摘录和我们的讨论整理成一段阅读笔记草稿，400 字以内。区分原文和解读，不添加新事实，不冒充我的个人观点。', true).catch(context.onError);
    };
    $('ai-retry-save').onclick = () => this.flush().catch(error => { $('ai-error').textContent = error.message; });
    api.onAiDelta(value => { if (value.id === this.requestId && this.streamingNode) { this.streamingNode.textContent += value.text; $('ai-scroll').scrollTop = $('ai-scroll').scrollHeight; } });
  }
  usage(value = {}) { return Number.isFinite(value.total_tokens) ? `本次用量 ${value.total_tokens} tokens` : '服务商未返回用量'; }
  keyUi() {
    this.$('ai-key').placeholder = this.settings?.hasKey ? '已保存密钥；留空继续使用，填写新值可替换' : '粘贴你的 DeepSeek API Key';
    this.$('ai-key-state').textContent = this.settings?.hasKey ? '本机已保存密钥' : '尚未保存密钥';
    this.$('ai-key-clear').disabled = !this.settings?.hasKey;
  }
  async openSettings() {
    if (this.settingBusy) throw new Error('上一项检测尚未结束，请稍候。');
    this.cancel(); this.settingsVersion++;
    this.settings = await this.api.aiStatus();
    this.$('ai-key').value = ''; this.$('ai-key').type = 'password'; this.$('ai-key-show').textContent = '显示'; this.keyUi();
    this.$('ai-model').value = this.settings.model; this.$('ai-settings-error').textContent = this.settings.error || ''; this.$('ai-settings-status').textContent = '';
    this.$('ai-settings-dialog').showModal();
  }
  async settingAction(action) {
    if (this.settingBusy) return;
    this.settingBusy = true; const version = this.settingsVersion;
    for (const id of ['ai-detect', 'ai-test', 'ai-settings-save', 'ai-key-clear']) this.$(id).disabled = true;
    this.$('ai-settings-error').textContent = '';
    try { await action(); }
    catch (error) { if (version === this.settingsVersion) this.$('ai-settings-error').textContent = error.message; }
    finally {
      this.settingBusy = false;
      for (const id of ['ai-detect', 'ai-test', 'ai-settings-save']) this.$(id).disabled = false;
      this.keyUi();
    }
  }
  cancel() { if (this.requestId) { this.render(); this.$('ai-error').textContent = '已停止生成，未完成内容未保存；服务商可能已计入部分用量。'; } this.requestId = null; this.streamingNode = null; this.api.cancelAi().catch(this.context.onError); this.busyUi(false); }
  rememberDraft() { if (this.annotation) this.drafts.set(this.book.id + ':' + this.annotation.id, { question: this.$('ai-question').value, image: this.images.image }); }
  close() { this.rememberDraft(); this.cancel(); this.images.abort(); this.$('ai-panel').hidden = true; this.$('ai-open-reader').setAttribute('aria-expanded', 'false'); }
  removed(bookId, annotationId) {
    if (this.pendingTurn?.book.id === bookId && this.pendingTurn.annotation.id === annotationId) this.pendingTurn = null;
    if (this.book?.id === bookId && this.annotation?.id === annotationId) { this.close(); this.annotation = null; }
    this.drafts.delete(bookId + ':' + annotationId);
  }
  async open(book, annotation) {
    await this.flush(); this.rememberDraft(); this.cancel(); this.images.abort(); this.context.onOpen();
    this.book = book; this.annotation = annotation ? book.annotations.find(item => item.id === annotation.id) || annotation : null;
    const draft = this.annotation ? this.drafts.get(book.id + ':' + this.annotation.id) : null;
    this.images.set(draft?.image || null);
    this.$('ai-panel').hidden = false; this.$('ai-open-reader').setAttribute('aria-expanded', 'true'); this.$('ai-question').value = draft?.question || ''; this.$('ai-error').textContent = '';
    this.$('ai-quote').textContent = this.annotation?.kind === 'image' ? '截图会话：图片保留在对应问题中，不自动标注或摘录。' : this.annotation?.quote || '选中文字后问 AI，或用输入框旁的截图按钮截取阅读区域。';
    this.$('ai-source').textContent = `${book.title} · ${book.chapters[this.annotation?.chapter ?? this.context.getChapter()].label}`;
    this.render(); this.$('ai-question').focus();
  }
  render() {
    this.$('ai-messages').replaceChildren();
    const turns = this.annotation?.discussion || [];
    this.$('ai-conversation').replaceChildren(...(this.book?.annotations || []).filter(value => value.discussion?.length || value.isExcerpt === false || value.id === this.annotation?.id).map(value => {
      const option = document.createElement('option'); option.value = value.id;
      option.textContent = `第 ${value.chapter + 1} 节 · ${value.quote.replace(/\s+/g, ' ').slice(0, 24)}… · ${value.discussion?.length || 0} 轮`; return option;
    }));
    this.$('ai-conversation').value = this.annotation?.id || '';
    this.$('ai-memory').textContent = `本段记忆：${turns.length} / 20 轮 · 各段独立保存`;
    this.$('ai-save-excerpt').hidden = this.annotation?.isExcerpt !== false || this.annotation?.kind === 'image';
    this.$('ai-empty').hidden = !this.annotation || Boolean(turns.length);
    for (const turn of turns) {
      const question = this.message('你', turn.question, 'user');
      if (turn.image) {
        const image = document.createElement('img'); image.className = 'ai-saved-image'; image.src = turn.image.dataUrl; image.alt = '本轮提问的截图'; image.tabIndex = 0; image.setAttribute('role', 'button');
        image.onclick = () => this.images.preview(turn.image, false); image.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); image.click(); } }; question.parentElement.append(image);
      }
      const answer = this.message('AI · ' + turn.model, turn.answer, 'assistant');
      this.sources(turn, answer);
      const actions = document.createElement('div'); actions.className = 'ai-turn-actions';
      const action = (label, className, handler) => { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.dataset.turnId = turn.id; button.onclick = () => Promise.resolve().then(handler).catch(error => { this.$('ai-error').textContent = error.message; }); actions.append(button); return button; };
      action('复制回答', 'ai-copy', async () => { await this.api.copyAiAnswer(this.book.id, this.annotation.id, turn.id); this.context.toast('已复制回答。'); });
      if (turn.id === turns.at(-1).id) {
        const retry = action('重新生成', 'ai-regenerate', () => this.send(turn.question, false, turn.id)); retry.title = '会再次调用模型；新回答完整保存后才替换旧回答';
      }
      action('删除此轮及后续', 'ai-remove', () => this.confirmTrim(turn.id));
      answer.parentElement.append(actions);
      const status = document.createElement('small'); status.className = 'ai-turn-usage'; status.textContent = this.usage(turn.usage) + (turn.truncated ? ' · 回答达到长度上限' : ''); this.$('ai-messages').append(status);
    }
    this.$('ai-draft').hidden = this.annotation?.kind === 'image';
    this.$('ai-draft').disabled = !turns.length || Boolean(this.requestId);
    this.$('ai-draft').textContent = turns.length >= 20 ? '将回答加入笔记' : '整理成笔记';
    this.$('ai-draft').title = turns.length >= 20 ? '讨论已达上限，将最后一条回答填入笔记草稿，不再调用 AI' : '调用 AI 整理讨论，再由你编辑和保存';
    this.$('ai-retry-save').hidden = !this.pendingTurn;
    this.$('ai-send').disabled = !this.annotation || Boolean(this.requestId);
    this.managementUi();
  }
  message(label, text, role) {
    const row = document.createElement('section'); row.className = `ai-message ai-${role}`;
    const heading = document.createElement('small'); heading.textContent = label;
    const body = document.createElement('div'); body.textContent = text; row.append(heading, body); this.$('ai-messages').append(row); return body;
  }
  sources(turn, body) {
    const values = turn.sources || []; const book = this.book;
    const details = document.createElement('details'); details.className = 'ai-sources';
    const summary = document.createElement('summary'); summary.textContent = values.length ? `原文依据 · ${values.length} 处已匹配` : '依据说明'; details.append(summary);
    const note = document.createElement('p'); note.textContent = values.length ? '引文已逐字匹配所选原文；文学解读仍可能有不同理解。外部说法未经联网核验。' : '本轮没有逐字匹配的书内引文。图片内容和 AI 解读仍需核对，外部说法未经联网核验。'; details.append(note);
    const link = (source, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'ai-source-link'; button.textContent = `[原文 ${index + 1}]`; button.onclick = () => this.context.gotoSource(book, source).catch(this.context.onError); return button; };
    if (values.length) {
      body.replaceChildren(); let offset = 0;
      for (const match of turn.answer.matchAll(/\[原文 ([1-8])\]/g)) {
        body.append(document.createTextNode(turn.answer.slice(offset, match.index))); const index = Number(match[1]) - 1;
        body.append(values[index] ? link(values[index], index) : document.createTextNode(match[0])); offset = match.index + match[0].length;
      }
      body.append(document.createTextNode(turn.answer.slice(offset)));
      values.forEach((source, index) => { const row = document.createElement('p'); row.append(link(source, index), document.createTextNode(' ' + book.chapters[source.chapter].label + ' · ' + source.quote)); details.append(row); });
    }
    body.parentElement.append(details);
  }
  busyUi(busy) {
    this.$('ai-send').disabled = busy; this.$('ai-stop').hidden = !busy;
    if (!this.annotation) this.$('ai-send').disabled = true;
    this.$('ai-draft').disabled = busy || !this.annotation?.discussion?.length;
    this.$('ai-send').textContent = busy ? '正在回答…' : '发送';
    this.managementUi();
  }
  managementUi() {
    const locked = Boolean(this.requestId || this.pendingTurn || this.mutating);
    this.$('ai-save-excerpt').disabled = locked;
    this.$('ai-capture').disabled = locked;
    this.$('ai-clear').disabled = locked || !this.annotation?.discussion?.length;
    this.$('ai-conversation').disabled = Boolean(this.mutating);
    this.$('ai-messages').querySelectorAll('.ai-regenerate,.ai-remove').forEach(button => { button.disabled = locked; });
  }
  confirmTrim(fromId) {
    if (!fromId || this.requestId || this.pendingTurn || this.mutating) return;
    const turns = this.annotation.discussion; const index = turns.findIndex(turn => turn.id === fromId); if (index < 0) return;
    this.trimTarget = { book: this.book, annotationId: this.annotation.id, fromId, lastId: turns.at(-1).id };
    this.$('ai-delete-description').textContent = `将删除这轮及之后共 ${turns.length - index} 轮讨论。选中的原文、标注和自己的笔记都会保留。`;
    this.$('ai-delete-error').textContent = ''; this.$('ai-delete-dialog').showModal();
  }
  async trim() {
    const target = this.trimTarget; if (!target || this.mutating) return;
    this.mutating = true; this.$('ai-delete-confirm').disabled = true; this.$('ai-delete-cancel').disabled = true; this.managementUi();
    try {
      const saved = await this.api.trimAiDiscussion(target.book.id, target.annotationId, target.fromId, target.lastId);
      this.context.update(target.book, saved);
      if (this.annotation?.id === saved.id) { this.annotation = saved; this.render(); }
      this.$('ai-delete-dialog').close(); this.context.toast('已删除讨论，原文和笔记仍保留。');
    } finally { this.mutating = false; this.$('ai-delete-confirm').disabled = false; this.$('ai-delete-cancel').disabled = false; this.managementUi(); }
  }
  async send(question = this.$('ai-question').value, asNote = false, replaceId = null) {
    if (this.requestId || this.mutating || !this.annotation) return;
    if (!question.trim()) { this.$('ai-question').focus(); return; }
    const id = crypto.randomUUID(); const book = this.book; const annotation = this.annotation;
    this.requestId = id; this.busyUi(true); this.$('ai-error').textContent = '';
    try {
      await this.flush(); const settings = await this.api.aiStatus();
      if (this.requestId !== id) return;
      if (!settings.hasKey) { await this.openSettings(); return; }
      this.render(); this.busyUi(true);
      if (replaceId === null) this.message('你', question, 'user');
      this.streamingNode = this.message('AI · ' + settings.model + (replaceId ? ' · 正在重新生成' : ''), '', 'assistant');
      this.$('ai-empty').hidden = true;
      const image = replaceId === null && !asNote ? this.images.image : null;
      const turn = await this.api.askAi(id, book.id, annotation.id, question, replaceId, image);
      if (this.requestId !== id) return;
      this.pendingTurn = { book, annotation, turn, asNote, replaceId }; await this.flush();
      if (image && this.images.image === image) this.images.set(null);
      if (replaceId === null && !asNote && this.$('ai-question').value === question) { this.$('ai-question').value = ''; this.drafts.delete(book.id + ':' + annotation.id); }
    } catch (error) {
      if (this.requestId === id) this.$('ai-error').textContent = this.pendingTurn
        ? '回答已生成，但尚未保存到本机。请重试保存，不会重新调用模型。' : error.message;
    } finally {
      if (this.requestId === id) { this.requestId = null; this.streamingNode = null; this.busyUi(false); this.$('ai-retry-save').hidden = !this.pendingTurn; }
    }
  }
  async flush() {
    if (this.saving) return this.saving;
    if (!this.pendingTurn) return;
    const pending = this.pendingTurn;
    this.saving = (async () => {
      const saved = await this.api.saveAiTurn(pending.book.id, pending.annotation.id, pending.turn, pending.replaceId);
      this.context.update(pending.book, saved);
      if (this.pendingTurn === pending) this.pendingTurn = null;
      if (this.book?.id === pending.book.id && this.annotation?.id === saved.id) { this.annotation = saved; this.render(); this.$('ai-error').textContent = ''; }
      if (this.book?.id === pending.book.id && this.annotation?.id === saved.id && pending.turn.image?.dataUrl === this.images.image?.dataUrl) this.images.set(null);
      if (pending.asNote && this.context.getBook()?.id === pending.book.id) this.draft(saved, pending.turn.answer);
    })();
    try { await this.saving; } finally { this.saving = null; }
  }
  draft(saved, answer) {
    if (this.$('note-dialog').open) { this.context.onError(new Error('草稿已保存在讨论中；请先完成当前笔记的编辑。')); return; }
    const prefix = saved.note ? saved.note + '\n\n' : ''; const label = 'AI 讨论草稿（待核对）：\n';
    if (prefix.length + label.length >= 2000) { this.context.onError(new Error('现有笔记已接近长度上限，请先整理笔记。讨论已保存。')); return; }
    const draft = prefix + label + answer.slice(0, 2000 - prefix.length - label.length);
    this.context.editNote({ ...saved, note: draft });
  }
};
