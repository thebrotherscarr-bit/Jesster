/**
 * The right-click menu. Electron gives a window none of its own, so without
 * this nothing happens on right-click: copy a selection, cut and paste in a
 * text box, copy a link, fix a misspelled word.
 */

/** The menu for one right-click, from Electron's context-menu params. */
function template(params, { openLink } = {}) {
  const p = params || {};
  const f = p.editFlags || {};
  const items = [];
  if (p.misspelledWord) {
    for (const w of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: w, action: 'replace', word: w });
    if (!items.length) items.push({ label: 'No suggestions', enabled: false });
    items.push({ type: 'separator' });
  }
  if (p.linkURL) {
    items.push({ label: 'Copy link', action: 'copyLink' });
    if (openLink && /^https?:/i.test(p.linkURL)) items.push({ label: 'Open link in browser', action: 'openLink' });
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ label: 'Cut', role: 'cut', enabled: Boolean(f.canCut) });
    items.push({ label: 'Copy', role: 'copy', enabled: Boolean(f.canCopy) });
    items.push({ label: 'Paste', role: 'paste', enabled: Boolean(f.canPaste) });
    items.push({ type: 'separator' });
    items.push({ label: 'Select all', role: 'selectAll' });
  } else if (p.selectionText && p.selectionText.trim()) {
    items.push({ label: 'Copy', role: 'copy' });
  } else {
    items.push({ label: 'Select all', role: 'selectAll' });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  return items;
}

/** Give a window the menu. `electron` is passed in so this file loads in tests. */
function attach(win, { Menu, clipboard, shell }) {
  const wc = win.webContents;
  wc.on('context-menu', (_event, params) => {
    const items = template(params, { openLink: true }).map(({ action, word, ...item }) => {
      if (action === 'replace') item.click = () => wc.replaceMisspelling(word);
      if (action === 'copyLink') item.click = () => clipboard.writeText(params.linkURL);
      if (action === 'openLink') item.click = () => shell.openExternal(params.linkURL);
      return item;
    });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

module.exports = { template, attach };
