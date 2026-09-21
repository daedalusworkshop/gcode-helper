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

let blocks = structuredClone(initialBlocks);
let selected = 4;
let running = false;
let editorMode = 'blocks';
let codeValid = true;

const $ = (s) => document.querySelector(s);
const blockList = $('#blockList');
const plot = $('#plot');
const typeMeta = {
  rapid: { code: 'G0', label: 'RAPID', cls: 'rapid' },
  linear: { code: 'G1', label: 'LINEAR', cls: 'linear' },
  'arc-cw': { code: 'G2', label: 'ARC CW', cls: 'arc' },
  'arc-ccw': { code: 'G3', label: 'ARC CCW', cls: 'arc' }
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmt(v) { return Number(v).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); }
function stateAt(index) {
  const pos = { x: 0, y: 0, z: num($('#safeZ').value) };
  const states = [];
  blocks.forEach((b, i) => {
    const incremental = $('#modeSelect').value === 'G91';
    ['x','y','z'].forEach(k => {
      if (b[k] !== undefined) pos[k] = incremental ? pos[k] + num(b[k]) : num(b[k]);
    });
    states.push({ ...pos, type: b.type, index: i });
  });
  return index === undefined ? states : states[index];
}

function renderBlocks() {
  blockList.innerHTML = blocks.map((b, i) => {
    const meta = typeMeta[b.type];
    const fields = ['x','y','z'].map(k => `<label class="field"><span>${k.toUpperCase()}</span><input data-key="${k}" type="number" step="0.25" value="${b[k] ?? ''}" placeholder="—" aria-label="${k.toUpperCase()} coordinate"></label>`).join('');
    const extra = b.type === 'linear' ? `<label class="field"><span>F</span><input data-key="f" type="number" min="1" value="${b.f ?? ''}" placeholder="—" aria-label="Feed rate"></label>` : b.type.startsWith('arc') ? `<label class="field"><span>R</span><input data-key="r" type="number" step="0.25" value="${b.r ?? 1}" aria-label="Arc radius"></label>` : '';
    const typeControl = b.type === 'rapid' || b.type === 'linear'
      ? `<button type="button" class="badge motion-toggle" title="Toggle between G0 and G1" aria-label="Change ${meta.code} to ${b.type === 'rapid' ? 'G1' : 'G0'}"><span>${meta.code}</span><small>${meta.label}</small></button>`
      : `<span class="badge">${meta.label}</span>`;
    return `<div class="block ${selected === i ? 'selected' : ''}" data-index="${i}" tabindex="0"><span class="drag">··</span><span class="line-no">${String(i + 2).padStart(2,'0')}</span>${typeControl}<div class="fields">${fields}${extra}</div><button class="delete" aria-label="Delete block">×</button></div>`;
  }).join('');
  if (editorMode === 'blocks') $('#editorMeta').textContent = `${String(blocks.length).padStart(2,'0')} BLOCKS`;
  bindBlockEvents();
}

function bindBlockEvents() {
  document.querySelectorAll('.block').forEach(el => {
    const index = Number(el.dataset.index);
    el.addEventListener('click', e => {
      if (e.target.closest('.delete')) {
        blocks.splice(index, 1); selected = Math.min(selected, blocks.length - 1); render(); return;
      }
      if (e.target.closest('.motion-toggle')) {
        blocks[index].type = blocks[index].type === 'rapid' ? 'linear' : 'rapid';
        if (blocks[index].type === 'linear' && blocks[index].f === undefined) blocks[index].f = num($('#defaultFeed').value);
        if (blocks[index].type === 'rapid') delete blocks[index].f;
        selected = index; render(); return;
      }
      if (e.target.closest('input')) {
        selected = index;
        document.querySelectorAll('.block').forEach((block, i) => block.classList.toggle('selected', i === selected));
        renderCode(); renderPlot(); return;
      }
      selected = index; render();
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { selected = index; render(); } });
    el.querySelectorAll('input').forEach(input => input.addEventListener('input', e => {
      e.stopPropagation(); const key = input.dataset.key;
      if (input.value === '') delete blocks[index][key]; else blocks[index][key] = num(input.value);
      selected = index; renderCode(); renderPlot();
    }));
  });
}

function gcodeLines() {
  const lines = [`G54 G17 ${$('#unitsSelect').value} ${$('#modeSelect').value}`];
  blocks.forEach(b => {
    const parts = [typeMeta[b.type].code];
    ['x','y','z','r','f'].forEach(k => { if (b[k] !== undefined) parts.push(k.toUpperCase() + fmt(b[k])); });
    lines.push(parts.join(' '));
  });
  return lines;
}

function renderCode() {
  const lines = gcodeLines();
  $('#preambleCode').textContent = lines[0];
  $('#codeEditor').value = lines.join('\n');
  codeValid = true;
  updateCodeStatus(lines.length);
}

function updateCodeStatus(lineCount, error = '') {
  const status = $('#codeStatus');
  status.textContent = error || `VALID · ${String(lineCount).padStart(2,'0')} LINES`;
  status.classList.toggle('invalid', Boolean(error));
  if (editorMode === 'code') $('#editorMeta').textContent = error ? 'CHECK CODE' : `${String(lineCount).padStart(2,'0')} LINES`;
}

function parseCode(text) {
  const lines = text.split(/\r?\n/);
  const parsed = [];
  let units = $('#unitsSelect').value;
  let mode = $('#modeSelect').value;
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/\([^)]*\)/g, '').replace(/;.*/, '').trim().toUpperCase();
    if (!clean) continue;
    if (/(^|\s)G20(?=\s|$)/.test(clean)) units = 'G20';
    if (/(^|\s)G21(?=\s|$)/.test(clean)) units = 'G21';
    if (/(^|\s)G90(?=\s|$)/.test(clean)) mode = 'G90';
    if (/(^|\s)G91(?=\s|$)/.test(clean)) mode = 'G91';
    const motion = clean.match(/(?:^|\s)G0?([0-3])(?=\s|$)/);
    const isSetup = /(^|\s)G(?:17|18|19|20|21|54|55|56|57|58|59|90|91)(?=\s|$)/.test(clean);
    if (!motion) {
      if (isSetup) continue;
      return { error: `LINE ${String(i + 1).padStart(2, '0')} · EXPECTED G0–G3` };
    }
    const type = motion[1] === '0' ? 'rapid' : motion[1] === '1' ? 'linear' : motion[1] === '2' ? 'arc-cw' : 'arc-ccw';
    const block = { type };
    const tokenPattern = /([XYZFR])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g;
    let token;
    while ((token = tokenPattern.exec(clean))) block[token[1].toLowerCase()] = num(token[2]);
    parsed.push(block);
  }
  return { blocks: parsed, units, mode, lineCount: lines.filter(line => line.trim()).length };
}

function applyCodeInput() {
  const result = parseCode($('#codeEditor').value);
  if (result.error) {
    codeValid = false;
    updateCodeStatus(0, result.error);
    return;
  }
  codeValid = true;
  blocks = result.blocks;
  selected = Math.min(Math.max(selected, 0), blocks.length - 1);
  $('#unitsSelect').value = result.units;
  $('#modeSelect').value = result.mode;
  renderBlocks();
  renderPlot();
  updateCodeStatus(result.lineCount);
}

function setEditorMode(mode) {
  if (mode === 'blocks' && !codeValid) { toast('FIX CODE BEFORE SWITCHING'); $('#codeEditor').focus(); return; }
  editorMode = mode;
  const blocksMode = mode === 'blocks';
  $('#blocksPane').hidden = !blocksMode;
  $('#codePane').hidden = blocksMode;
  $('#blocksTab').classList.toggle('active', blocksMode);
  $('#codeTab').classList.toggle('active', !blocksMode);
  $('#blocksTab').setAttribute('aria-selected', String(blocksMode));
  $('#codeTab').setAttribute('aria-selected', String(!blocksMode));
  if (blocksMode) $('#editorMeta').textContent = `${String(blocks.length).padStart(2,'0')} BLOCKS`;
  else {
    renderCode();
    $('#editorMeta').textContent = `${String(gcodeLines().length).padStart(2,'0')} LINES`;
    requestAnimationFrame(() => $('#codeEditor').focus());
  }
}

function renderPlot() {
  const states = stateAt();
  const all = [{x:0,y:0}, ...states];
  const minX = Math.min(0, ...all.map(p => p.x)), maxX = Math.max(6, ...all.map(p => p.x));
  const minY = Math.min(0, ...all.map(p => p.y)), maxY = Math.max(6, ...all.map(p => p.y));
  const pad = 58, w = 600, h = 500;
  const sx = x => pad + (x - minX) / Math.max(1, maxX - minX) * (w - pad * 2);
  const sy = y => h - pad - (y - minY) / Math.max(1, maxY - minY) * (h - pad * 2);
  let svg = `<rect width="600" height="500" fill="#fbfaf6"/>`;
  for (let i = Math.ceil(minX); i <= Math.floor(maxX); i++) svg += `<line x1="${sx(i)}" y1="${pad}" x2="${sx(i)}" y2="${h-pad}" stroke="#ddd9d0" stroke-width="1"/><text x="${sx(i)}" y="${h-28}" text-anchor="middle" font-size="12" fill="#77736b" font-family="monospace">X${i}</text>`;
  for (let i = Math.ceil(minY); i <= Math.floor(maxY); i++) svg += `<line x1="${pad}" y1="${sy(i)}" x2="${w-pad}" y2="${sy(i)}" stroke="#ddd9d0" stroke-width="1"/><text x="28" y="${sy(i)+4}" text-anchor="middle" font-size="12" fill="#77736b" font-family="monospace">Y${i}</text>`;
  let prev = {x:0,y:0,z:num($('#safeZ').value)};
  let length = 0;
  states.forEach((p, i) => {
    const movedXY = p.x !== prev.x || p.y !== prev.y;
    if (movedXY) {
      const isRapid = p.type === 'rapid';
      const active = i === selected;
      const dist = Math.hypot(p.x-prev.x, p.y-prev.y); length += dist;
      svg += `<line class="path-segment" data-index="${i}" x1="${sx(prev.x)}" y1="${sy(prev.y)}" x2="${sx(p.x)}" y2="${sy(p.y)}" stroke="${active ? '#e14b32' : isRapid ? '#6d86b4' : '#1b1b19'}" stroke-width="${active ? 5 : isRapid ? 2 : 3}" ${isRapid ? 'stroke-dasharray="7 6"' : ''} stroke-linecap="round"/>`;
    }
    if (i === selected) svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="7" fill="#fbfaf6" stroke="#e14b32" stroke-width="3"/>`;
    prev = p;
  });
  svg += `<circle id="toolDot" cx="${sx(states[selected]?.x ?? 0)}" cy="${sy(states[selected]?.y ?? 0)}" r="5" fill="#e14b32"/>`;
  svg += `<path d="M${sx(0)-7} ${sy(0)}h14M${sx(0)} ${sy(0)-7}v14" stroke="#1b1b19" stroke-width="2"/><text x="${sx(0)+10}" y="${sy(0)-10}" font-size="11" fill="#1b1b19" font-family="monospace">ORIGIN</text>`;
  plot.innerHTML = svg;
  const current = states[selected] || {x:0,y:0,z:0};
  $('#cursorReadout').innerHTML = `X ${num(current.x).toFixed(2)}&nbsp;&nbsp;Y ${num(current.y).toFixed(2)}`;
  $('#zReadout').textContent = num(current.z).toFixed(2);
  $('#pathLength').textContent = `${length.toFixed(1)} ${$('#unitsSelect').value === 'G20' ? 'IN' : 'MM'}`;
  plot.querySelectorAll('.path-segment').forEach(seg => seg.addEventListener('click', () => { selected = Number(seg.dataset.index); render(); }));
}

function render() { renderBlocks(); renderCode(); renderPlot(); }
function addBlock(type) {
  const last = stateAt(blocks.length - 1) || {x:0,y:0,z:0};
  const b = type === 'rapid' ? {type, x:last.x, y:last.y, z:last.z} : type === 'linear' ? {type, x:last.x, y:last.y, f:num($('#defaultFeed').value)} : {type, x:last.x + 1, y:last.y, r:1, f:num($('#defaultFeed').value)};
  blocks.push(b); selected = blocks.length - 1; render();
  setTimeout(() => blockList.lastElementChild?.scrollIntoView({behavior:'smooth',block:'center'}), 30);
}
function toast(message) { const t=$('#toast'); t.textContent=message; t.classList.add('show'); clearTimeout(t._timer); t._timer=setTimeout(()=>t.classList.remove('show'),1800); }
function currentCodeText() { return codeValid && $('#codeEditor').value.trim() ? $('#codeEditor').value.trim() : gcodeLines().join('\n'); }

$('#commandList').addEventListener('click', e => { const b=e.target.closest('[data-type]'); if(b) addBlock(b.dataset.type); });
$('#addLinear').addEventListener('click', () => addBlock('linear'));
$('#blocksTab').addEventListener('click', () => setEditorMode('blocks'));
$('#codeTab').addEventListener('click', () => setEditorMode('code'));
$('#codeEditor').addEventListener('input', applyCodeInput);
['unitsSelect','modeSelect','safeZ','defaultFeed'].forEach(id => $('#'+id).addEventListener('input', render));
$('#fitButton').addEventListener('click', () => { renderPlot(); toast('VIEW FIT TO TOOLPATH'); });
$('#copyButton').addEventListener('click', async () => { await navigator.clipboard.writeText(currentCodeText()); toast('G-CODE COPIED'); });
$('#exportButton').addEventListener('click', () => {
  const blob = new Blob([currentCodeText()+'\n'], {type:'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=($('#programName').textContent.trim()||'program').toLowerCase()+'.nc'; a.click(); URL.revokeObjectURL(a.href); toast('PROGRAM EXPORTED');
});
$('#newButton').addEventListener('click', () => { blocks=[]; selected=-1; render(); toast('NEW PROGRAM'); });
$('#playButton').addEventListener('click', async () => {
  if(running || !blocks.length) return; running=true; $('#playButton').textContent='■ STOP';
  for(let i=0;i<blocks.length && running;i++){ selected=i; render(); await new Promise(r=>setTimeout(r,360)); }
  running=false; $('#playButton').textContent='▶ RUN';
});

render();
