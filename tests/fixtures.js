const JSZip = require('jszip');
const PARAGRAPHS = [
  '清晨，窗边的光落在翻开的书页上。你不必急着读完，只要在这一刻，给自己留一点安静的时间。',
  '阅读像一条缓慢的小路。沿着句子向前走，会遇见新的风景，也会在熟悉的段落里重新认识自己。',
  '有时我们合上书，是为了看看窗外。有时我们重新打开书，是因为还记得某一句话留下的回声。',
  '这本小书是拾页阅读器的原创示例，用来体验目录、滚动阅读、调整排版和自动保存阅读位置。'
];
async function makeEpub(options = {}) {
  const zip = new JSZip();
  const count = options.count || 3;
  const prefix = 'OPS/';
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const chapters = Array.from({ length: count }, (_, index) => ({ id: `ch${index + 1}`, name: `chapters/第${index + 1}章.xhtml`, label: ['慢下来，翻开一页', '在文字里，遇见风景', '让阅读成为日常'][index] || `第 ${index + 1} 章` }));
  zip.file(`${prefix}book.opf`, `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="${options.epub2 ? '2.0' : '3.0'}" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${options.title || '给阅读留一点时间'}</dc:title><dc:creator>拾页</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="uid">readingtext-demo</dc:identifier>${options.fixed ? '<meta property="rendition:layout">pre-paginated</meta>' : ''}</metadata><manifest>${chapters.map(ch => `<item id="${ch.id}" href="${encodeURI(ch.name)}" media-type="application/xhtml+xml"/>`).join('')}<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="image" href="images/leaf.svg" media-type="image/svg+xml"/></manifest><spine toc="ncx">${chapters.map(ch => `<itemref idref="${ch.id}"/>`).join('')}</spine></package>`);
  const nav = chapters.map((ch, index) => `<li><a href="${encodeURI(ch.name)}${index === 1 ? '#p20' : ''}">${ch.label}</a>${index === 0 ? `<ol><li><a href="${encodeURI(ch.name)}#p10">留一点空白</a></li></ol>` : ''}</li>`).join('');
  if (options.cover) {
    const opf = await zip.file(`${prefix}book.opf`).async('string');
    zip.file(`${prefix}book.opf`, opf.replace('</manifest>', '<item id="cover" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/></manifest>'));
    zip.file(`${prefix}images/cover.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><defs><linearGradient id="paper" x2=".8" y2="1"><stop stop-color="#d7e2d6"/><stop offset="1" stop-color="#9daf9d"/></linearGradient></defs><rect width="400" height="600" fill="url(#paper)"/><rect x="22" y="22" width="356" height="556" rx="2" fill="none" stroke="#f4f6e9" opacity=".55"/><circle cx="293" cy="190" r="125" fill="#eff2df" opacity=".25"/><path d="M82 421 Q174 318 305 373 M144 374 Q113 321 168 274 Q205 344 144 374 M212 355 Q223 292 281 298 Q279 355 212 355" fill="none" stroke="#52745b" stroke-width="2" opacity=".65"/><g fill="#34533f" font-family="Microsoft YaHei, sans-serif"><text x="50" y="76" font-size="11" letter-spacing="5">READING TEXT</text><text x="50" y="174" font-size="34" letter-spacing="4">给阅读</text><text x="50" y="227" font-size="34" letter-spacing="4">留一点时间</text><text x="50" y="530" font-size="15" letter-spacing="5">拾页 · 原创示例</text></g></svg>`);
  }
  zip.file(`${prefix}nav.xhtml`, options.epub2 ? '<html><body></body></html>' : `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="landmarks"><ol><li><a href="nav.xhtml">目录</a></li></ol></nav><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`);
  zip.file(`${prefix}toc.ncx`, `<ncx><navMap>${chapters.map(ch => `<navPoint><navLabel><text>${ch.label}</text></navLabel><content src="${encodeURI(ch.name)}"/></navPoint>`).join('')}</navMap></ncx>`);
  zip.file(`${prefix}images/leaf.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="90" viewBox="0 0 360 90"><rect width="360" height="90" fill="#f1f4ed"/><path d="M150 60 Q160 14 210 24 Q200 70 150 60Z" fill="#a1b397"/><path d="M150 60 L195 34" stroke="#5f7c55" stroke-width="2"/></svg>');
  chapters.forEach((ch, index) => {
    const paragraphs = Array.from({ length: options.paragraphs || 65 }, (_, i) => `<p id="p${i}">第 ${i + 1} 段。${PARAGRAPHS[i % PARAGRAPHS.length]}${PARAGRAPHS[(i + 1) % PARAGRAPHS.length]}</p>`).join('');
    zip.file(prefix + ch.name, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${ch.label}</title></head><body><h1>${ch.label}</h1><p><em>慢慢读，也是一种抵达。</em></p><img src="../images/leaf.svg" alt="一片绿色的叶子"/><p><a href="#p20">跳到第二十一段</a>${index < count - 1 ? ` · <a href="${encodeURI(chapters[index + 1].name.split('/').pop())}#p20">看看下一章</a>` : ''}</p>${options.malicious ? '<script>window.bookScriptRan = true; window.reader.removeBook("bad");</script><img src="https://example.com/tracker.png" onerror="window.bookScriptRan=true"/><iframe src="file:///C:/Windows/win.ini"></iframe><a href="javascript:alert(1)">危险链接</a><form><input autofocus="autofocus"/></form><p style="background:url(https://example.com/track)">普通内容</p>' : ''}${paragraphs}</body></html>`);
  });
  if (options.drm) zip.file('META-INF/encryption.xml', '<encryption><EncryptedData><EncryptionMethod Algorithm="http://example.org/drm"/><CipherData><CipherReference URI="OPS/chapters/第1章.xhtml"/></CipherData></EncryptedData></encryption>');
  if (options.missing) zip.remove(prefix + chapters[0].name);
  if (options.brokenNav) zip.file(`${prefix}nav.xhtml`, '<broken');
  if (options.noToc) { zip.remove(`${prefix}nav.xhtml`); zip.remove(`${prefix}toc.ncx`); }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
module.exports = { makeEpub };
