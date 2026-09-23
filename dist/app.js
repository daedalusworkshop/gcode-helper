const initialBlocks = [
  { type: 'rapid', x: 0, y: 0, z: .25 },
  { type: 'rapid', x: 1, y: 1 },
  { type: 'linear', z: 0, f: 50 },
  { type: 'linear', y: 5 },
  { type: 'linear', x: 5 },
  { type: 'linear', y: 1 },
  { type: 'linear', x: 1 },
  { type: 'rapid', z: .25 },
  { type: 'rapid', x: 0, y: 0 }
];

const SIZE = 6;
let blocks = [];
let selected = -1;
let running = false;
let codeValid = true;
let codeError = null;
let codeLineMap = [];
let hoveredPathIndex = -1;
let lastActiveIndex = -1;
const commandFields = {
  G0: ['X', 'Y', 'Z'],
  G1: ['X', 'Y', 'Z', 'F'],
  G2: ['X', 'Y', 'Z', 'R', 'F'],
  G3: ['X', 'Y', 'Z', 'R', 'F']
};
const typeCode = { rapid: 'G0', linear: 'G1', 'arc-cw': 'G2', 'arc-ccw': 'G3' };

const $ = (s) => document.querySelector(s);
const editor = $('#codeEditor');
const plot = $('#plot');

// The SVG-to-world mapping is fixed (viewBox is constant), so these live outside renderPlot.
const PLOT_S = 560, PLOT_PAD = 56, PLOT_SCALE = (PLOT_S - PLOT_PAD * 2) / SIZE;
function worldToScreenX(x) { return PLOT_PAD + x * PLOT_SCALE; }
function worldToScreenY(y) { return PLOT_S - PLOT_PAD - y * PLOT_SCALE; }

// Persistent SVG children: the reference photo sits behind the grid and paths, which are rebuilt
// on every render. Keeping the photo out of that innerHTML churn means dragging it never has to
// re-encode the image data.
const SVG_NS = 'http://www.w3.org/2000/svg';
const refImgEl = document.createElementNS(SVG_NS, 'image');
refImgEl.setAttribute('id', 'refImgEl');
refImgEl.setAttribute('preserveAspectRatio', 'none');
refImgEl.setAttribute('opacity', '0');
const plotBg = document.createElementNS(SVG_NS, 'g');
const plotPaths = document.createElementNS(SVG_NS, 'g');
plot.append(refImgEl, plotBg, plotPaths);
let refImage = null; // { src, natW, natH, x, y, w, opacity }

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmt(v) { return Number(v).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); }
function clamp(v) { return Math.min(SIZE, Math.max(0, v)); }

function stateAt() {
  const pos = { x: 0, y: 0, z: num($('#safeZ').value) };
  return blocks.map((b, index) => {
    const incremental = (b.mode ?? $('#modeSelect').value) === 'G91';
    ['x','y','z'].forEach(k => {
      if (b[k] !== undefined) pos[k] = incremental ? pos[k] + num(b[k]) : num(b[k]);
    });
    return { ...pos, type: b.type, r: b.r, index };
  });
}

function programText(list) {
  const lines = [`G54 G17 ${$('#unitsSelect').value} ${$('#modeSelect').value}`];
  list.forEach(b => {
    const parts = [typeCode[b.type]];
    ['x','y','z','r','f'].forEach(k => { if (b[k] !== undefined) parts.push(k.toUpperCase() + fmt(b[k])); });
    lines.push(parts.join(' '));
  });
  return lines.join('\n');
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function currentEditorLine() {
  return editor.value.slice(0, editor.selectionStart).split(/\r?\n/).length - 1;
}

function editorHasFocus() { return document.activeElement === editor; }

function activeBlockIndex() {
  if (running) return selected;
  return editorHasFocus() ? codeLineMap.indexOf(currentEditorLine()) : hoveredPathIndex;
}

function guidedContext() {
  if (!editorHasFocus()) return null;
  const caret = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const nextBreak = editor.value.indexOf('\n', caret);
  const lineEnd = nextBreak === -1 ? editor.value.length : nextBreak;
  const line = editor.value.slice(lineStart, lineEnd);
  const beforeCaret = editor.value.slice(lineStart, caret);
  const commandMatch = line.toUpperCase().match(/^\s*G0?([0-3])(?=\s|$)/);
  if (!commandMatch) return null;
  const command = `G${commandMatch[1]}`;
  const present = new Set([...line.toUpperCase().matchAll(/([XYZFR])(?=\s|[-+.0-9]|$)/g)].map(match => match[1]));
  const remaining = commandFields[command].filter(field => !present.has(field));
  return {
    lineIndex: editor.value.slice(0, lineStart).split(/\r?\n/).length - 1,
    lineStart, lineEnd, line, beforeCaret,
    command, remaining, nextField: remaining[0]
  };
}

function renderCodeHighlight(activeBlock = activeBlockIndex()) {
  const activeLine = editorHasFocus() ? currentEditorLine() : codeLineMap[activeBlock];
  const lines = editor.value.split(/\r?\n/);
  const guide = guidedContext();
  $('#codeHighlight').innerHTML = lines.map((line, i) => {
    const ghostText = guide && i === guide.lineIndex && guide.remaining.length ? (/\s$/.test(line) ? '' : ' ') + guide.remaining.join(' ') : '';
    const ghost = ghostText ? `<span class="code-ghost">${escapeHtml(ghostText)}</span>` : '';
    let body = escapeHtml(line);
    if (codeError && codeError.line === i) {
      const start = Math.min(codeError.start, line.length), end = Math.min(codeError.end, line.length);
      body = `${escapeHtml(line.slice(0, start))}<span class="code-error">${escapeHtml(line.slice(start, end))}</span>${escapeHtml(line.slice(end))}`;
    }
    return `<span class="code-source-line ${i === activeLine ? 'active' : ''}">${body || ' '}${ghost}</span>`;
  }).join('');
  syncCodeScroll();
  if (vimEnabled) updateVimCursor(); // innerHTML above just tore out any previous cursor node; re-add it
}

function syncCodeScroll() {
  $('#codeHighlight').scrollTop = editor.scrollTop;
  $('#codeHighlight').scrollLeft = editor.scrollLeft;
}

function showError(message) {
  const status = $('#codeStatus');
  status.textContent = message;
  status.hidden = !message;
}

// Errors carry the character range to underline in the editor.
function fail(message, line, span) {
  return { error: { message, line, start: span[0], end: span[1] } };
}

// Exact decimal for writing a value back into the code (no float noise, no trailing zeros).
function numStr(v) { return String(Number(Number(v).toFixed(6))); }

// X/Y/Z/F/R words. A word with no number, or with a lone "-", is a skip: it keeps the current value.
const WORD = /(?<![A-Za-z])([XYZFR])(?:[ \t]*(-?(?:\d+(?:\.\d*)?|\.\d+))|[ \t]*-(?![\d.]))?/gi;
const MOTION_TYPES = ['rapid', 'linear', 'arc-cw', 'arc-ccw'];

function tokenize(masked) {
  return [...masked.matchAll(WORD)].map(m => ({
    key: m[1].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
    value: m[2] === undefined ? null : num(m[2])
  }));
}

// Walks the program once, tracking the modal state (position, feed, distance mode) a skipped word falls back on.
function analyze(text) {
  const rawLines = text.split('\n');
  let units = $('#unitsSelect').value;
  let mode = $('#modeSelect').value;
  const pos = { x: 0, y: 0, z: num($('#safeZ').value) };
  let feed = null;
  let error = null;
  const infos = [];
  for (let i = 0; i < rawLines.length; i++) {
    // Comments become spaces so offsets still line up with the raw text.
    const masked = rawLines[i].replace(/\([^)]*\)/g, m => ' '.repeat(m.length)).replace(/;.*/, m => ' '.repeat(m.length));
    const clean = masked.trim().toUpperCase();
    const info = { index: i, masked, kind: 'blank' };
    infos.push(info);
    if (!clean) continue;
    info.span = [Math.max(0, masked.search(/\S/)), masked.trimEnd().length];
    if (/(^|\s)G20(?=\s|$)/.test(clean)) units = 'G20';
    if (/(^|\s)G21(?=\s|$)/.test(clean)) units = 'G21';
    if (/(^|\s)G90(?=\s|$)/.test(clean)) mode = 'G90';
    if (/(^|\s)G91(?=\s|$)/.test(clean)) mode = 'G91';
    const motion = clean.match(/(?:^|\s)G0?([0-3])(?![\d.])/);
    const isSetup = /(^|\s)G(?:17|18|19|20|21|54|55|56|57|58|59|90|91)(?=\s|$)/.test(clean);
    if (!motion) {
      info.kind = isSetup ? 'setup' : 'bad';
      if (!isSetup && !error) error = fail(`line ${i + 1} · expected G0–G3`, i, info.span);
      continue;
    }
    info.kind = 'motion';
    info.type = MOTION_TYPES[Number(motion[1])];
    info.mode = mode;
    info.tokens = tokenize(masked);
    info.posBefore = { ...pos };
    info.feedBefore = feed;
    info.last = {};
    info.tokens.forEach(t => { if (t.value !== null) info.last[t.key] = t; });
    for (const k of ['x', 'y', 'z']) {
      if (info.last[k]) pos[k] = mode === 'G91' ? pos[k] + info.last[k].value : info.last[k].value;
    }
    if (info.last.f) feed = info.last.f.value;
    info.posAfter = { ...pos };
  }
  return { infos, units, mode, error };
}

// The value a skipped word stands for, as text. null when there is nothing to keep.
function resolveWord(info, key) {
  if (key === 'x' || key === 'y' || key === 'z') return info.mode === 'G91' ? '0' : numStr(info.posBefore[key]);
  if (key === 'f') return info.feedBefore === null ? null : numStr(info.feedBefore);
  if (key === 'r' && (info.type === 'arc-cw' || info.type === 'arc-ccw')) {
    const chord = Math.hypot(info.posAfter.x - info.posBefore.x, info.posAfter.y - info.posBefore.y);
    return chord > 1e-9 ? numStr(Math.ceil(chord / 2 * 1e4) / 1e4) : null;
  }
  return null;
}

// Rewrites every skipped word ("Z -", a bare "X") as the value it stands for.
// While the user is typing, the word under the caret is left alone: "X-" may still become "X-5".
function normalizeText(text, caret, keepTyping) {
  const { infos } = analyze(text);
  const before = text.slice(0, caret);
  const caretLine = before.split('\n').length - 1;
  const caretCol = caret - (before.lastIndexOf('\n') + 1);
  const edits = [];
  let lineStart = 0;
  for (const info of infos) {
    const start0 = lineStart;
    lineStart += info.masked.length + 1;
    if (info.kind !== 'motion') continue;
    for (const t of info.tokens) {
      if (t.value !== null) continue;
      if (keepTyping && info.index === caretLine) {
        const tail = info.masked.slice(t.end);
        const lastWord = tail.trim() === '';
        const trailing = tail.length - tail.trimStart().length;
        if (lastWord || (caretCol >= t.start && caretCol <= t.end + trailing)) continue;
      }
      // "X - X5": the later number wins, so the skip just goes away.
      const superseded = info.tokens.some(o => o.key === t.key && o.value !== null);
      const value = superseded ? null : resolveWord(info, t.key);
      let start = start0 + t.start;
      if (value === null) while (start > start0 && /[ \t]/.test(text[start - 1])) start--;
      edits.push({ start, end: start0 + t.end, text: value === null ? '' : t.key.toUpperCase() + value });
    }
  }
  if (!edits.length) return { text, caret, changed: false };
  let out = '';
  let cursor = 0;
  let shift = 0;
  let newCaret = null;
  for (const e of edits) {
    out += text.slice(cursor, e.start) + e.text;
    cursor = e.end;
    if (e.end <= caret) shift += e.text.length - (e.end - e.start);
    else if (e.start < caret && newCaret === null) newCaret = out.length;
  }
  out += text.slice(cursor);
  return { text: out, caret: newCaret ?? caret + shift, changed: true };
}

function parseCode(text) {
  const { infos, units, mode, error } = analyze(text);
  if (error) return error;
  // Tool height runs from the safe height (in the air) down to 0 (cutting); outside that range is an error.
  const safeZ = num($('#safeZ').value);
  const EPS = 1e-9;
  const parsed = [];
  const lineMap = [];
  for (const info of infos) {
    if (info.kind !== 'motion') continue;
    const at = k => (info.last[k] ? [info.last[k].start, info.last[k].end] : info.span);
    for (const k of ['x', 'y']) {
      const v = info.posAfter[k];
      if (v < -EPS || v > SIZE + EPS) return fail(`line ${info.index + 1} · ${k.toUpperCase()} ${fmt(v)} outside ${SIZE} × ${SIZE}`, info.index, at(k));
    }
    const z = info.posAfter.z;
    if (z < -EPS || z > safeZ + EPS) return fail(`line ${info.index + 1} · Z ${fmt(z)} must be from 0 to ${fmt(safeZ)}`, info.index, at('z'));
    const block = { type: info.type, mode: info.mode };
    for (const [k, t] of Object.entries(info.last)) block[k] = t.value;
    parsed.push(block);
    lineMap.push(info.index);
  }
  return { blocks: parsed, units, mode, lineMap };
}

function applyCodeInput() {
  const result = parseCode(editor.value);
  if (result.error) {
    // Nothing is drawn until the code is fixed.
    codeValid = false;
    codeError = result.error;
    blocks = [];
    codeLineMap = [];
    selected = -1;
    showError(result.error.message);
    renderPlot();
    renderCodeHighlight();
    return;
  }
  codeValid = true;
  codeError = null;
  showError('');
  blocks = result.blocks;
  codeLineMap = result.lineMap;
  selected = blocks.length - 1;
  $('#unitsSelect').value = result.units;
  $('#modeSelect').value = result.mode;
  renderPlot();
  renderCodeHighlight();
}

// The rectangle a reference photo occupies, in world (inch/mm) units. Its height follows the
// photo's own aspect ratio, so only width is a stored setting.
function refImageWorldRect() {
  const h = refImage.w * refImage.natH / refImage.natW;
  return { x: refImage.x, y: refImage.y, w: refImage.w, h };
}

// Pushes refImage's current position/size/opacity onto the persistent <image> node. Cheap: no
// innerHTML rebuild, and the (possibly large) blob URL is only re-set when it actually changes.
function syncRefImage() {
  if (!refImage) { refImgEl.setAttribute('opacity', '0'); refImgEl.removeAttribute('href'); return; }
  const r = refImageWorldRect();
  if (refImgEl.getAttribute('href') !== refImage.src) {
    refImgEl.setAttribute('href', refImage.src);
    refImgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', refImage.src); // older SVG image renderers still look for this
  }
  refImgEl.setAttribute('x', worldToScreenX(r.x));
  refImgEl.setAttribute('y', worldToScreenY(r.y + r.h));
  refImgEl.setAttribute('width', r.w * PLOT_SCALE);
  refImgEl.setAttribute('height', r.h * PLOT_SCALE);
  refImgEl.setAttribute('opacity', refImage.opacity / 100);
}

function syncRefControls() {
  if (!refImage) return;
  $('#refOpacity').value = refImage.opacity;
  $('#refOpacityVal').textContent = refImage.opacity + '%';
  $('#refX').value = fmt(refImage.x);
  $('#refY').value = fmt(refImage.y);
  $('#refW').value = fmt(refImage.w);
}

function importRefFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (refImage) URL.revokeObjectURL(refImage.src);
    const natW = img.naturalWidth, natH = img.naturalHeight;
    // Default to a reasonable size centered on the grid; the user drags or types to place it.
    let w = SIZE * 0.6, h = w * natH / natW;
    if (h > SIZE * 0.9) { h = SIZE * 0.9; w = h * natW / natH; }
    refImage = { src: url, natW, natH, x: (SIZE - w) / 2, y: (SIZE - h) / 2, w, opacity: 50 };
    $('#refControls').hidden = false;
    syncRefControls();
    syncRefImage();
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('Could not load image'); };
  img.src = url;
}

function removeRefImage() {
  if (!refImage) return;
  URL.revokeObjectURL(refImage.src);
  refImage = null;
  $('#refControls').hidden = true;
  syncRefImage();
}

let refDrag = null;
refImgEl.addEventListener('pointerdown', e => {
  if (!refImage) return;
  e.preventDefault();
  refImgEl.setPointerCapture(e.pointerId);
  refDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: refImage.x, originY: refImage.y };
});
refImgEl.addEventListener('pointermove', e => {
  if (!refDrag || refDrag.pointerId !== e.pointerId || !refImage) return;
  const box = plot.getBoundingClientRect();
  const pxPerUnit = (box.width / PLOT_S) * PLOT_SCALE;
  if (pxPerUnit <= 0) return;
  refImage.x = refDrag.originX + (e.clientX - refDrag.startX) / pxPerUnit;
  refImage.y = refDrag.originY - (e.clientY - refDrag.startY) / pxPerUnit; // screen down = world down
  syncRefImage();
  syncRefControls();
});
const endRefDrag = e => { if (refDrag && refDrag.pointerId === e.pointerId) refDrag = null; };
refImgEl.addEventListener('pointerup', endRefDrag);
refImgEl.addEventListener('pointercancel', endRefDrag);

function renderPlot() {
  hoveredPathIndex = -1;
  syncRefImage();
  const states = stateAt();
  const gridStep = Math.max(.01, num($('#gridStep').value) || 1);
  const sx = x => worldToScreenX(clamp(x));
  const sy = y => worldToScreenY(clamp(y));
  let bg = '';
  for (let i = 0, n = 0; i <= SIZE + gridStep / 100 && n < 100; i += gridStep, n++) {
    const v = Number(i.toFixed(6));
    bg += `<line x1="${sx(v)}" y1="${PLOT_PAD}" x2="${sx(v)}" y2="${PLOT_S - PLOT_PAD}" stroke="#ddd9d0" stroke-width="1"/><text x="${sx(v)}" y="${PLOT_S - PLOT_PAD + 22}" text-anchor="middle" font-size="12" fill="#77736b" font-family="monospace">${fmt(v)}</text>`;
    bg += `<line x1="${PLOT_PAD}" y1="${sy(v)}" x2="${PLOT_S - PLOT_PAD}" y2="${sy(v)}" stroke="#ddd9d0" stroke-width="1"/><text x="${PLOT_PAD - 14}" y="${sy(v) + 4}" text-anchor="middle" font-size="12" fill="#77736b" font-family="monospace">${fmt(v)}</text>`;
  }
  plotBg.innerHTML = bg;
  let prev = { x: 0, y: 0 };
  let length = 0;
  const activeIndex = activeBlockIndex();
  let paths = '';
  states.forEach((p, i) => {
    if (p.x !== prev.x || p.y !== prev.y) {
      // Z0 is a full-strength cut. At safe Z it is a thin blue line. In between the cut fades in
      // proportion to how far up the tool is, from 25% just under safe Z up to 100% at Z0.
      const safeZ = num($('#safeZ').value);
      const atCut = Math.abs(p.z) < 1e-9;
      const inAir = !atCut && Math.abs(p.z - safeZ) < 1e-9;
      const opacity = atCut ? 1 : inAir ? 1 : .25 + .75 * (1 - p.z / safeZ);
      const active = i === activeIndex;
      const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
      const stroke = active ? '#e14b32' : inAir ? '#6d86b4' : '#1b1b19';
      const strokeWidth = active ? 5 : inAir ? 2 : 3;
      const fade = `stroke-opacity="${active ? 1 : opacity.toFixed(3)}"`;
      let geometry;
      if (p.type === 'arc-cw' || p.type === 'arc-ccw') {
        const radius = Math.max(Math.abs(num(p.r)) || dist / 2, dist / 2);
        const large = num(p.r) < 0 ? 1 : 0;
        const sweep = p.type === 'arc-cw' ? 1 : 0;
        const r = radius * PLOT_SCALE;
        geometry = `<path d="M ${sx(prev.x)} ${sy(prev.y)} A ${r} ${r} 0 ${large} ${sweep} ${sx(p.x)} ${sy(p.y)}"`;
        const minor = 2 * Math.asin(Math.min(1, dist / (2 * radius)));
        length += radius * (large ? 2 * Math.PI - minor : minor);
      } else {
        geometry = `<line x1="${sx(prev.x)}" y1="${sy(prev.y)}" x2="${sx(p.x)}" y2="${sy(p.y)}"`;
        length += dist;
      }
      paths += `<g class="path-group" data-index="${i}">${geometry} class="path-hit"/>${geometry} class="path-visible" stroke="${stroke}" stroke-width="${strokeWidth}" ${fade} stroke-linecap="round"/></g>`;
    }
    if (i === activeIndex) paths += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="7" fill="#fbfaf6" stroke="#e14b32" stroke-width="3"/><circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="#e14b32"/>`;
    prev = p;
  });
  paths += `<path d="M${sx(0) - 7} ${sy(0)}h14M${sx(0)} ${sy(0) - 7}v14" stroke="#1b1b19" stroke-width="2"/>`;
  plotPaths.innerHTML = paths;
  showReadout(states[activeIndex >= 0 ? activeIndex : selected]);
  $('#pathLength').textContent = !codeValid ? '' : `${length.toFixed(1)} ${$('#unitsSelect').value === 'G20' ? 'in' : 'mm'}`;
  plotPaths.querySelectorAll('.path-group').forEach(group => {
    const index = Number(group.dataset.index);
    group.addEventListener('mouseenter', () => {
      if (editorHasFocus() || running) return;
      hoveredPathIndex = index;
      group.classList.add('hovered');
      renderCodeHighlight(index);
      showReadout(states[index]);
    });
    group.addEventListener('mouseleave', () => {
      if (hoveredPathIndex !== index) return;
      hoveredPathIndex = -1;
      group.classList.remove('hovered');
      renderCodeHighlight();
      showReadout(states[selected]);
    });
  });
}

function showReadout(point) {
  if (!codeValid) { $('#cursorReadout').textContent = ''; $('#zReadout').textContent = ''; return; }
  const p = point || { x: 0, y: 0, z: num($('#safeZ').value) };
  $('#cursorReadout').textContent = `X ${num(p.x).toFixed(2)}  Y ${num(p.y).toFixed(2)}`;
  $('#zReadout').textContent = `Z ${num(p.z).toFixed(2)}`;
}

function insertAtEditor(text, start, end) {
  editor.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    editor.setRangeText(text, start, end, 'end');
    applyCodeInput();
  }
}

// ---------- Vim mode ----------
// A modal editor layered on top of the plain textarea. Off by default (the sidebar "Vim" toggle
// flips it on); when off, none of this runs and the editor behaves exactly as before.
let vimEnabled = false;
let vimMode = 'normal'; // 'normal' | 'insert' | 'visual' | 'visual-line'
let vimCaretPos = 0;
let vimAnchor = 0;
let vimDesiredCol = 0;
let vimCount = '';
let vimPendingOp = null; // 'd' | 'c' | 'y'
let vimOpCount = '';
let vimPendingG = false;
let vimRegister = { text: '', linewise: false };

function vimCharClass(ch) {
  if (ch === undefined || /\s/.test(ch)) return 0;
  if (/[A-Za-z0-9_]/.test(ch)) return 1;
  return 2;
}

function vimLineBounds(text, pos) {
  const start = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const nl = text.indexOf('\n', pos);
  const end = nl === -1 ? text.length : nl;
  return { start, end };
}

function vimFirstNonBlank(text, pos) {
  const { start, end } = vimLineBounds(text, pos);
  let i = start;
  while (i < end && /[ \t]/.test(text[i])) i++;
  return i < end ? i : start;
}

function vimLineIndex(text, pos) { return text.slice(0, pos).split('\n').length - 1; }
function vimLineStartOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
  return offsets;
}

function vimMoveVertical(text, pos, delta, desiredCol) {
  const offsets = vimLineStartOffsets(text);
  const li = vimLineIndex(text, pos);
  const target = Math.min(offsets.length - 1, Math.max(0, li + delta));
  const { start, end } = vimLineBounds(text, offsets[target]);
  const maxCol = Math.max(0, end - start - 1); // Normal mode never sits on/past the line's newline
  const col = desiredCol === Infinity ? maxCol : Math.min(desiredCol, maxCol);
  return start + col;
}

// w: start of the next word, skipping the rest of the current one and any blanks.
function vimWordForward(text, pos, count) {
  for (let n = 0; n < count; n++) {
    let i = pos;
    const cls = vimCharClass(text[i]);
    if (cls !== 0) while (i < text.length && vimCharClass(text[i]) === cls) i++;
    while (i < text.length && vimCharClass(text[i]) === 0) i++;
    pos = i;
  }
  return Math.min(pos, text.length);
}

// b: start of the previous word.
function vimWordBackward(text, pos, count) {
  for (let n = 0; n < count; n++) {
    let i = pos;
    if (i > 0) i--;
    while (i > 0 && vimCharClass(text[i]) === 0) i--;
    const cls = vimCharClass(text[i]);
    while (i > 0 && vimCharClass(text[i - 1]) === cls) i--;
    pos = i;
  }
  return Math.max(0, pos);
}

// e: end of the current/next word.
function vimWordEnd(text, pos, count) {
  for (let n = 0; n < count; n++) {
    let i = pos + 1;
    if (i >= text.length) { pos = text.length - 1; continue; }
    while (i < text.length && vimCharClass(text[i]) === 0) i++;
    if (i >= text.length) { pos = text.length - 1; continue; }
    const cls = vimCharClass(text[i]);
    while (i + 1 < text.length && vimCharClass(text[i + 1]) === cls) i++;
    pos = i;
  }
  return Math.max(0, Math.min(pos, text.length - 1));
}

// Motions shared by bare cursor movement and operator-pending resolution (d/c/y + motion).
// `linewise` marks j/k/gg/G as whole-line motions when used with an operator; `inclusive`
// marks motions (e, $) whose target character is itself part of the range.
function vimMotion(text, key, count) {
  switch (key) {
    case 'h': { const { start } = vimLineBounds(text, vimCaretPos); return { pos: Math.max(start, vimCaretPos - count) }; }
    case 'l': { const { end } = vimLineBounds(text, vimCaretPos); return { pos: Math.min(end, vimCaretPos + count) }; } // exclusive end (needed so dl/cl/yl can reach the last char); bare motion clamps separately below
    case 'j': return { pos: vimMoveVertical(text, vimCaretPos, count, vimDesiredCol), linewise: true, vertical: true };
    case 'k': return { pos: vimMoveVertical(text, vimCaretPos, -count, vimDesiredCol), linewise: true, vertical: true };
    case '0': return { pos: vimLineBounds(text, vimCaretPos).start };
    case '^': return { pos: vimFirstNonBlank(text, vimCaretPos) };
    case '$': { const { start, end } = vimLineBounds(text, vimCaretPos); return { pos: Math.max(start, end - 1), inclusive: true, toEnd: true }; }
    case 'w': return { pos: vimWordForward(text, vimCaretPos, count) };
    case 'b': return { pos: vimWordBackward(text, vimCaretPos, count) };
    case 'e': return { pos: vimWordEnd(text, vimCaretPos, count), inclusive: true };
    case 'G': { const offsets = vimLineStartOffsets(text); const li = count > 1 || vimCount ? Math.min(offsets.length - 1, count - 1) : offsets.length - 1; return { pos: vimFirstNonBlank(text, offsets[li]), linewise: true }; }
  }
  return null;
}

function vimSetRegister(text, linewise) { vimRegister = { text, linewise }; }

// Deletes/changes/yanks a plain character range [start, end). Shared by x/D/C/s and every
// charwise operator+motion combo.
function vimApplyCharwiseOperator(op, start, end) {
  if (end < start) [start, end] = [end, start];
  const text = editor.value;
  const region = text.slice(start, end);
  vimSetRegister(region, false);
  if (op === 'y') { vimCaretPos = start; return; }
  insertAtEditor('', start, end);
  vimCaretPos = start;
  if (op === 'c') vimEnterInsert();
}

// Deletes whole lines fromLine..toLine (inclusive), absorbing whichever newline keeps the file
// from gaining a phantom blank line at the end.
function vimDeleteLines(fromLine, toLine) {
  const text = editor.value;
  const offsets = vimLineStartOffsets(text);
  const lo = Math.max(0, Math.min(fromLine, toLine, offsets.length - 1));
  const hi = Math.min(offsets.length - 1, Math.max(fromLine, toLine));
  const naturalEnd = hi + 1 < offsets.length ? offsets[hi + 1] : text.length;
  let start = offsets[lo], end = naturalEnd;
  if (hi === offsets.length - 1 && lo > 0) start = offsets[lo] - 1;
  let content = text.slice(offsets[lo], naturalEnd);
  vimSetRegister(content.endsWith('\n') ? content : content + '\n', true);
  insertAtEditor('', start, end);
  const newOffsets = vimLineStartOffsets(editor.value);
  const landLine = Math.min(lo, newOffsets.length - 1);
  vimCaretPos = vimFirstNonBlank(editor.value, newOffsets[landLine]);
}

function vimYankLines(fromLine, toLine) {
  const text = editor.value;
  const offsets = vimLineStartOffsets(text);
  const lo = Math.max(0, Math.min(fromLine, toLine, offsets.length - 1));
  const hi = Math.min(offsets.length - 1, Math.max(fromLine, toLine));
  const start = offsets[lo], end = hi + 1 < offsets.length ? offsets[hi + 1] : text.length;
  let content = text.slice(start, end);
  if (!content.endsWith('\n')) content += '\n';
  vimSetRegister(content, true);
  vimCaretPos = vimFirstNonBlank(text, start);
}

// Clears the content of fromLine..toLine down to a single empty line, then drops into Insert.
function vimChangeLines(fromLine, toLine) {
  const text = editor.value;
  const offsets = vimLineStartOffsets(text);
  const lo = Math.max(0, Math.min(fromLine, toLine, offsets.length - 1));
  const hi = Math.min(offsets.length - 1, Math.max(fromLine, toLine));
  const start = offsets[lo];
  const naturalEnd = hi + 1 < offsets.length ? offsets[hi + 1] : text.length;
  const end = hi + 1 < offsets.length ? naturalEnd - 1 : naturalEnd;
  let content = text.slice(start, naturalEnd);
  vimSetRegister(content.endsWith('\n') ? content : content + '\n', true);
  insertAtEditor('', start, end);
  vimCaretPos = start;
  vimEnterInsert();
}

function vimPaste(before) {
  if (!vimRegister.text) return;
  const text = editor.value;
  if (vimRegister.linewise) {
    const { start, end } = vimLineBounds(text, vimCaretPos);
    let pos = before ? start : (end < text.length ? end + 1 : text.length);
    let content = vimRegister.text;
    if (!before && end === text.length) content = (text.length && !text.endsWith('\n') ? '\n' : '') + content.replace(/\n$/, '');
    insertAtEditor(content, pos, pos);
    vimCaretPos = vimFirstNonBlank(editor.value, pos + (content.startsWith('\n') ? 1 : 0));
  } else {
    const pos = before ? vimCaretPos : Math.min(vimCaretPos + 1, text.length);
    insertAtEditor(vimRegister.text, pos, pos);
    vimCaretPos = pos;
  }
}

// Normal/Visual mode never rests the caret on a line's own newline (only Insert mode can);
// operations that delete a line's trailing content can otherwise leave it there.
function vimClampToLine(pos) {
  pos = Math.max(0, Math.min(pos, editor.value.length));
  const b = vimLineBounds(editor.value, pos);
  return Math.min(pos, Math.max(b.start, b.end - 1));
}

function vimEnterInsert() {
  vimMode = 'insert';
  editor.style.caretColor = ''; // real thin caret is back; the block cursor below is Normal/Visual-only
  editor.setSelectionRange(vimCaretPos, vimCaretPos);
  updateVimUI();
}

function vimEnterNormal(pos) {
  vimMode = 'normal';
  editor.style.caretColor = 'transparent'; // the block cursor overlay stands in for it
  if (pos !== undefined) vimCaretPos = pos;
  vimCaretPos = vimClampToLine(vimCaretPos);
  editor.setSelectionRange(vimCaretPos, vimCaretPos);
  vimPendingOp = null; vimOpCount = ''; vimCount = ''; vimPendingG = false;
  updateVimUI();
}

function vimEnterVisual(linewise) {
  vimMode = linewise ? 'visual-line' : 'visual';
  editor.style.caretColor = 'transparent';
  vimAnchor = vimCaretPos;
  vimApplySelection();
  updateVimUI();
}

// Reflects vimCaretPos/vimAnchor onto the real textarea selection so the browser's native
// selection paint (already styled to match the app's signal color) does the visual work.
function vimApplySelection() {
  const text = editor.value;
  const dir = vimCaretPos < vimAnchor ? 'backward' : 'forward';
  if (vimMode === 'visual-line') {
    const a = vimLineBounds(text, Math.min(vimAnchor, vimCaretPos)).start;
    const b = vimLineBounds(text, Math.max(vimAnchor, vimCaretPos)).end;
    editor.setSelectionRange(a, b, dir);
  } else if (vimMode === 'visual') {
    const lo = Math.min(vimAnchor, vimCaretPos), hi = Math.max(vimAnchor, vimCaretPos);
    editor.setSelectionRange(lo, Math.min(hi + 1, text.length), dir); // inclusive of the char under the caret
  } else {
    editor.setSelectionRange(vimCaretPos, vimCaretPos);
  }
}

function vimMoveDone() {
  vimCaretPos = vimClampToLine(vimCaretPos);
  if (vimMode === 'visual' || vimMode === 'visual-line') vimApplySelection();
  else editor.setSelectionRange(vimCaretPos, vimCaretPos);
  updateVimUI();
}

// Applies a pending operator (d/c/y) to a resolved motion's target.
function vimFinishOperator(op, motion) {
  const text = editor.value;
  if (motion.linewise) {
    const li = vimLineIndex(text, vimCaretPos);
    const targetLi = vimLineIndex(text, motion.pos);
    if (op === 'd') vimDeleteLines(li, targetLi);
    else if (op === 'y') vimYankLines(li, targetLi);
    else if (op === 'c') vimChangeLines(li, targetLi);
  } else {
    let lo = Math.min(vimCaretPos, motion.pos), hi = Math.max(vimCaretPos, motion.pos);
    if (motion.inclusive) hi += 1;
    vimApplyCharwiseOperator(op, lo, Math.min(hi, text.length));
  }
  if (op !== 'c') vimMoveDone();
}

function updateVimUI() {
  renderPlot();
  renderCodeHighlight();
  const badge = $('#vimMode');
  if (badge) {
    badge.hidden = !vimEnabled;
    badge.textContent = vimMode === 'visual-line' ? 'V-LINE' : vimMode.toUpperCase();
  }
}

// Locates the on-screen rectangle of the character at `pos`, by walking the already-rendered
// #codeHighlight markup (which mirrors editor.value exactly) rather than re-measuring text.
function caretRectInHighlight(pos) {
  const host = $('#codeHighlight');
  const text = editor.value;
  const before = text.slice(0, pos);
  const lineIdx = before.split('\n').length - 1;
  const lineEl = host.children[lineIdx];
  if (!lineEl) return null;
  const col = pos - (before.lastIndexOf('\n') + 1);
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement && n.parentElement.classList.contains('code-ghost')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  let remaining = col, node, targetNode = null, targetOffset = 0;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (remaining <= len) { targetNode = node; targetOffset = remaining; break; }
    remaining -= len;
  }
  const hostRect = host.getBoundingClientRect();
  let rect;
  if (targetNode) {
    const range = document.createRange();
    const endOffset = Math.min(targetOffset + 1, targetNode.nodeValue.length);
    range.setStart(targetNode, targetOffset);
    range.setEnd(targetNode, endOffset);
    rect = range.getBoundingClientRect();
    if (!rect.width) { range.setEnd(targetNode, targetOffset); rect = range.getBoundingClientRect(); }
  } else {
    const lineRect = lineEl.getBoundingClientRect();
    rect = { left: lineRect.right, top: lineRect.top, width: 0, height: lineRect.height };
  }
  return { left: rect.left - hostRect.left + host.scrollLeft, top: rect.top - hostRect.top + host.scrollTop, width: rect.width || 8, height: rect.height || 20 };
}

function updateVimCursor() {
  const host = $('#codeHighlight');
  let cursorEl = document.getElementById('vimCursor');
  if (!vimEnabled || vimMode === 'insert' || !editorHasFocus()) { if (cursorEl) cursorEl.remove(); return; }
  const rect = caretRectInHighlight(vimCaretPos);
  if (!rect) { if (cursorEl) cursorEl.remove(); return; }
  if (!cursorEl) { cursorEl = document.createElement('div'); cursorEl.id = 'vimCursor'; cursorEl.className = 'vim-cursor'; }
  cursorEl.style.left = rect.left + 'px';
  cursorEl.style.top = rect.top + 'px';
  cursorEl.style.width = rect.width + 'px';
  cursorEl.style.height = rect.height + 'px';
  host.appendChild(cursorEl); // re-append last so it paints above the freshly rebuilt text spans
}

function vimKeydown(e) {
  if (!vimEnabled) return;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if (vimMode !== 'insert' && e.ctrlKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); document.execCommand('redo'); }
    return; // leave every other modifier combo (copy/paste/undo/redo/select-all) to the browser
  }
  if (vimMode === 'insert') {
    if (e.key === 'Escape') {
      e.preventDefault();
      const pos = Math.max(vimLineBounds(editor.value, editor.selectionStart).start, editor.selectionStart - 1);
      vimEnterNormal(pos);
    }
    return;
  }

  e.preventDefault();
  const text = editor.value;
  const key = e.key;

  if (key === 'Escape') {
    if (vimMode === 'visual' || vimMode === 'visual-line') vimEnterNormal(Math.min(vimAnchor, vimCaretPos));
    else { vimPendingOp = null; vimOpCount = ''; vimCount = ''; vimPendingG = false; }
    return;
  }

  // Digits build a count; a leading "0" is the line-start motion instead.
  if (/^[0-9]$/.test(key) && !(key === '0' && (vimPendingOp ? vimOpCount === '' : vimCount === ''))) {
    if (vimPendingOp) vimOpCount += key; else vimCount += key;
    return;
  }

  const outerCount = Math.max(1, parseInt(vimCount || '1', 10));
  const opCount = Math.max(1, parseInt(vimOpCount || '1', 10));
  const count = vimPendingOp ? outerCount * opCount : outerCount;

  if (vimPendingG) {
    vimPendingG = false;
    if (key === 'g') {
      const offsets = vimLineStartOffsets(text);
      const li = vimCount ? Math.min(offsets.length - 1, parseInt(vimCount, 10) - 1) : 0;
      const pos = vimFirstNonBlank(text, offsets[li]);
      if (vimPendingOp) { const op = vimPendingOp; vimPendingOp = null; vimOpCount = ''; vimCount = ''; vimFinishOperator(op, { pos, linewise: true }); }
      else { vimCaretPos = pos; vimDesiredCol = vimCaretPos - offsets[li]; vimCount = ''; vimMoveDone(); }
    } else { vimPendingOp = null; vimOpCount = ''; vimCount = ''; }
    return;
  }
  if (key === 'g') { vimPendingG = true; return; }

  if (!vimPendingOp && (vimMode === 'normal') && (key === 'd' || key === 'c' || key === 'y')) {
    vimPendingOp = key; vimOpCount = '';
    return;
  }
  if (vimPendingOp && key === vimPendingOp) {
    const op = vimPendingOp;
    const li = vimLineIndex(text, vimCaretPos);
    const target = li + (count - 1);
    vimPendingOp = null; vimOpCount = ''; vimCount = '';
    if (op === 'd') { vimDeleteLines(li, target); vimMoveDone(); }
    else if (op === 'y') { vimYankLines(li, target); vimMoveDone(); }
    else if (op === 'c') vimChangeLines(li, target);
    return;
  }

  if (vimMode === 'visual' || vimMode === 'visual-line') {
    if (key === 'v') { if (vimMode === 'visual') vimEnterNormal(vimCaretPos); else { vimMode = 'visual'; vimApplySelection(); updateVimUI(); } return; }
    if (key === 'V') { if (vimMode === 'visual-line') vimEnterNormal(vimCaretPos); else { vimMode = 'visual-line'; vimApplySelection(); updateVimUI(); } return; }
    if (key === 'd' || key === 'x') {
      if (vimMode === 'visual-line') vimDeleteLines(vimLineIndex(text, vimAnchor), vimLineIndex(text, vimCaretPos));
      else { const lo = Math.min(vimAnchor, vimCaretPos), hi = Math.max(vimAnchor, vimCaretPos) + 1; vimApplyCharwiseOperator('d', lo, Math.min(hi, text.length)); }
      vimEnterNormal(vimCaretPos); return;
    }
    if (key === 'y') {
      if (vimMode === 'visual-line') vimYankLines(vimLineIndex(text, vimAnchor), vimLineIndex(text, vimCaretPos));
      else { const lo = Math.min(vimAnchor, vimCaretPos), hi = Math.max(vimAnchor, vimCaretPos) + 1; vimApplyCharwiseOperator('y', lo, Math.min(hi, text.length)); }
      vimEnterNormal(vimCaretPos); return;
    }
    if (key === 'c') {
      if (vimMode === 'visual-line') vimChangeLines(vimLineIndex(text, vimAnchor), vimLineIndex(text, vimCaretPos));
      else { const lo = Math.min(vimAnchor, vimCaretPos), hi = Math.max(vimAnchor, vimCaretPos) + 1; vimApplyCharwiseOperator('c', lo, Math.min(hi, text.length)); }
      return;
    }
  }

  const motion = vimMotion(text, key, count);
  if (motion) {
    if (vimPendingOp) {
      const op = vimPendingOp; vimPendingOp = null; vimOpCount = ''; vimCount = '';
      vimFinishOperator(op, motion);
      return;
    }
    vimCaretPos = motion.pos;
    // A bare 'l' (no operator) must stop on the last character, not the exclusive end used for dl/cl/yl.
    if (key === 'l') { const b = vimLineBounds(text, vimCaretPos); vimCaretPos = Math.min(vimCaretPos, Math.max(b.start, b.end - 1)); }
    if (key === '$') vimDesiredCol = Infinity;
    else if (!motion.vertical) vimDesiredCol = vimCaretPos - vimLineBounds(text, vimCaretPos).start;
    vimCount = '';
    vimMoveDone();
    return;
  }

  if (vimPendingOp) { vimPendingOp = null; vimOpCount = ''; vimCount = ''; return; }

  switch (key) {
    case 'i': vimEnterInsert(); break;
    case 'I': vimCaretPos = vimFirstNonBlank(text, vimCaretPos); vimEnterInsert(); break;
    case 'a': vimCaretPos = Math.min(vimLineBounds(text, vimCaretPos).end, vimCaretPos + 1); vimEnterInsert(); break;
    case 'A': vimCaretPos = vimLineBounds(text, vimCaretPos).end; vimEnterInsert(); break;
    case 'o': { const { end } = vimLineBounds(text, vimCaretPos); insertAtEditor('\n', end, end); vimCaretPos = end + 1; vimEnterInsert(); break; }
    case 'O': { const { start } = vimLineBounds(text, vimCaretPos); insertAtEditor('\n', start, start); vimCaretPos = start; vimEnterInsert(); break; }
    case 'x': { const { end } = vimLineBounds(text, vimCaretPos); vimApplyCharwiseOperator('d', vimCaretPos, Math.min(end, vimCaretPos + count)); vimMoveDone(); break; }
    case 'X': { const { start } = vimLineBounds(text, vimCaretPos); vimApplyCharwiseOperator('d', Math.max(start, vimCaretPos - count), vimCaretPos); vimMoveDone(); break; }
    case 'D': { const { end } = vimLineBounds(text, vimCaretPos); vimApplyCharwiseOperator('d', vimCaretPos, end); vimMoveDone(); break; }
    case 'C': { const { end } = vimLineBounds(text, vimCaretPos); vimApplyCharwiseOperator('c', vimCaretPos, end); break; }
    case 's': { const { end } = vimLineBounds(text, vimCaretPos); vimApplyCharwiseOperator('c', vimCaretPos, Math.min(end, vimCaretPos + count)); break; }
    case 'Y': { const li = vimLineIndex(text, vimCaretPos); vimYankLines(li, li + count - 1); vimMoveDone(); break; }
    case 'p': vimPaste(false); vimMoveDone(); break;
    case 'P': vimPaste(true); vimMoveDone(); break;
    case 'v': vimEnterVisual(false); break;
    case 'V': vimEnterVisual(true); break;
    case 'u': document.execCommand('undo'); break;
    case '~': {
      const { end } = vimLineBounds(text, vimCaretPos);
      if (vimCaretPos < end) {
        const ch = text[vimCaretPos];
        const swapped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
        insertAtEditor(swapped, vimCaretPos, vimCaretPos + 1);
        vimCaretPos = Math.min(end, vimCaretPos + 1);
      }
      vimMoveDone();
      break;
    }
    default: vimCount = ''; return;
  }
  vimCount = '';
}

let normalizing = false;

// Writes resolved skips back into the editor. Returns true when the text changed.
function normalizeEditor(force = false) {
  const result = normalizeText(editor.value, editor.selectionStart, !force && editorHasFocus());
  if (!result.changed) return false;
  const scroll = editor.scrollTop;
  normalizing = true;
  editor.setSelectionRange(0, editor.value.length);
  if (!(editorHasFocus() && document.execCommand('insertText', false, result.text))) editor.value = result.text;
  editor.setSelectionRange(result.caret, result.caret);
  editor.scrollTop = scroll;
  normalizing = false;
  applyCodeInput();
  return true;
}

// A bare number typed after G0-G3 fills the next empty parameter (X, Y, Z...).
function onCodeInput(e) {
  if (normalizing) return;
  // Vim commands mutate the text through this same 'input' event (insertAtEditor -> execCommand),
  // but they're discrete edits, not mid-typing — skip the number-autofill heuristic, just reparse.
  if (vimEnabled && vimMode !== 'insert') { if (!normalizeEditor(true)) applyCodeInput(); return; }
  const guide = guidedContext();
  if (guide && guide.nextField && e.inputType?.startsWith('insert')) {
    const caret = editor.selectionStart;
    const atTokenEnd = caret === guide.lineEnd || /\s/.test(editor.value[caret]);
    const token = guide.beforeCaret.match(/(?:^|\s)(-?\d*\.?\d*)$/);
    if (token && token[1] && atTokenEnd) {
      const before = guide.beforeCaret.slice(0, guide.beforeCaret.length - token[1].length).trimEnd();
      // "G0 X 5": the number belongs to the label the user already typed.
      if (before && !/[XYZFR]$/i.test(before)) {
        insertAtEditor(guide.nextField + token[1], caret - token[1].length, caret);
        return;
      }
    }
  }
  const pasted = e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop';
  if (!normalizeEditor(pasted)) applyCodeInput();
}

// Tab moves to the next letter: "G0 X5⇥" -> "G0 X5 Y".
// Tab on an empty letter skips it by writing the value it keeps: "G0 X5 Y⇥" -> "G0 X5 Y2 Z".
function onCodeKeydown(e) {
  if (vimEnabled && vimMode !== 'insert') return; // vimKeydown owns the keyboard outside Insert mode
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const guide = guidedContext();
  if (!guide) return;
  const empty = guide.beforeCaret.match(/(?:^|\s)([XYZFR])[ \t]*$/i);
  if (!empty && !guide.nextField) return;
  e.preventDefault();
  const caret = editor.selectionStart;
  if (empty) {
    const key = empty[1].toLowerCase();
    const info = analyze(editor.value).infos[guide.lineIndex];
    const value = info.kind === 'motion' ? resolveWord(info, key) : null;
    const lead = empty[0].length - empty[0].trimStart().length;
    const filled = value === null ? '' : key.toUpperCase() + value;
    const next = guide.nextField || '';
    insertAtEditor(filled + (filled && next ? ' ' : '') + next, caret - (empty[0].length - lead), editor.selectionEnd);
  } else {
    const prefix = /\s$/.test(guide.beforeCaret) ? '' : ' ';
    insertAtEditor(prefix + guide.nextField, caret, editor.selectionEnd);
  }
}

function refreshActive() {
  if (editorHasFocus()) normalizeEditor();
  const index = activeBlockIndex();
  if (index !== lastActiveIndex) { lastActiveIndex = index; renderPlot(); }
  renderCodeHighlight();
}

// Units / distance selects rewrite the matching code in the text instead of regenerating it.
function patchModal(pattern, code) {
  const global = new RegExp(pattern.source, 'gi');
  editor.value = pattern.test(editor.value)
    ? editor.value.replace(global, (_, lead) => lead + code)
    : `${code}\n${editor.value}`;
  applyCodeInput();
}

function toast(message) { const t = $('#toast'); t.textContent = message; t.classList.add('show'); clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 1600); }
function currentCodeText() { return editor.value.trim(); }

editor.addEventListener('input', onCodeInput);
editor.addEventListener('keydown', vimKeydown); // registered first: owns the keyboard in Normal/Visual mode
editor.addEventListener('keydown', onCodeKeydown);
editor.addEventListener('scroll', syncCodeScroll);
editor.addEventListener('focus', refreshActive);
editor.addEventListener('blur', () => { normalizeEditor(true); refreshActive(); });
editor.addEventListener('keyup', refreshActive);
editor.addEventListener('click', refreshActive);
editor.addEventListener('mouseup', () => {
  // A mouse click/drag moves the real selection outside vim's own control; resync to it.
  if (vimEnabled && vimMode !== 'insert') vimEnterNormal(editor.selectionStart);
});
$('#vimToggle').addEventListener('change', e => {
  vimEnabled = e.target.checked;
  try { localStorage.setItem('gcodeHelperVim', vimEnabled ? '1' : '0'); } catch {}
  if (vimEnabled) vimEnterNormal(editor.selectionStart);
  else { const cur = document.getElementById('vimCursor'); if (cur) cur.remove(); $('#vimMode').hidden = true; editor.style.caretColor = ''; renderCodeHighlight(); }
});
try { if (localStorage.getItem('gcodeHelperVim') === '1') { vimEnabled = true; $('#vimToggle').checked = true; } } catch {}
document.addEventListener('selectionchange', () => { if (editorHasFocus()) refreshActive(); });
$('#unitsSelect').addEventListener('change', e => patchModal(/(^|\s)G(?:20|21)(?=\s|$)/, e.target.value));
$('#modeSelect').addEventListener('change', e => patchModal(/(^|\s)G(?:90|91)(?=\s|$)/, e.target.value));
$('#safeZ').addEventListener('input', applyCodeInput);
$('#gridStep').addEventListener('input', renderPlot);
$('#refImportBtn').addEventListener('click', () => $('#refFile').click());
$('#refFile').addEventListener('change', e => { importRefFile(e.target.files[0]); e.target.value = ''; });
$('#refOpacity').addEventListener('input', e => { if (!refImage) return; refImage.opacity = Number(e.target.value); $('#refOpacityVal').textContent = refImage.opacity + '%'; syncRefImage(); });
$('#refX').addEventListener('input', e => { if (!refImage) return; refImage.x = num(e.target.value); syncRefImage(); });
$('#refY').addEventListener('input', e => { if (!refImage) return; refImage.y = num(e.target.value); syncRefImage(); });
$('#refW').addEventListener('input', e => { if (!refImage) return; refImage.w = Math.max(0.1, num(e.target.value)); syncRefImage(); });
$('#refRemoveBtn').addEventListener('click', removeRefImage);
$('#sideToggle').addEventListener('click', () => {
  const collapsed = $('#side').classList.toggle('collapsed');
  $('#sideToggle').setAttribute('aria-expanded', String(!collapsed));
});
$('#copyButton').addEventListener('click', async () => { await navigator.clipboard.writeText(currentCodeText()); toast('Copied'); });
$('#exportButton').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([currentCodeText() + '\n'], { type: 'text/plain' }));
  a.download = 'program.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#newButton').addEventListener('click', () => { editor.value = programText([]); applyCodeInput(); editor.focus(); });
$('#playButton').addEventListener('click', async () => {
  if (running) { running = false; return; }
  if (!codeValid || !blocks.length) return;
  running = true;
  editor.blur();
  $('#playButton').textContent = 'Stop';
  for (let i = 0; i < blocks.length && running; i++) {
    selected = i;
    renderPlot();
    renderCodeHighlight();
    await new Promise(r => setTimeout(r, 360));
  }
  running = false;
  selected = blocks.length - 1;
  $('#playButton').textContent = 'Run';
  renderPlot();
  renderCodeHighlight();
});

editor.value = programText(initialBlocks);
applyCodeInput();
