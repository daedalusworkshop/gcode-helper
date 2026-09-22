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

function renderPlot() {
  hoveredPathIndex = -1;
  const states = stateAt();
  const gridStep = Math.max(.01, num($('#gridStep').value) || 1);
  const S = 560, pad = 56, scale = (S - pad * 2) / SIZE;
  const sx = x => pad + clamp(x) * scale;
  const sy = y => S - pad - clamp(y) * scale;
  let svg = `<rect width="${S}" height="${S}" fill="#fbfaf6"/>`;
  for (let i = 0, n = 0; i <= SIZE + gridStep / 100 && n < 100; i += gridStep, n++) {
    const v = Number(i.toFixed(6));
    svg += `<line x1="${sx(v)}" y1="${pad}" x2="${sx(v)}" y2="${S - pad}" stroke="#ddd9d0" stroke-width="1"/><text x="${sx(v)}" y="${S - pad + 22}" text-anchor="middle" font-size="12" fill="#77736b" font-family="monospace">${fmt(v)}</text>`;
    svg += `<line x1="${pad}" y1="${sy(v)}" x2="${S - pad}" y2="${sy(v)}" stroke="#ddd9d0" stroke-width="1"/><text x="${pad - 14}" y="${sy(v) + 4}" text-anchor="middle" font-size="12" fill="#77736b" font-family="monospace">${fmt(v)}</text>`;
  }
  let prev = { x: 0, y: 0 };
  let length = 0;
  const activeIndex = activeBlockIndex();
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
        const r = radius * scale;
        geometry = `<path d="M ${sx(prev.x)} ${sy(prev.y)} A ${r} ${r} 0 ${large} ${sweep} ${sx(p.x)} ${sy(p.y)}"`;
        const minor = 2 * Math.asin(Math.min(1, dist / (2 * radius)));
        length += radius * (large ? 2 * Math.PI - minor : minor);
      } else {
        geometry = `<line x1="${sx(prev.x)}" y1="${sy(prev.y)}" x2="${sx(p.x)}" y2="${sy(p.y)}"`;
        length += dist;
      }
      svg += `<g class="path-group" data-index="${i}">${geometry} class="path-hit"/>${geometry} class="path-visible" stroke="${stroke}" stroke-width="${strokeWidth}" ${fade} stroke-linecap="round"/></g>`;
    }
    if (i === activeIndex) svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="7" fill="#fbfaf6" stroke="#e14b32" stroke-width="3"/><circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="#e14b32"/>`;
    prev = p;
  });
  svg += `<path d="M${sx(0) - 7} ${sy(0)}h14M${sx(0)} ${sy(0) - 7}v14" stroke="#1b1b19" stroke-width="2"/>`;
  plot.innerHTML = svg;
  showReadout(states[activeIndex >= 0 ? activeIndex : selected]);
  $('#pathLength').textContent = !codeValid ? '' : `${length.toFixed(1)} ${$('#unitsSelect').value === 'G20' ? 'in' : 'mm'}`;
  plot.querySelectorAll('.path-group').forEach(group => {
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
editor.addEventListener('keydown', onCodeKeydown);
editor.addEventListener('scroll', syncCodeScroll);
editor.addEventListener('focus', refreshActive);
editor.addEventListener('blur', () => { normalizeEditor(true); refreshActive(); });
editor.addEventListener('keyup', refreshActive);
editor.addEventListener('click', refreshActive);
document.addEventListener('selectionchange', () => { if (editorHasFocus()) refreshActive(); });
$('#unitsSelect').addEventListener('change', e => patchModal(/(^|\s)G(?:20|21)(?=\s|$)/, e.target.value));
$('#modeSelect').addEventListener('change', e => patchModal(/(^|\s)G(?:90|91)(?=\s|$)/, e.target.value));
$('#safeZ').addEventListener('input', applyCodeInput);
$('#gridStep').addEventListener('input', renderPlot);
$('#sideToggle').addEventListener('click', () => {
  const collapsed = $('#side').classList.toggle('collapsed');
  $('#sideToggle').setAttribute('aria-expanded', String(!collapsed));
});
$('#copyButton').addEventListener('click', async () => { await navigator.clipboard.writeText(currentCodeText()); toast('Copied'); });
$('#exportButton').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([currentCodeText() + '\n'], { type: 'text/plain' }));
  a.download = 'program.nc';
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
