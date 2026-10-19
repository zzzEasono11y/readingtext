function epubPathFromArgs(args) {
  if (!Array.isArray(args)) return null;
  for (let index = args.length - 1; index >= 0; index--) {
    const value = args[index];
    if (typeof value !== 'string') continue;
    const filename = value.trim().replace(/^"|"$/g, '');
    if (filename && !filename.startsWith('-') && /\.epub$/i.test(filename)) return filename;
  }
  return null;
}

module.exports = { epubPathFromArgs };
