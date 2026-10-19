const path = require('node:path');
const JSZip = require('jszip');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const MAX_FILE = 100 * 1024 * 1024;
const MAX_RESOURCE = 32 * 1024 * 1024;
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  return Object.entries(value).filter(([key]) => !key.startsWith('@_'))
    .map(([, item]) => list(item).map(text).join(' ')).join(' ').trim();
};

function parseXml(source) {
  if (source.length > 2 * 1024 * 1024 || /<!ENTITY/i.test(source)) {
    throw new Error('电子书的 XML 内容过大或包含不支持的实体声明。');
  }
  if (XMLValidator.validate(source) !== true) throw new Error('电子书的 XML 结构损坏。');
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
    parseTagValue: false, parseAttributeValue: false }).parse(source);
}

function resolveHref(base, href) {
  if (typeof href !== 'string' || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
    throw new Error('不支持电子书中的外部资源。');
  }
  const [rawPath, ...hash] = href.split('#');
  let decoded;
  let fragment;
  try {
    decoded = decodeURIComponent(rawPath.split('?')[0]);
    fragment = decodeURIComponent(hash.join('#'));
  } catch { throw new Error('电子书中的文件路径无效。'); }
  if (decoded.includes('\\') || decoded.includes('\0')) throw new Error('电子书中的文件路径无效。');
  const resolved = decoded ? path.posix.normalize(decoded.startsWith('/')
    ? decoded.slice(1) : path.posix.join(path.posix.dirname(base), decoded)) : base;
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    throw new Error('电子书中的文件路径超出了书籍范围。');
  }
  return { path: resolved, fragment };
}

async function readResource(zip, name, type = 'string', max = MAX_RESOURCE) {
  const entry = zip.file(name);
  if (!entry) throw new Error(`电子书缺少文件：${name}`);
  // JSZip exposes the central-directory sizes before decompression.
  if (entry._data.uncompressedSize > max) throw new Error('电子书中的单个文件过大。');
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    const stream = entry.internalStream(type);
    stream.on('data', chunk => {
      length += chunk.length;
      if (length > max) { stream.pause(); reject(new Error('电子书中的单个文件过大。')); return; }
      chunks.push(chunk);
    }).on('error', () => reject(new Error(`电子书中的文件损坏：${name}`)))
      .on('end', () => resolve(type === 'string' ? chunks.join('') : Buffer.concat(chunks)))
      .resume();
  });
}

function navEntries(node, base, depth = 0, result = []) {
  for (const li of list(node?.li)) {
    const anchor = list(li.a)[0];
    if (anchor?.['@_href']) {
      try { result.push({ label: text(anchor) || '未命名章节', depth,
        ...resolveHref(base, anchor['@_href']) }); } catch { /* Skip external TOC links. */ }
    }
    for (const ol of list(li.ol)) navEntries(ol, base, depth + 1, result);
  }
  return result;
}

function ncxEntries(nodes, base, depth = 0, result = []) {
  for (const node of list(nodes)) {
    const href = node.content?.['@_src'];
    if (href) {
      try { result.push({ label: text(node.navLabel?.text) || '未命名章节', depth,
        ...resolveHref(base, href) }); } catch { /* Skip external TOC links. */ }
    }
    ncxEntries(node.navPoint, base, depth + 1, result);
  }
  return result;
}

function findNavs(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'nav') found.push(...list(value));
    else if (!key.startsWith('@_')) for (const item of list(value)) findNavs(item, found);
  }
  return found;
}

async function parseEpub(buffer) {
  if (buffer.length > MAX_FILE) throw new Error('第一版支持 100 MB 以内的 EPUB 文件。');
  let zip;
  try { zip = await JSZip.loadAsync(buffer); }
  catch { throw new Error('无法打开这本书，请确认它是完整的 EPUB 文件。'); }
  const entries = Object.values(zip.files);
  if (entries.length > 15000 || entries.reduce((sum, item) => sum + (item._data?.uncompressedSize || 0), 0) > 600 * 1024 * 1024) {
    throw new Error('电子书解压后的内容过大。');
  }
  const container = parseXml(await readResource(zip, 'META-INF/container.xml', 'string', 2 * 1024 * 1024));
  const root = list(container.container?.rootfiles?.rootfile)
    .find(item => item['@_media-type'] === 'application/oebps-package+xml')
    || list(container.container?.rootfiles?.rootfile)[0];
  if (!root?.['@_full-path']) throw new Error('电子书缺少内容清单。');
  const opfPath = resolveHref('container.xml', root['@_full-path']).path;
  const pkg = parseXml(await readResource(zip, opfPath, 'string', 2 * 1024 * 1024)).package;
  if (!pkg?.manifest || !pkg?.spine) throw new Error('电子书缺少章节信息。');
  const metadata = pkg.metadata || {};
  const metas = list(metadata.meta);
  if (metas.some(meta => meta['@_property'] === 'rendition:layout' && text(meta) === 'pre-paginated')) {
    throw new Error('第一版暂不支持固定版式 EPUB，请导入普通文字排版的电子书。');
  }
  const manifest = list(pkg.manifest.item).map(item => ({
    id: item['@_id'], ...resolveHref(opfPath, item['@_href']),
    mediaType: item['@_media-type'], properties: (item['@_properties'] || '').split(/\s+/)
  }));
  const byId = new Map(manifest.map(item => [item.id, item]));
  const chapters = list(pkg.spine.itemref).filter(ref => ref['@_linear'] !== 'no').map(ref => {
    const item = byId.get(ref['@_idref']);
    if (!item || !['application/xhtml+xml', 'text/html'].includes(item.mediaType) || !zip.file(item.path)) {
      throw new Error('电子书的章节缺失或格式不受支持。');
    }
    return { path: item.path, label: '' };
  });
  if (!chapters.length) throw new Error('这本书没有可阅读的章节。');
  if (zip.file('META-INF/encryption.xml')) {
    const encryption = parseXml(await readResource(zip, 'META-INF/encryption.xml'));
    const encrypted = list(encryption.encryption?.EncryptedData);
    const fontAlgorithms = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];
    if (!encrypted.length || encrypted.some(item => !fontAlgorithms.includes(item.EncryptionMethod?.['@_Algorithm']))) {
      throw new Error('第一版暂不支持有 DRM 加密保护的 EPUB。');
    }
    const protectedChapters = encrypted.some(item => {
      const uri = item.CipherData?.CipherReference?.['@_URI'];
      return uri && chapters.some(chapter => chapter.path === resolveHref('encryption.xml', uri).path);
    });
    if (protectedChapters) throw new Error('第一版暂不支持有 DRM 加密保护的 EPUB。');
  }
  let toc = [];
  const nav = manifest.find(item => item.properties.includes('nav'));
  const ncx = byId.get(pkg.spine['@_toc']) || manifest.find(item => item.mediaType === 'application/x-dtbncx+xml');
  try {
    if (nav) {
      const navs = findNavs(parseXml(await readResource(zip, nav.path, 'string', 2 * 1024 * 1024)));
      const tocNav = navs.find(item => (item['@_type'] || '').split(/\s+/).includes('toc'));
      if (tocNav) for (const ol of list(tocNav.ol)) toc.push(...navEntries(ol, nav.path));
    }
  } catch { /* A broken TOC should not prevent reading the spine. */ }
  if (!toc.length && ncx) {
    try { toc = ncxEntries(parseXml(await readResource(zip, ncx.path)).ncx?.navMap?.navPoint, ncx.path); }
    catch { /* Fall back to the spine if both navigation documents are broken. */ }
  }
  toc = toc.map(item => ({ ...item, chapter: chapters.findIndex(chapter => chapter.path === item.path) }))
    .filter(item => item.chapter >= 0);
  chapters.forEach((chapter, index) => {
    chapter.label = toc.find(item => item.path === chapter.path)?.label || `第 ${index + 1} 节`;
  });
  if (!toc.length) toc = chapters.map((chapter, index) => ({ ...chapter, chapter: index, depth: 0, fragment: '' }));
  const legacyCover = metas.find(meta => meta['@_name'] === 'cover')?.['@_content'];
  const coverItem = manifest.find(item => item.properties.includes('cover-image')) || byId.get(legacyCover);
  let cover = null;
  if (coverItem?.mediaType?.startsWith('image/') && zip.file(coverItem.path)) {
    try {
      const bytes = await readResource(zip, coverItem.path, 'nodebuffer', 4 * 1024 * 1024);
      cover = `data:${coverItem.mediaType};base64,${bytes.toString('base64')}`;
    } catch { /* Use the generated cover when an embedded image is invalid. */ }
  }
  return { zip, manifest, chapters, toc, cover,
    title: text(list(metadata.title)[0]) || '未命名书籍',
    author: list(metadata.creator).map(text).filter(Boolean).join(' / ') || '未知作者' };
}

module.exports = { parseEpub, resolveHref, readResource, MAX_FILE };
