window.ReaderNotes = class {
  constructor(api, getDocument, context) {
    this.api = api; this.doc = getDocument; this.context = context;
    const $ = id => document.getElementById(id); this.$ = $;
    this.color = 'yellow';
    $('selection-tools').onmousedown = event => { if (event.target.closest('button')) event.preventDefault(); };
    $('selection-color').onchange = () => { this.color = $('selection-color').value; if (this.pending) this.pending.value.color = this.color; };
    $('note-filter').onchange = () => this.render();
    $('note-export-markdown').onclick = () => this.export('markdown').catch(context.onError);
    $('note-export-text').onclick = () => this.export('text').catch(context.onError);
    $('selection-highlight').onclick = () => this.highlight().catch(context.onError);
    $('selection-note').onclick = () => { if (this.pending) this.edit(this.pending.book, this.pending.value); };
    $('selection-ai').onclick = async () => {
      const pending = this.pending; if (!pending || $('selection-ai').disabled) return;
      $('selection-ai').disabled = true;
      try {
        const saved = pending.book.annotations?.find(value => value.chapter === pending.value.chapter && value.start === pending.value.start && value.end === pending.value.end && value.quote === pending.value.quote)
          || await this.save(pending.book, { ...pending.value, isExcerpt: false });
        this.doc()?.getSelection()?.removeAllRanges(); this.hide(); await context.discuss(pending.book, saved);
      } catch (error) { context.onError(error); }
      finally { $('selection-ai').disabled = false; }
    };
    $('note-cancel').onclick = () => $('note-dialog').close();
    $('note-form').onsubmit = async event => {
      event.preventDefault(); $('note-save').disabled = true; $('note-error').textContent = '';
      try { await this.save(this.editing.book, { ...this.editing.value, note: $('note-text').value, color: $('note-color').value, isExcerpt: true }); $('note-dialog').close(); }
      catch (error) { $('note-error').textContent = error.message; }
      finally { $('note-save').disabled = false; }
    };
  }
  hide() { this.$('selection-tools').hidden = true; this.pending = null; }
  attach(doc) {
    this.hide(); this.apply();
    const update = () => {
      if (doc !== this.doc() || this.$('note-dialog').open || document.activeElement === this.$('selection-color')) return;
      const value = window.ReadingContent.selection(doc);
      if (!value) { this.hide(); return; }
      this.pending = { book: this.context.getBook(), value: { ...value, chapter: this.context.getChapter(), color: this.color } };
      const rect = doc.getSelection().getRangeAt(0).getBoundingClientRect();
      const frame = document.getElementById('book-frame').getBoundingClientRect();
      const bubble = this.$('selection-tools');
      bubble.hidden = false; bubble.style.left = `${Math.max(12, Math.min(innerWidth - bubble.offsetWidth - 12, frame.left + rect.left))}px`;
      bubble.style.top = `${Math.max(78, Math.min(innerHeight - 100, frame.top + rect.bottom + 10))}px`;
    };
    doc.addEventListener('selectionchange', update); doc.addEventListener('pointerup', update); doc.addEventListener('keyup', update);
    doc.defaultView.addEventListener('scroll', () => this.hide(), { passive: true });
    doc.addEventListener('keydown', event => { if (event.key === 'Escape') { doc.getSelection()?.removeAllRanges(); this.hide(); } });
  }
  apply(active = null) {
    clearTimeout(this.activeTimer);
    const doc = this.doc(); if (!doc?.querySelector('article')) return;
    window.ReadingContent.annotations(doc, this.context.getBook()?.annotations, this.context.getChapter(), active);
    if (active) this.activeTimer = setTimeout(() => { if (doc === this.doc()) this.apply(); }, 1800);
  }
  async save(book, value) {
    let saved; await this.context.persist(async () => { saved = await this.api.saveAnnotation(book.id, value); });
    book.annotations ??= [];
    const index = book.annotations.findIndex(item => item.id === saved.id);
    if (index < 0) book.annotations.push(saved); else book.annotations[index] = saved;
    if (book === this.context.getBook()) { this.apply(saved.id); this.render(); }
    return saved;
  }
  async highlight() {
    const pending = this.pending; if (!pending || pending.book !== this.context.getBook()) return;
    await this.save(pending.book, pending.value); this.doc().getSelection()?.removeAllRanges(); this.hide(); this.context.toast('已保存标注。');
  }
  async export(format) {
    const book = this.context.getBook();
    const count = (book?.annotations || []).filter(item => item.kind !== 'image' && item.isExcerpt !== false).length;
    if (!book || !count) { this.context.toast('还没有可导出的摘录。', true); return; }
    const result = await this.api.exportNotes(book.id, format);
    if (result) this.context.toast(`已导出 ${result.count} 条摘录与笔记。`);
  }
  edit(book, value) {
    this.editing = { book, value }; this.hide();
    this.$('note-quote').textContent = value.quote; this.$('note-text').value = value.note || '';
    this.$('note-color').value = value.color || 'yellow';
    this.$('note-error').textContent = ''; this.$('note-dialog').showModal(); this.$('note-text').focus();
  }
  render() {
    const book = this.context.getBook(); const all = (book?.annotations || []).filter(item => item.isExcerpt !== false);
    const exportable = all.filter(item => item.kind !== 'image');
    this.$('note-export-markdown').disabled = !exportable.length;
    this.$('note-export-text').disabled = !exportable.length;
    const values = all.filter(item => this.$('note-filter').value === 'all' || (item.color || 'yellow') === this.$('note-filter').value).sort((a, b) => a.chapter - b.chapter || a.start - b.start);
    this.$('note-list').replaceChildren(); this.$('note-status').textContent = all.length ? `已保存 ${all.length} 条摘录，当前显示 ${values.length} 条。` : '选中喜欢的文字，可以标注或写笔记。';
    for (const value of values) {
      const row = document.createElement('div'); row.className = 'note-entry';
      row.dataset.color = value.color || 'yellow';
      const jump = document.createElement('button'); jump.className = 'reading-result';
      const title = document.createElement('small'); title.textContent = book.chapters[value.chapter].label;
      const quote = document.createElement('span'); quote.textContent = value.quote; jump.append(title, quote);
      if (value.note) { const note = document.createElement('p'); note.className = 'note-thought'; note.textContent = value.note; jump.append(note); }
      jump.onclick = () => this.context.goto(value).catch(this.context.onError);
      const actions = document.createElement('div'); actions.className = 'note-actions';
      const edit = document.createElement('button'); edit.textContent = '编辑'; edit.onclick = () => this.edit(book, value);
      const discuss = document.createElement('button'); discuss.textContent = value.discussion?.length ? '继续讨论' : '问 AI';
      discuss.onclick = () => this.context.discuss(book, value).catch(this.context.onError);
      const remove = document.createElement('button'); remove.textContent = '删除'; remove.setAttribute('aria-label', '删除摘录');
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          await this.context.persist(() => this.api.removeAnnotation(book.id, value.id));
          book.annotations = book.annotations.filter(item => item.id !== value.id);
          this.context.removed(book.id, value.id);
          if (book === this.context.getBook()) { this.apply(); this.render(); }
          this.context.toast('已删除摘录。', false, async () => { await this.save(book, { ...value, id: undefined }); this.context.toast('已恢复摘录。'); });
        } catch (error) { remove.disabled = false; this.context.onError(error); }
      };
      actions.append(discuss, edit, remove); row.append(jump, actions); this.$('note-list').append(row);
    }
  }
};
