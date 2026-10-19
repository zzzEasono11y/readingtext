window.ReaderAiImages = class {
  constructor(reader) {
    this.reader = reader; this.$ = reader.$;
    this.$('ai-capture').onclick = () => this.start().catch(reader.context.onError);
    this.$('ai-image-remove').onclick = () => this.set(null);
    const thumb = this.$('ai-image-thumb'); thumb.tabIndex = 0; thumb.setAttribute('role', 'button'); thumb.setAttribute('aria-label', '查看待发送截图');
    thumb.onclick = () => { if (this.image) this.preview(this.image, false); };
    thumb.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); thumb.click(); } };
    this.$('ai-image-cancel').onclick = () => this.$('ai-image-dialog').close();
    this.$('ai-image-use').onclick = () => this.use().catch(error => { this.$('ai-image-error').textContent = error.message; });
    this.$('ai-image-dialog').addEventListener('close', () => { this.candidate = null; });
    const layer = this.$('ai-capture-layer');
    layer.onpointerdown = event => {
      if (event.button !== 0 || this.origin || event.target.closest('button')) return;
      const r = layer.getBoundingClientRect(); this.origin = { x: event.clientX - r.left, y: event.clientY - r.top };
      layer.setPointerCapture(event.pointerId); this.rectangle(this.origin);
    };
    layer.onpointermove = event => { if (this.origin) { const r = layer.getBoundingClientRect(); this.rectangle({ x: event.clientX - r.left, y: event.clientY - r.top }); } };
    layer.onpointerup = () => {
      if (!this.origin) return; this.origin = null; const rect = this.rect;
      if (!rect || rect.width < 20 || rect.height < 20) { reader.context.toast('请拖选稍大一些的阅读区域。'); return; }
      this.finish(rect).catch(reader.context.onError);
    };
    layer.onpointercancel = () => this.cancel();
    layer.onkeydown = event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); this.cancel(); } };
    this.$('ai-capture-cancel').onclick = () => this.cancel();
  }
  set(image) {
    this.image = image; this.$('ai-image-draft').hidden = !image;
    if (image) this.$('ai-image-thumb').src = image.dataUrl; else this.$('ai-image-thumb').removeAttribute('src');
  }
  async start() {
    const reader = this.reader;
    if (reader.requestId || reader.pendingTurn || !reader.book) return;
    this.captureBook = reader.book; this.captureChapter = reader.context.getChapter();
    reader.context.onOpen(); this.$('ai-panel').hidden = true;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (this.reader.context.getBook()?.id !== this.captureBook?.id) return;
    const r = this.$('book-frame').getBoundingClientRect(); const layer = this.$('ai-capture-layer');
    Object.assign(layer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    this.$('ai-capture-rect').hidden = true; layer.hidden = false; layer.focus();
  }
  rectangle(point) {
    const layer = this.$('ai-capture-layer'); const x = Math.max(0, Math.min(layer.clientWidth, point.x)); const y = Math.max(0, Math.min(layer.clientHeight, point.y));
    this.rect = { x: Math.min(this.origin.x, x), y: Math.min(this.origin.y, y), width: Math.abs(x - this.origin.x), height: Math.abs(y - this.origin.y) };
    const box = this.$('ai-capture-rect'); box.hidden = false;
    Object.assign(box.style, { left: this.rect.x + 'px', top: this.rect.y + 'px', width: this.rect.width + 'px', height: this.rect.height + 'px' });
  }
  abort() { this.origin = null; this.captureBook = null; this.$('ai-capture-layer').hidden = true; if (this.$('ai-image-dialog').open) this.$('ai-image-dialog').close(); }
  cancel() { this.abort(); this.$('ai-panel').hidden = false; this.$('ai-capture').focus(); }
  async finish(rect) {
    const book = this.captureBook; const chapter = this.captureChapter;
    this.$('ai-capture-layer').hidden = true;
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const image = await this.reader.api.captureReading(rect);
      if (this.captureBook !== book || this.reader.context.getBook()?.id !== book?.id) return;
      if (this.reader.context.getChapter() !== chapter) throw new Error('阅读位置已改变，请重新截取。');
      this.preview(image, true);
    } finally { if (this.captureBook === book && this.reader.context.getBook()?.id === book?.id) this.$('ai-panel').hidden = false; }
  }
  preview(image, use) {
    this.candidate = image; this.$('ai-image-preview').src = image.dataUrl; this.$('ai-image-use').hidden = !use;
    this.$('ai-image-dialog').querySelector('.dialog-note').textContent = use
      ? '本次只截取所选阅读区域。预览不会上传；加入问题并发送后，会将图片和本会话记录交给 DeepSeek。请核对图中文字、数字与公式，图片也会计入 API 用量。'
      : '这是该轮提问保存的截图。关闭预览不会发送请求；继续追问时，模型会再次收到本会话中的图片。';
    this.$('ai-image-error').textContent = ''; this.$('ai-image-dialog').showModal();
  }
  async use() {
    const image = this.candidate; if (!image) return;
    this.$('ai-image-use').disabled = true;
    try {
      const reader = this.reader;
      if (!reader.annotation) { const question = reader.$('ai-question').value; const saved = await reader.context.saveImageSession(reader.book); await reader.open(reader.book, saved); reader.$('ai-question').value = question; }
      this.set(image); this.$('ai-image-dialog').close(); reader.$('ai-question').focus(); reader.busyUi(false);
    } finally { this.$('ai-image-use').disabled = false; }
  }
};
