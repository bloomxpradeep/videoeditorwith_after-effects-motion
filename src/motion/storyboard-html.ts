/**
 * Renders a resolved storyboard as one self-contained HTML page the editor
 * opens in a browser: a player with every overlay animated over the real
 * footage, a card per beat, and the rule check results.
 *
 * The preview reads the same resolved timings (letter keys, entrance and exit
 * times, pixel sizes) the After Effects builder uses, and mirrors its presets,
 * so the approved storyboard and the built comp move the same way.
 */
import { dirname, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedStoryboard } from './storyboard.js';

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface StoryboardHtmlInput {
  resolved: ResolvedStoryboard;
  /** Absolute path the HTML is written to; media paths are made relative to it. */
  htmlPath: string;
  /** Absolute footage path. */
  footagePath: string;
  /** Absolute media element paths by element id. */
  mediaPaths: Record<string, string>;
}

function relUrl(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target);
  if (!rel || rel.startsWith('..' + sep + '..' + sep + '..' + sep + '..')) return pathToFileURL(target).href;
  return rel.split(sep).map(encodeURIComponent).join('/');
}

export function renderStoryboardHtml(input: StoryboardHtmlInput): string {
  const { resolved } = input;
  const sb = resolved.storyboard;
  const data = {
    title: sb.title,
    duration: resolved.duration,
    output: sb.output,
    video: relUrl(input.htmlPath, input.footagePath),
    style: {
      palette: sb.style.palette,
      pixelSize: sb.style.pixelSize,
      reservedBottom: sb.style.reservedBottom,
      minHold: sb.style.minHold,
      fonts: sb.style.fonts,
    },
    rules: sb.rules,
    noGoZones: sb.noGoZones,
    issues: resolved.issues,
    beats: resolved.beats.map((b) => ({
      id: b.beat.id,
      name: b.beat.name,
      start: b.beat.start,
      end: b.beat.end,
      say: b.beat.say ?? null,
      notes: b.beat.notes ?? null,
      transition: b.transition,
      words: b.words.map((w) => ({ w: w.word, s: w.start, e: w.end })),
      elements: b.elements.map((el) => ({
        id: el.element.id,
        layer: el.layerName,
        kind: el.element.kind,
        text: el.element.text ?? '',
        shape: el.element.shape ?? 'rectangle',
        src: el.element.kind === 'media' && input.mediaPaths[el.element.id] ? relUrl(input.htmlPath, input.mediaPaths[el.element.id]!) : null,
        sequence: !!el.element.sequence,
        family: el.font?.family ?? null,
        weight: el.font?.weight ?? (el.element.role === 'hero' ? 800 : 600),
        italic: el.font?.style === 'italic',
        size: el.size,
        color: el.color,
        fill: el.element.fill ?? el.color,
        strokeColor: el.element.strokeColor ?? null,
        strokeWidth: el.element.strokeWidth ?? 0,
        tracking: el.element.tracking ?? 0,
        align: el.element.align ?? 'center',
        allCaps: !!el.element.allCaps,
        x: el.element.x,
        y: el.element.y,
        width: el.element.width ?? null,
        height: el.element.height ?? null,
        roundness: el.element.roundness ?? 0,
        animIn: el.animIn,
        animOut: el.animOut,
        micro: el.microMotion,
        t: el.timing,
        synced: el.syncedWords.map((w) => ({ w: w.word, s: w.start, e: w.end })),
        box: el.box,
      })),
    })),
  };

  const errors = resolved.issues.filter((i) => i.level === 'error').length;
  const warnings = resolved.issues.length - errors;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(sb.title)} — Storyboard</title>
<style>
:root {
  --bg: #0e0f11; --panel: #16181b; --panel-2: #1d2024; --line: #2a2e33; --text: #e9eaec; --muted: #9aa0a6;
  --accent: #7ee0b5; --error: #ff6b6b; --warn: #ffc857; --zone: rgba(255, 82, 82, 0.9);
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 var(--sans); }
header { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; justify-content: space-between; padding: 14px 24px; background: rgba(14,15,17,0.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: 0.01em; }
header .meta { color: var(--muted); font: 12px var(--mono); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chip { font: 12px var(--mono); padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.chip.err { color: var(--error); border-color: rgba(255,107,107,0.45); }
.chip.warn { color: var(--warn); border-color: rgba(255,200,87,0.45); }
.chip.ok { color: var(--accent); border-color: rgba(126,224,181,0.45); }
button { font: 600 13px var(--sans); color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; cursor: pointer; }
button:hover { border-color: #3a4047; }
button.primary { background: var(--accent); color: #062417; border-color: transparent; }
label.toggle { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12px; cursor: pointer; user-select: none; }
main { padding: 20px 24px 60px; max-width: 1500px; margin: 0 auto; }
.stage-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; align-items: start; }
@media (max-width: 1100px) { .stage-wrap { grid-template-columns: 1fr; } }
.stage { position: relative; width: 100%; background: #000; border-radius: 10px; overflow: hidden; border: 1px solid var(--line); }
.stage video, .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.stage video { object-fit: cover; }
.stage .missing { position: absolute; inset: 0; display: none; place-items: center; text-align: center; padding: 24px; color: var(--muted); }
.timeline { margin-top: 10px; position: relative; height: 46px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; cursor: pointer; }
.timeline .seg { position: absolute; top: 0; bottom: 14px; border-right: 1px solid var(--bg); background: var(--panel-2); color: var(--muted); font: 11px var(--mono); padding: 6px 6px; overflow: hidden; white-space: nowrap; }
.timeline .seg.active { background: #23332c; color: var(--accent); }
.timeline .word { position: absolute; bottom: 3px; width: 1px; height: 8px; background: #4a5058; }
.timeline .head { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); pointer-events: none; }
.now { margin-top: 8px; display: flex; justify-content: space-between; color: var(--muted); font: 12px var(--mono); }
aside .box { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
aside h2, section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
aside ol { margin: 0; padding-left: 18px; }
aside li { margin: 0 0 6px; }
.checks { list-style: none; margin: 0; padding: 0; }
.checks li { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.checks li:last-child { border-bottom: 0; }
.checks .r { font: 12px var(--mono); }
.palette { display: flex; gap: 6px; flex-wrap: wrap; }
.swatch { width: 28px; height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12); }
.cards { margin-top: 28px; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.card .top { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 12px; gap: 8px; }
.card .id { font: 700 13px var(--mono); color: var(--accent); }
.card .name { font-weight: 600; flex: 1; }
.card .tc { font: 12px var(--mono); color: var(--muted); }
.card .preview { position: relative; aspect-ratio: 16 / 9; background: #000; cursor: pointer; }
.card .preview video, .card .preview canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.card .preview video { object-fit: cover; }
.card .preview .play { position: absolute; left: 10px; bottom: 10px; font: 600 12px var(--sans); background: rgba(0,0,0,0.6); padding: 4px 8px; border-radius: 6px; }
.card .body { padding: 10px 12px 12px; display: grid; gap: 8px; }
.said { color: var(--muted); font-size: 13px; }
.said mark { background: none; color: var(--text); border-bottom: 2px solid var(--accent); }
.els { font: 12px var(--mono); color: var(--muted); display: grid; gap: 3px; }
.els b { color: var(--text); font-weight: 600; }
.notes { font-size: 13px; color: #c9ccd0; }
.issue { font-size: 12.5px; padding: 6px 8px; border-radius: 6px; background: rgba(255,200,87,0.08); color: var(--warn); }
.issue.error { background: rgba(255,107,107,0.1); color: var(--error); }
footer { color: var(--muted); font-size: 12px; margin-top: 30px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(sb.title)}</h1>
    <div class="meta">${resolved.beats.length} beats · ${resolved.duration.toFixed(1)}s · ${sb.output.width}×${sb.output.height} @ ${sb.output.fps}fps</div>
  </div>
  <div class="chips">
    <span class="chip ${errors ? 'err' : 'ok'}">${errors} rule error${errors === 1 ? '' : 's'}</span>
    <span class="chip ${warnings ? 'warn' : 'ok'}">${warnings} warning${warnings === 1 ? '' : 's'}</span>
    <label class="toggle"><input type="checkbox" id="showZones" checked> No-go zones</label>
    <label class="toggle"><input type="checkbox" id="showBoxes"> Layout boxes</label>
    <button class="primary" id="playAll">▶ Play full storyboard</button>
  </div>
</header>
<main>
  <div class="stage-wrap">
    <div>
      <div class="stage" id="stage">
        <video id="main" preload="auto" playsinline></video>
        <canvas id="mainCanvas"></canvas>
        <div class="missing" id="missing">Footage not found next to this page.<br>Expected: <span id="missingPath"></span></div>
      </div>
      <div class="timeline" id="timeline"></div>
      <div class="now"><span id="nowBeat">—</span><span id="nowTime">0:00.0</span></div>
    </div>
    <aside>
      <div class="box"><h2>Rules</h2><ol id="rules"></ol></div>
      <div class="box"><h2>Automatic checks</h2><ul class="checks" id="checks"></ul></div>
      <div class="box"><h2>Palette</h2><div class="palette" id="palette"></div></div>
    </aside>
  </div>
  <section><div class="cards" id="cards"></div></section>
  <footer>Generated by Motion Director from storyboard.json. Edit the JSON (or ask Claude), then rebuild this page. Click a card to play that beat with sound.</footer>
</main>
<script>
const DATA = ${scriptSafeJson(data)};
const OUT = DATA.output;
const PX = DATA.style.pixelSize;

const CHECKS = [
  ['spoken', 'Text appears only when spoken'],
  ['no-go', 'Nothing on a no-go zone (face)'],
  ['reserved-bottom', 'Bottom area kept clear'],
  ['hold', 'Animate in, hold, then exit'],
  ['abrupt', 'No fast or abrupt moves'],
  ['static', 'Nothing static (micro-motion)'],
  ['coverage', 'Every second of footage used'],
  ['beats', 'Beats in order, no overlaps'],
  ['fonts', 'Font limit'],
  ['palette', 'Colours from the palette'],
  ['overlap', 'Text does not collide'],
  ['frame', 'Everything inside the frame'],
  ['content', 'Every element has content'],
];

const fmt = (t) => { const m = Math.floor(t / 60); const s = (t - m * 60).toFixed(1).padStart(4, '0'); return m + ':' + s; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (p) => { p = clamp(p, 0, 1); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
const prog = (t, a, b) => b <= a ? (t >= a ? 1 : 0) : clamp((t - a) / (b - a), 0, 1);

function allElements() { const out = []; DATA.beats.forEach((b) => b.elements.forEach((e) => out.push(e))); return out; }
const ELEMENTS = allElements();

const images = {};
ELEMENTS.forEach((e) => { if (e.kind === 'media' && e.src && /\\.(png|jpe?g|webp|gif|svg)$/i.test(e.src)) { const img = new Image(); img.src = e.src; images[e.id + e.layer] = img; } });

function visibleChars(e, t) {
  const k = e.t.charKeys;
  if (!k.length) return e.t.totalChars;
  if (t <= k[0].t) return k[0].chars;
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) { const a = k[i - 1], b = k[i]; return a.chars + (b.chars - a.chars) * prog(t, a.t, b.t); }
  }
  return k[k.length - 1].chars;
}

function stateAt(e, t) {
  const T = e.t;
  if (t < T.in || t >= T.out) return null;
  const s = { opacity: 1, dx: 0, dy: 0, scale: 1, scaleX: 1, pixel: 1, chars: Infinity };
  const end = T.in + Math.max(T.inDuration, 0.05);
  const sc = OUT.height / 1080;
  switch (e.animIn) {
    case 'letter-reveal': s.chars = Math.floor(visibleChars(e, t) + 1e-6); break;
    case 'pixel-letter-reveal': s.chars = Math.floor(visibleChars(e, t) + 1e-6); s.pixel = PX + (1 - PX) * ease(prog(t, T.in, Math.max(T.revealEnd, T.in + 0.2))); break;
    case 'pixel-resolve': s.opacity = prog(t, T.in, T.in + 0.12); s.pixel = PX * 1.5 + (1 - PX * 1.5) * ease(prog(t, T.in, end)); break;
    case 'fade-up': { const p = ease(prog(t, T.in, end)); s.opacity = p; s.dy = 30 * sc * (1 - p); break; }
    case 'fade': s.opacity = ease(prog(t, T.in, end)); break;
    case 'pop': { s.opacity = prog(t, T.in, T.in + 0.08); const mid = T.in + T.inDuration * 0.65; s.scale = t < mid ? 1.08 * ease(prog(t, T.in, mid)) : 1.08 + (1 - 1.08) * ease(prog(t, mid, end)); break; }
    case 'grow-x': s.scaleX = ease(prog(t, T.in, end)); break;
  }
  if (t >= T.exitStart) {
    const p = ease(prog(t, T.exitStart, T.out));
    if (e.animOut === 'fade') s.opacity *= 1 - p;
    if (e.animOut === 'fade-down') { s.opacity *= 1 - p; s.dy += 20 * sc * p; }
    if (e.animOut === 'pixel-out') { s.pixel = Math.max(s.pixel, 1 + (PX * 1.5 - 1) * p); s.opacity *= 1 - prog(t, Math.max(T.exitStart, T.out - 0.15), T.out); }
  }
  // Micro-motion, same formulas as the After Effects expressions.
  const idx = ELEMENTS.indexOf(e);
  const ph = (idx * 1.37) % 6.283;
  if (e.micro === 'drift') { s.dx += Math.sin(t * 0.25 * 2 * Math.PI + ph) * 4 * sc; s.dy += Math.cos(t * 0.25 * 1.6 * Math.PI + ph) * 4 * sc * 0.6; }
  if (e.micro === 'breathe') s.scale *= 1 + 0.015 * Math.sin(t * 0.3 * 2 * Math.PI + ph);
  if (e.micro === 'sway') s.rot = 1 * Math.sin(t * 0.2 * 2 * Math.PI + ph);
  if (e.micro === 'float') { s.dx += Math.sin(t * 0.5 * 2 * Math.PI * 0.9 + ph) * 5 * sc; s.dy += Math.sin(t * 0.5 * 2 * Math.PI * 1.3 + ph * 2) * 5 * sc; }
  return s;
}

function sliceChars(text, n) {
  if (!isFinite(n)) return text;
  let count = 0, out = '';
  for (const ch of text) { if (/\\s/.test(ch)) { out += ch; continue; } if (count >= n) break; out += ch; count++; }
  return out.replace(/\\s+$/, '');
}

function drawElement(ctx, e, s, k) {
  ctx.save();
  ctx.globalAlpha = clamp(s.opacity, 0, 1);
  const x = e.x * OUT.width * k + s.dx * k, y = e.y * OUT.height * k + s.dy * k;
  if (e.kind === 'text') {
    const size = e.size * k;
    const family = (e.family ? '"' + e.family + '", ' : '') + 'Inter, "Helvetica Neue", Arial, sans-serif';
    ctx.font = (e.italic ? 'italic ' : '') + e.weight + ' ' + size + 'px ' + family;
    if ('letterSpacing' in ctx) ctx.letterSpacing = (e.tracking / 1000 * size) + 'px';
    ctx.textBaseline = 'middle';
    ctx.textAlign = e.align;
    const full = e.allCaps ? e.text.toUpperCase() : e.text;
    const lines = full.split('\\n');
    const shown = sliceChars(full, s.chars).split('\\n');
    const lh = size * 1.15;
    let ax = x;
    ctx.translate(ax, y); ctx.rotate((s.rot || 0) * Math.PI / 180); ctx.scale(s.scale * s.scaleX, s.scale);
    if (s.scaleX !== 1 && e.align === 'center') { /* grow from the left edge, like the AE anchor */ }
    lines.forEach((_, i) => {
      const line = shown[i] || '';
      const ly = (i - (lines.length - 1) / 2) * lh;
      if (e.strokeWidth && e.strokeColor) { ctx.lineWidth = e.strokeWidth * k; ctx.strokeStyle = e.strokeColor; ctx.strokeText(line, 0, ly); }
      ctx.fillStyle = e.color;
      if (e.align === 'center' && line.length < lines[i].length) {
        // keep revealed letters where they will sit in the finished word
        const fullW = ctx.measureText(lines[i]).width;
        ctx.textAlign = 'left'; ctx.fillText(line, -fullW / 2, ly); ctx.textAlign = 'center';
      } else ctx.fillText(line, 0, ly);
    });
  } else if (e.kind === 'shape') {
    const w = (e.width || 0.2) * OUT.width * k;
    const h = e.shape === 'underline' ? Math.max(4 * k, (e.height || 0.008) * OUT.height * k) : (e.height || (e.width || 0.2) * OUT.width / OUT.height) * OUT.height * k;
    ctx.translate(x - (s.scaleX !== 1 ? w / 2 : 0), y); ctx.rotate((s.rot || 0) * Math.PI / 180); ctx.scale(s.scale * s.scaleX, s.scale);
    const left = s.scaleX !== 1 ? 0 : -w / 2;
    ctx.fillStyle = e.fill;
    ctx.beginPath();
    if (e.shape === 'ellipse') ctx.ellipse(left + w / 2, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (ctx.roundRect) ctx.roundRect(left, -h / 2, w, h, Math.min(e.roundness * k || (e.shape === 'underline' ? h / 2 : 0), h / 2));
    else ctx.rect(left, -h / 2, w, h);
    ctx.fill();
    if (e.strokeWidth && e.strokeColor) { ctx.lineWidth = e.strokeWidth * k; ctx.strokeStyle = e.strokeColor; ctx.stroke(); }
  } else {
    const w = (e.width || 0.3) * OUT.width * k;
    const img = images[e.id + e.layer];
    ctx.translate(x, y); ctx.scale(s.scale, s.scale);
    if (img && img.complete && img.naturalWidth) { const h = w * img.naturalHeight / img.naturalWidth; ctx.drawImage(img, -w / 2, -h / 2, w, h); }
    else { const h = w * 0.5625; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.setLineDash([6, 4]); ctx.strokeRect(-w / 2, -h / 2, w, h); ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = (12 * Math.max(k, 0.6)) + 'px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((e.sequence ? '3D / sequence: ' : 'media: ') + (e.src || '?'), 0, 0); }
  }
  ctx.restore();
}

const scratch = document.createElement('canvas');
const tiny = document.createElement('canvas');
function pixelate(target, source, size) {
  const w = target.width, h = target.height;
  tiny.width = Math.max(1, Math.round(w / size)); tiny.height = Math.max(1, Math.round(h / size));
  const tc = tiny.getContext('2d'); tc.imageSmoothingEnabled = true; tc.clearRect(0, 0, tiny.width, tiny.height); tc.drawImage(source, 0, 0, tiny.width, tiny.height);
  const ctx = target.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(tiny, 0, 0, w, h); ctx.imageSmoothingEnabled = true;
}

function beatAt(t) { return DATA.beats.find((b) => t >= b.start && t < b.end) || null; }

function render(canvas, video, t, opts) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const k = W / OUT.width;
  // Whole-frame pixel flash transitions pixelate the footage too, so draw it into the canvas.
  let flash = 1;
  DATA.beats.forEach((b) => { if (b.transition.type === 'pixel-flash' && b.transition.duration > 0) { const a = b.end - b.transition.duration / 2, c = b.end + b.transition.duration / 2; if (t >= a && t <= c) { const p = t < b.end ? prog(t, a, b.end) : 1 - prog(t, b.end, c); flash = Math.max(flash, 1 + (PX * 3 - 1) * ease(p)); } } });
  if (flash > 1.01 && video && video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H);
  for (const e of ELEMENTS) {
    const s = stateAt(e, t);
    if (!s || s.opacity <= 0.001) continue;
    const pixel = s.pixel * k;
    if (pixel > 1.5) {
      scratch.width = W; scratch.height = H;
      const sc = scratch.getContext('2d'); sc.clearRect(0, 0, W, H);
      drawElement(sc, e, s, k);
      const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
      pixelate(layer, scratch, pixel);
      ctx.drawImage(layer, 0, 0);
    } else drawElement(ctx, e, s, k);
    if (opts.boxes) { ctx.save(); ctx.strokeStyle = 'rgba(126,224,181,0.8)'; ctx.setLineDash([4, 3]); ctx.strokeRect(e.box.x * W, e.box.y * H, e.box.w * W, e.box.h * H); ctx.restore(); }
  }
  if (flash > 1.01) { const copy = document.createElement('canvas'); copy.width = W; copy.height = H; copy.getContext('2d').drawImage(canvas, 0, 0); pixelate(canvas, copy, flash * k); }
  if (opts.zones) {
    ctx.save();
    DATA.noGoZones.forEach((z) => { if ((z.start ?? -1) <= t && t <= (z.end ?? 1e9)) { ctx.fillStyle = 'rgba(255,82,82,0.12)'; ctx.strokeStyle = 'rgba(255,82,82,0.9)'; ctx.setLineDash([8, 5]); ctx.lineWidth = Math.max(1, 1.5 * k * 2); ctx.fillRect(z.x * W, z.y * H, z.w * W, z.h * H); ctx.strokeRect(z.x * W, z.y * H, z.w * W, z.h * H); ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,120,120,0.95)'; ctx.font = Math.max(10, 12 * k * 2) + 'px ui-monospace, monospace'; ctx.fillText(z.label || 'no-go', z.x * W + 6, z.y * H + 16 * Math.max(1, k * 2)); } });
    if (DATA.style.reservedBottom > 0) { const y = (1 - DATA.style.reservedBottom) * H; ctx.strokeStyle = 'rgba(255,200,87,0.7)'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }
}

// ---------- page wiring
const main = document.getElementById('main');
const mainCanvas = document.getElementById('mainCanvas');
const stage = document.getElementById('stage');
stage.style.aspectRatio = OUT.width + ' / ' + OUT.height;
main.src = DATA.video;
main.addEventListener('error', () => { document.getElementById('missing').style.display = 'grid'; document.getElementById('missingPath').textContent = decodeURIComponent(DATA.video); });
const opts = { zones: true, boxes: false };
document.getElementById('showZones').addEventListener('change', (ev) => { opts.zones = ev.target.checked; });
document.getElementById('showBoxes').addEventListener('change', (ev) => { opts.boxes = ev.target.checked; });

const timeline = document.getElementById('timeline');
const dur = DATA.duration || (DATA.beats.length ? DATA.beats[DATA.beats.length - 1].end : 1);
DATA.beats.forEach((b) => {
  const seg = document.createElement('div'); seg.className = 'seg'; seg.dataset.id = b.id;
  seg.style.left = (b.start / dur * 100) + '%'; seg.style.width = ((b.end - b.start) / dur * 100) + '%';
  seg.textContent = b.id + ' ' + b.name; seg.title = b.id + ' · ' + b.name + ' · ' + fmt(b.start) + '–' + fmt(b.end);
  timeline.appendChild(seg);
  b.words.forEach((w) => { const tick = document.createElement('div'); tick.className = 'word'; tick.style.left = (w.s / dur * 100) + '%'; timeline.appendChild(tick); });
});
const head = document.createElement('div'); head.className = 'head'; timeline.appendChild(head);
timeline.addEventListener('click', (ev) => { const r = timeline.getBoundingClientRect(); main.currentTime = clamp((ev.clientX - r.left) / r.width, 0, 1) * dur; stopCards(); });
stage.addEventListener('click', () => { if (main.paused) { stopCards(); main.play(); } else main.pause(); });
document.getElementById('playAll').addEventListener('click', () => { stopCards(); main.currentTime = 0; main.muted = false; main.play(); stage.scrollIntoView({ behavior: 'smooth', block: 'center' }); });

const rulesEl = document.getElementById('rules');
(DATA.rules.length ? DATA.rules : ['No rules written yet.']).forEach((r) => { const li = document.createElement('li'); li.textContent = r; rulesEl.appendChild(li); });
const checksEl = document.getElementById('checks');
CHECKS.forEach(([rule, label]) => {
  const list = DATA.issues.filter((i) => i.rule === rule);
  const errs = list.filter((i) => i.level === 'error').length;
  const li = document.createElement('li');
  const r = document.createElement('span'); r.className = 'r';
  r.textContent = list.length ? (errs ? errs + ' error' + (errs > 1 ? 's' : '') : list.length + ' warning' + (list.length > 1 ? 's' : '')) : 'pass';
  r.style.color = list.length ? (errs ? 'var(--error)' : 'var(--warn)') : 'var(--accent)';
  li.append(label, r); checksEl.appendChild(li);
});
const pal = document.getElementById('palette');
DATA.style.palette.forEach((c) => { const s = document.createElement('div'); s.className = 'swatch'; s.style.background = c.startsWith('#') ? c : '#' + c; s.title = c; pal.appendChild(s); });

// ---------- cards
const cardsEl = document.getElementById('cards');
const cards = [];
DATA.beats.forEach((b) => {
  const card = document.createElement('article'); card.className = 'card'; card.id = 'beat-' + b.id;
  const top = document.createElement('div'); top.className = 'top';
  const id = document.createElement('span'); id.className = 'id'; id.textContent = b.id;
  const name = document.createElement('span'); name.className = 'name'; name.textContent = b.name;
  const tc = document.createElement('span'); tc.className = 'tc'; tc.textContent = fmt(b.start) + '–' + fmt(b.end);
  top.append(id, name, tc);
  const preview = document.createElement('div'); preview.className = 'preview';
  const v = document.createElement('video'); v.src = DATA.video; v.preload = 'metadata'; v.playsInline = true; v.muted = true;
  const c = document.createElement('canvas');
  const play = document.createElement('span'); play.className = 'play'; play.textContent = '▶ Play beat';
  preview.append(v, c, play);
  const body = document.createElement('div'); body.className = 'body';
  const synced = new Set(); b.elements.forEach((e) => e.synced.forEach((w) => synced.add(w.s)));
  const said = document.createElement('div'); said.className = 'said';
  if (b.words.length) b.words.forEach((w, i) => { const span = document.createElement(synced.has(w.s) ? 'mark' : 'span'); span.textContent = (i ? ' ' : '') + w.w; said.appendChild(span); });
  else said.textContent = b.say ? '“' + b.say + '”' : '(no transcript words in this beat)';
  const els = document.createElement('div'); els.className = 'els';
  b.elements.forEach((e) => { const row = document.createElement('div'); const strong = document.createElement('b'); strong.textContent = e.layer; row.append(strong, ' · ' + e.animIn + ' → ' + e.animOut + ' · ' + e.micro + ' · ' + fmt(e.t.in) + '–' + fmt(e.t.out)); els.appendChild(row); });
  body.append(said, els);
  if (b.notes) { const n = document.createElement('div'); n.className = 'notes'; n.textContent = b.notes; body.appendChild(n); }
  DATA.issues.filter((i) => i.beat === b.id).forEach((i) => { const d = document.createElement('div'); d.className = 'issue' + (i.level === 'error' ? ' error' : ''); d.textContent = (i.element ? i.element + ': ' : '') + i.message; body.appendChild(d); });
  card.append(top, preview, body);
  cardsEl.appendChild(card);
  const entry = { b, card, v, c, play, playing: false };
  const mid = b.elements.length ? Math.min(b.end - 0.05, Math.max(...b.elements.map((e) => Math.min(e.t.exitStart, e.t.revealEnd + 0.2)))) : (b.start + b.end) / 2;
  v.addEventListener('loadedmetadata', () => { v.currentTime = clamp(mid, b.start, b.end - 0.04); });
  preview.addEventListener('click', () => { if (entry.playing) { stopCards(); return; } stopCards(); main.pause(); entry.playing = true; play.textContent = '❚❚ Playing'; v.muted = false; v.currentTime = b.start; v.play(); });
  cards.push(entry);
});
function stopCards() { cards.forEach((e) => { if (e.playing) { e.playing = false; e.v.pause(); e.v.muted = true; e.play.textContent = '▶ Play beat'; } }); }

let lastBeat = null;
function frame() {
  const t = main.currentTime || 0;
  render(mainCanvas, main, t, opts);
  head.style.left = (t / dur * 100) + '%';
  document.getElementById('nowTime').textContent = fmt(t);
  const b = beatAt(t);
  document.getElementById('nowBeat').textContent = b ? b.id + ' · ' + b.name : '—';
  if ((b && b.id) !== lastBeat) {
    lastBeat = b && b.id;
    document.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s.dataset.id === lastBeat));
    cards.forEach((e) => e.card.classList.toggle('active', e.b.id === lastBeat && !main.paused));
  }
  for (const e of cards) {
    if (e.playing && e.v.currentTime >= e.b.end) { e.v.currentTime = e.b.start; }
    render(e.c, e.v, e.v.currentTime || e.b.start, opts);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>
</body>
</html>
`;
}
