const MAX_IMAGE_CHARS = 700000;
function ensureImageBudget(state, image = null, replaced = null) {
  const used = state.books.reduce((sum, book) => sum + (book.annotations || []).reduce((subtotal, item) => subtotal + (item.discussion || []).reduce((size, turn) => size + (turn.image?.dataUrl.length || 0), 0), 0), 0);
  if (used + (image?.dataUrl.length || 0) - (replaced?.dataUrl.length || 0) > 32 * 1024 * 1024) throw new Error('截图总量已达本版上限，请先备份并清理不需要的截图讨论。');
}

function validateImage(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 16 || image.height < 16 || image.width > 1600 || image.height > 1600
    || typeof image.dataUrl !== 'string' || image.dataUrl.length > MAX_IMAGE_CHARS
    || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl)) throw new Error('截图无效或过大，请重新截取较小区域。');
  const bytes = Buffer.from(image.dataUrl.split(',')[1], 'base64');
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('截图格式无效。');
  let dimensions = false;
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 255) break;
    const marker = bytes[offset + 1]; const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if ([192, 193, 194].includes(marker)) {
      dimensions = length >= 8 && bytes.readUInt16BE(offset + 5) === image.height && bytes.readUInt16BE(offset + 7) === image.width; break;
    }
    offset += length + 2;
  }
  if (!dimensions) throw new Error('截图尺寸无效，请重新截取。');
  return { dataUrl: image.dataUrl, width: image.width, height: image.height };
}

function validateSources(sources, annotation) {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('讨论引用数据无效。');
  for (const source of sources) {
    if (!annotation || annotation.kind === 'image' || typeof source?.quote !== 'string' || !source.quote.trim() || source.quote.length > 600
      || source.chapter !== annotation.chapter || !Number.isInteger(source.start) || source.start < annotation.start
      || source.end !== source.start + source.quote.length || source.end > annotation.end
      || annotation.quote.slice(source.start - annotation.start, source.end - annotation.start) !== source.quote) throw new Error('讨论引用未匹配原文。');
  }
  return sources;
}

function extractSources(answer, annotation) {
  const sources = [];
  answer = answer.replace(/【原文：([\s\S]*?)】/g, (_, quote) => {
    const offset = annotation.kind === 'image' ? -1 : annotation.quote.indexOf(quote);
    if (!quote.trim() || quote.length > 600 || offset < 0) return '[引文未匹配]';
    let index = sources.findIndex(source => source.quote === quote);
    if (index < 0) {
      if (sources.length >= 8) return '[引用数量超限]';
      index = sources.length; sources.push({ chapter: annotation.chapter, start: annotation.start + offset, end: annotation.start + offset + quote.length, quote });
    }
    return `[原文 ${index + 1}]`;
  });
  return { answer, sources };
}

function imageMessage(text, image) {
  return image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } }] : text;
}

module.exports = { validateImage, validateSources, extractSources, imageMessage, ensureImageBudget, MAX_IMAGE_CHARS };
