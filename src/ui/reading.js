/* Book documents never execute scripts; the parent controls navigation and layout. */
window.ReadingContent = (() => {
  function background(settings) {
    const base = { white: [251, 250, 247], blue: [225, 239, 250], gray: [233, 238, 241], sand: [249, 236, 214] }[settings.background] || [251, 250, 247];
    const tint = settings.tint ?? .6;
    return `rgb(${base.map(value => Math.round(255 + (value - 255) * tint)).join(', ')})`;
  }
  function resolve(base, href) {
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null;
    try {
      const [raw, ...hash] = href.split('#');
      const decoded = decodeURIComponent(raw.split('?')[0]);
      if (decoded.includes('\\') || decoded.includes('\0')) return null;
      const parts = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
      if (!decoded) return { path: base, fragment: decodeURIComponent(hash.join('#')) };
      for (const part of decoded.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { if (!parts.length) return null; parts.pop(); }
        else parts.push(part);
      }
      return { path: parts.join('/'), fragment: decodeURIComponent(hash.join('#')) };
    } catch { return null; }
  }
  function styles(settings) {
    const family = { system: '"Microsoft YaHei","Segoe UI",sans-serif', serif: '"ReaderSerif","Microsoft YaHei",serif',
      wenkai: '"ReaderWenKai","Microsoft YaHei",serif', sans: '"ReaderSans","Microsoft YaHei",sans-serif' }[settings.fontFamily] || '"Microsoft YaHei",sans-serif';
    return `@font-face{font-family:ReaderSerif;src:url("app://reader/fonts/SourceHanSerifCN-Regular.otf") format("opentype");font-weight:400;font-style:normal;font-display:block}
      @font-face{font-family:ReaderSans;src:url("app://reader/fonts/SourceHanSansCN-Regular.otf") format("opentype");font-weight:400;font-style:normal;font-display:block}
      @font-face{font-family:ReaderWenKai;src:url("app://reader/fonts/LXGWWenKaiScreen.ttf") format("truetype");font-weight:400;font-style:normal;font-display:block}
      html{color-scheme:light;scroll-behavior:auto;text-rendering:optimizeLegibility}*{box-sizing:border-box}
      body{margin:0;background:${background(settings)};color:#34392f;font-family:${family};
      font-size:${settings.fontSize}px;line-height:${settings.lineHeight};overflow-wrap:anywhere;font-kerning:normal;font-feature-settings:"kern" 1;
      hanging-punctuation:first last;line-break:strict;word-break:normal}
      article{max-width:${settings.width}px;margin:auto;padding:48px 48px 80px;orphans:3;widows:3}
      h1,h2,h3,h4,h5,h6{font-weight:600;line-height:1.5;margin:1.5em 0 1em;break-after:avoid;text-wrap:balance;orphans:3;widows:3}
      h1{font-size:1.55em}h2{font-size:1.3em}h3{font-size:1.15em}
      p{margin:0 0 ${settings.paragraphGap ?? 1.2}em;text-indent:2em;text-align:justify;text-justify:inter-ideograph;text-wrap:pretty;orphans:3;widows:3}
      p:has(> img),p:has(> figure),blockquote p,li p{ text-indent:0;text-align:initial }
      img{max-width:100%;height:auto;display:block;margin:1.5em auto}
      a{color:#426955;text-decoration:underline;text-underline-offset:3px}
      ::highlight(reader-search){background:#f2df86;color:#30382b}
      ::highlight(reader-source){background:#d2e8f9;color:#293b48}
      ::highlight(reader-notes){background:#f4e8b27a}
      ::highlight(reader-note-active){background:#f0d87f;color:#30382b}
      ::highlight(reader-notes-blue){background:#bedff67a}
      ::highlight(reader-note-active-blue){background:#b3d7f2;color:#293b48}
      ::highlight(reader-notes-green){background:#cae8cb7a}
      ::highlight(reader-note-active-green){background:#bbdfbf;color:#2d4430}
      ::highlight(reader-notes-purple){background:#dfcff17a}
      ::highlight(reader-note-active-purple){background:#d5c1ee;color:#3e3151}
      .reader-speaking{position:relative;isolation:isolate}
      .reader-speaking::before{content:"";position:absolute;inset:-8px -16px;z-index:-1;pointer-events:none;border-radius:23px;
        background:linear-gradient(125deg,#e5f3ffd9,#d4e9fcad);border:1px solid #eff9ff;box-shadow:inset 0 1px 2px #fff,0 5px 22px #6a9cc51a;animation:reader-glow .2s ease-out}
      @keyframes reader-glow{from{opacity:0}to{opacity:1}}
      @media(prefers-reduced-motion:reduce){.reader-speaking::before{animation:none}}
      blockquote{border-left:3px solid #dce5d7;margin:1.5em 0;padding:0 1.1em;color:#6b7563}
      pre{white-space:pre-wrap;background:#f7f8f4;padding:1em;font-size:.85em}
      table{max-width:100%;border-collapse:collapse;font-size:.9em}td,th{border:1px solid #dfe3d8;padding:.5em}
      .chapter-end{margin-top:65px;padding-top:20px;border-top:1px solid #e7e8e1;text-align:center;text-indent:0;font-size:12px;color:#9ba28f}
      @media(max-width:650px){article{padding:34px 28px 65px}}`;
  }
  function build(html, id, chapterPath, settings, isLast) {
    const doc = cleanDocument(html);
    for (const img of doc.querySelectorAll('img')) {
      const resource = resolve(chapterPath, img.getAttribute('src'));
      img.removeAttribute('src');
      if (resource) img.src = `epub://${id}/${resource.path.split('/').map(encodeURIComponent).join('/')}`;
      img.loading = 'eager';
    }
    for (const anchor of doc.querySelectorAll('a')) {
      const target = resolve(chapterPath, anchor.getAttribute('href'));
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      if (target) {
        anchor.href = '#';
        anchor.dataset.readerPath = target.path;
        anchor.dataset.readerFragment = target.fragment;
      }
    }
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src epub:; font-src app:; base-uri 'none'; form-action 'none'">
      <style>${styles(settings)}</style></head><body><article>${doc.body.innerHTML}
      <div class="chapter-end">${isLast ? '全书结束 · 感谢这段阅读时光' : '本章结束 · 可在右下角进入下一章'}</div>
      </article></body></html>`;
  }
  function cleanDocument(html) {
    const safe = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, USE_PROFILES: { html: true }, ADD_ATTR: ['epub:type'],
      FORBID_TAGS: ['script', 'style', 'link', 'meta', 'base', 'iframe', 'form', 'input', 'button',
        'object', 'embed', 'audio', 'video', 'source'],
      FORBID_ATTR: ['style', 'srcset', 'background', 'autofocus'], ALLOW_DATA_ATTR: false });
    return new DOMParser().parseFromString(safe, 'text/html');
  }
  function blocks(doc) {
    const article = doc.querySelector('article');
    const candidates = [...article.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,figure,img')];
    return candidates.length ? candidates : [...article.children];
  }
  function location(doc, chapter) {
    const win = doc.defaultView;
    const maximum = Math.max(0, doc.documentElement.scrollHeight - win.innerHeight);
    const candidates = blocks(doc);
    let index = candidates.findIndex(node => node.getBoundingClientRect().bottom > 24);
    if (index < 0) index = Math.max(0, candidates.length - 1);
    const rect = candidates[index]?.getBoundingClientRect();
    return { chapter, ratio: maximum ? Math.min(1, Math.max(0, win.scrollY / maximum)) : 1,
      block: index, offset: rect ? Math.min(1, Math.max(0, (24 - rect.top) / Math.max(1, rect.height))) : 0 };
  }
  function restore(doc, progress) {
    const win = doc.defaultView;
    if (progress.ratio === 0 && progress.block === 0 && progress.offset === 0) { win.scrollTo(0, 0); return; }
    const node = blocks(doc)[progress.block];
    if (node) {
      const rect = node.getBoundingClientRect();
      win.scrollTo(0, win.scrollY + rect.top + rect.height * progress.offset - 24);
    } else win.scrollTo(0, progress.ratio * Math.max(0, doc.documentElement.scrollHeight - win.innerHeight));
  }
  function matches(doc, query, limit = 200) {
    const needle = query.toLowerCase();
    const result = [];
    if (!needle) return result;
    blocks(doc).forEach((node, block) => {
      if (node.querySelector('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,figure')) return;
      const value = node.textContent;
      const lower = value.toLowerCase();
      let start = lower.indexOf(needle);
      while (start >= 0 && result.length < limit) {
        result.push({ block, start, excerpt: value.slice(Math.max(0, start - 30), start + query.length + 60).replace(/\s+/g, ' ').trim() });
        start = lower.indexOf(needle, start + needle.length);
      }
    });
    return result;
  }
  function search(html, query, limit) {
    const doc = cleanDocument(html);
    const article = doc.createElement('article');
    article.append(...doc.body.childNodes); doc.body.append(article);
    return matches(doc, query, limit);
  }
  function highlight(doc, query, target) {
    const ranges = [];
    const candidates = blocks(doc);
    let selected;
    for (const hit of matches(doc, query)) {
      const node = candidates[hit.block];
      const walker = doc.createTreeWalker(node, 4);
      const range = doc.createRange();
      let offset = 0;
      let begun = false;
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!begun && hit.start < offset + text.length) { range.setStart(text, hit.start - offset); begun = true; }
        if (begun && hit.start + query.length <= offset + text.length) {
          range.setEnd(text, hit.start + query.length - offset); ranges.push(range); break;
        }
        offset += text.length;
      }
      if (target && hit.block === target.block && hit.start === target.start) selected = range;
    }
    doc.defaultView.CSS.highlights.set('reader-search', new doc.defaultView.Highlight(...ranges));
    return selected;
  }
  function excerpt(doc, progress) { return (blocks(doc)[progress.block]?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180); }
  function selection(doc) {
    const selected = doc.getSelection(); if (!selected?.rangeCount || selected.isCollapsed) return null;
    const range = selected.getRangeAt(0); const article = doc.querySelector('article');
    if (!article?.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
    const prefix = doc.createRange(); prefix.selectNodeContents(article); prefix.setEnd(range.startContainer, range.startOffset);
    const raw = range.toString(); const quote = raw.trim();
    const start = prefix.toString().length + raw.indexOf(quote); const end = start + quote.length;
    const footer = article.querySelector('.chapter-end'); const limit = article.textContent.length - (footer?.textContent.length || 0);
    if (!quote || quote.length > 4000 || end > limit) return null;
    return { start, end, quote };
  }
  function annotationRange(doc, annotation) {
    const article = doc.querySelector('article');
    if (!article || article.textContent.slice(annotation.start, annotation.end) !== annotation.quote) return null;
    const walker = doc.createTreeWalker(article, doc.defaultView.NodeFilter.SHOW_TEXT); const range = doc.createRange(); let offset = 0; let begun = false;
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (!begun && annotation.start <= offset + text.length) { range.setStart(text, annotation.start - offset); begun = true; }
      if (begun && annotation.end <= offset + text.length) { range.setEnd(text, annotation.end - offset); return range; }
      offset += text.length;
    }
    return null;
  }
  function annotations(doc, values, chapter, activeId = null) {
    const colors = ['yellow', 'blue', 'green', 'purple'];
    const ranges = Object.fromEntries(colors.map(color => [color, []]));
    const active = Object.fromEntries(colors.map(color => [color, []]));
    for (const value of values || []) {
      if (value.chapter !== chapter || value.isExcerpt === false) continue;
      const range = annotationRange(doc, value); if (!range) continue;
      const color = colors.includes(value.color) ? value.color : 'yellow';
      ranges[color].push(range); if (value.id === activeId) active[color].push(range);
    }
    for (const color of colors) {
      const suffix = color === 'yellow' ? '' : `-${color}`;
      doc.defaultView.CSS.highlights.set(`reader-notes${suffix}`, new doc.defaultView.Highlight(...ranges[color]));
      doc.defaultView.CSS.highlights.set(`reader-note-active${suffix}`, new doc.defaultView.Highlight(...active[color]));
    }
  }
  return { build, styles, background, location, restore, resolve, search, highlight, excerpt, blocks, selection, annotationRange, annotations };
})();
