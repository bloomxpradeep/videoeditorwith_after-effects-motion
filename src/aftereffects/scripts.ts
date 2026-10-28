/**
 * ExtendScript builders for After Effects.
 *
 * Every function here returns the complete script for one command: the AE
 * helper prelude, then a body wrapped in an undo group (so an editor can undo
 * each step with one Cmd+Z) with modal dialogs suppressed (a dialog would block
 * the bridge until someone clicked it). Values are interpolated only through
 * `js()`, which is JSON.stringify: a JSON string literal is also a valid
 * ExtendScript string literal, so caller text can never break out of it.
 *
 * Nothing here imports zod or touches the bridge, so the output can be tested
 * by parsing it as ES3.
 */
import { AE_HELPERS } from './prelude.js';
import type { ResolvedBeat, ResolvedElement, Storyboard } from '../motion/storyboard.js';

export const js = (value: unknown): string => {
  const out = JSON.stringify(value === undefined ? null : value);
  // U+2028/2029 are legal in JSON but end a line in ES3 source.
  return out.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
};

const n = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`Expected a finite number, got ${value}`);
  return String(Math.round(value * 10000) / 10000);
};

/** Wraps a body in the prelude, an undo group and dialog suppression. The body must return __aeResult(...). */
export function aeScript(undoLabel: string, body: string): string {
  return `${AE_HELPERS}
var __undoOpen = false;
try { app.beginUndoGroup(${js(`MCP: ${undoLabel}`)}); __undoOpen = true; } catch (eUndo) {}
try { app.beginSuppressDialogs(); } catch (eDlg) {}
try {
${body}
} catch (err) {
  return __aeResult({ success: false, error: String(err && err.message ? err.message : err), line: (err && err.line) ? err.line : null });
} finally {
  try { app.endSuppressDialogs(false); } catch (eDlg2) {}
  if (__undoOpen) { try { app.endUndoGroup(); } catch (eUndo2) {} }
}`;
}

/** Read-only scripts skip the undo group so they never mark the project as changed. */
export function aeReadScript(body: string): string {
  return `${AE_HELPERS}
try {
${body}
} catch (err) {
  return __aeResult({ success: false, error: String(err && err.message ? err.message : err), line: (err && err.line) ? err.line : null });
}`;
}

// ---------------------------------------------------------------- connection & project

export function verifyConnectionScript(enableFileAccess: boolean): string {
  return aeReadScript(`
  var info = { success: true, app: "After Effects", version: app.version, buildName: null, project: null, activeComp: null };
  try { info.buildName = app.buildName; } catch (e0) {}
  try {
    var proj = app.project;
    info.project = { name: proj.file ? proj.file.name : "Untitled Project", path: proj.file ? proj.file.fsName : null, numItems: proj.numItems, dirty: proj.dirty };
    if (proj.activeItem && (proj.activeItem instanceof CompItem)) info.activeComp = __aeCompInfo(proj.activeItem);
  } catch (e1) { info.projectError = String(e1); }
  var sections = ["Main Pref Section v2", "Main Pref Section"];
  var allowed = null;
  for (var i = 0; i < sections.length && allowed === null; i++) {
    try { allowed = app.preferences.getPrefAsLong(sections[i], "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1; info.prefSection = sections[i]; } catch (e2) {}
  }
  if (${enableFileAccess ? 'true' : 'false'} && allowed !== true) {
    for (var s = 0; s < sections.length; s++) {
      try { app.preferences.savePrefAsLong(sections[s], "Pref_SCRIPTING_FILE_NETWORK_SECURITY", 1); app.preferences.saveToDisk(); app.preferences.reload(); allowed = true; info.enabledFileAccess = true; break; } catch (e3) {}
    }
  }
  info.scriptsCanWriteFiles = allowed;
  if (allowed !== true) info.note = "Scripts may not be allowed to write files. In After Effects: Settings > Scripting & Expressions > tick 'Allow Scripts to Write Files and Access Network'. Saving review frames needs it.";
  try { info.fontsApi = !!(app.fonts && app.fonts.allFonts); } catch (e4) { info.fontsApi = false; }
  return __aeResult(info);`);
}

export function projectInfoScript(): string {
  return aeReadScript(`
  var proj = app.project;
  var items = [];
  for (var i = 1; i <= proj.numItems; i++) {
    var it = proj.item(i);
    var e = { id: it.id, name: it.name, type: it.typeName, folder: it.parentFolder ? it.parentFolder.name : null };
    if (it instanceof CompItem) { e.kind = "comp"; e.width = it.width; e.height = it.height; e.frameRate = it.frameRate; e.duration = __aeRound(it.duration); e.numLayers = it.numLayers; }
    else if (it instanceof FootageItem) {
      e.kind = "footage";
      try { e.width = it.width; e.height = it.height; e.duration = __aeRound(it.duration); e.frameRate = it.frameRate; e.hasAudio = it.hasAudio; e.hasVideo = it.hasVideo; } catch (e1) {}
      try { if (it.file) e.path = it.file.fsName; } catch (e2) {}
      try { e.isStill = it.mainSource.isStill; } catch (e3) {}
    } else if (it instanceof FolderItem) { e.kind = "folder"; }
    items.push(e);
  }
  var active = (proj.activeItem && (proj.activeItem instanceof CompItem)) ? proj.activeItem.id : null;
  return __aeResult({ success: true, project: { name: proj.file ? proj.file.name : "Untitled Project", path: proj.file ? proj.file.fsName : null, dirty: proj.dirty }, activeCompId: active, items: items });`);
}

export function newProjectScript(savePath: string | undefined, discardUnsaved: boolean): string {
  return aeReadScript(`
  if (app.project && app.project.dirty && !${discardUnsaved ? 'true' : 'false'}) {
    return __aeResult({ success: false, status: "unsaved_changes", retry: false, error: "The open After Effects project has unsaved changes. Save it with ae_save_project, or pass discardUnsavedChanges:true to close it without saving." });
  }
  if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  app.newProject();
  var saved = null;
  ${savePath ? `var f = new File(${js(savePath)}); if (f.parent && !f.parent.exists) f.parent.create(); app.project.save(f); saved = app.project.file ? app.project.file.fsName : null;` : ''}
  return __aeResult({ success: true, savedTo: saved, message: saved ? "New project created and saved" : "New project created (not saved yet)" });`);
}

export function openProjectScript(path: string, discardUnsaved: boolean): string {
  return aeReadScript(`
  var f = new File(${js(path)});
  if (!f.exists) return __aeResult({ success: false, error: "Project file not found: " + ${js(path)} });
  if (app.project && app.project.dirty && !${discardUnsaved ? 'true' : 'false'}) {
    return __aeResult({ success: false, status: "unsaved_changes", retry: false, error: "The open project has unsaved changes. Save it first or pass discardUnsavedChanges:true." });
  }
  if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  app.open(f);
  return __aeResult({ success: true, project: app.project.file ? app.project.file.fsName : null });`);
}

export function saveProjectScript(path: string | undefined): string {
  return aeReadScript(`
  ${path
    ? `var f = new File(${js(path)}); if (f.parent && !f.parent.exists) f.parent.create(); app.project.save(f);`
    : `if (!app.project.file) return __aeResult({ success: false, retry: false, error: "This project has never been saved. Pass path (an absolute .aep path) to save it." }); app.project.save();`}
  return __aeResult({ success: true, path: app.project.file ? app.project.file.fsName : null });`);
}

export function importFilesScript(paths: string[], folderName: string | undefined, asSequence: boolean): string {
  return aeScript('Import files', `
  var paths = ${js(paths)};
  var folder = __aeFolder(${js(folderName ?? null)});
  var out = [], errors = [];
  for (var i = 0; i < paths.length; i++) {
    try {
      var it = __aeImportFile(paths[i], ${asSequence ? 'true' : 'false'});
      if (folder) it.parentFolder = folder;
      var e = { path: paths[i], id: it.id, name: it.name };
      try { e.width = it.width; e.height = it.height; e.duration = __aeRound(it.duration); e.frameRate = it.frameRate; e.hasAudio = it.hasAudio; } catch (e1) {}
      out.push(e);
    } catch (err) { errors.push({ path: paths[i], error: String(err && err.message ? err.message : err) }); }
  }
  return __aeResult({ success: errors.length === 0, imported: out, errors: errors });`);
}

export function findFontsScript(query: string, limit: number): string {
  return aeReadScript(`
  if (!app.fonts || !app.fonts.allFonts) return __aeResult({ success: false, retry: false, error: "This After Effects version has no font scripting API (needs After Effects 2024 or newer). Type the PostScript name yourself: in macOS Font Book, select the font and look for 'PostScript name'." });
  var q = ${js(query.toLowerCase())};
  var groups = app.fonts.allFonts;
  var out = [];
  for (var i = 0; i < groups.length && out.length < ${limit}; i++) {
    var g = groups[i];
    for (var j = 0; j < g.length && out.length < ${limit}; j++) {
      var f = g[j];
      var hay = (String(f.familyName) + " " + String(f.styleName) + " " + String(f.postScriptName)).toLowerCase();
      if (q === "" || hay.indexOf(q) !== -1) out.push({ postscript: f.postScriptName, family: f.familyName, style: f.styleName });
    }
  }
  return __aeResult({ success: true, count: out.length, fonts: out });`);
}

// ---------------------------------------------------------------- compositions

export interface CreateCompOptions {
  name: string; width: number; height: number; frameRate: number; duration: number;
  pixelAspect: number; backgroundColor?: string | undefined; folderName?: string | undefined; open: boolean;
}

export function createCompScript(o: CreateCompOptions): string {
  return aeScript(`Create comp ${o.name}`, `
  var comp = app.project.items.addComp(${js(o.name)}, ${Math.round(o.width)}, ${Math.round(o.height)}, ${n(o.pixelAspect)}, ${n(o.duration)}, ${n(o.frameRate)});
  ${o.backgroundColor ? `comp.bgColor = __aeHex(${js(o.backgroundColor)});` : ''}
  var folder = __aeFolder(${js(o.folderName ?? null)});
  if (folder) comp.parentFolder = folder;
  ${o.open ? 'try { comp.openInViewer(); } catch (eOpen) {}' : ''}
  return __aeResult({ success: true, comp: __aeCompInfo(comp) });`);
}

export function compInfoScript(compRef: string | number | undefined): string {
  return aeReadScript(`
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var layers = [];
  for (var i = 1; i <= comp.numLayers; i++) layers.push(__aeLayerInfo(comp.layer(i)));
  var markers = [];
  try { var mp = comp.markerProperty; for (var k = 1; k <= mp.numKeys; k++) markers.push({ time: __aeRound(mp.keyTime(k)), comment: mp.keyValue(k).comment, duration: __aeRound(mp.keyValue(k).duration) }); } catch (eM) {}
  return __aeResult({ success: true, comp: __aeCompInfo(comp), layers: layers, markers: markers });`);
}

export interface CompSettings {
  name?: string | undefined; width?: number | undefined; height?: number | undefined; frameRate?: number | undefined;
  duration?: number | undefined; backgroundColor?: string | undefined; workAreaStart?: number | undefined;
  workAreaDuration?: number | undefined; motionBlur?: boolean | undefined;
}

export function setCompSettingsScript(compRef: string | number | undefined, s: CompSettings): string {
  const lines: string[] = [];
  if (s.name !== undefined) lines.push(`comp.name = ${js(s.name)};`);
  if (s.width !== undefined) lines.push(`comp.width = ${Math.round(s.width)};`);
  if (s.height !== undefined) lines.push(`comp.height = ${Math.round(s.height)};`);
  if (s.frameRate !== undefined) lines.push(`comp.frameRate = ${n(s.frameRate)};`);
  if (s.duration !== undefined) lines.push(`comp.duration = ${n(s.duration)};`);
  if (s.backgroundColor !== undefined) lines.push(`comp.bgColor = __aeHex(${js(s.backgroundColor)});`);
  if (s.workAreaStart !== undefined) lines.push(`comp.workAreaStart = ${n(s.workAreaStart)};`);
  if (s.workAreaDuration !== undefined) lines.push(`comp.workAreaDuration = ${n(s.workAreaDuration)};`);
  if (s.motionBlur !== undefined) lines.push(`comp.motionBlur = ${s.motionBlur ? 'true' : 'false'};`);
  return aeScript('Comp settings', `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  ${lines.join('\n  ')}
  return __aeResult({ success: true, comp: __aeCompInfo(comp) });`);
}

export function openCompScript(compRef: string | number): string {
  return aeReadScript(`
  var comp = __aeRequireComp(${js(compRef)});
  comp.openInViewer();
  return __aeResult({ success: true, comp: __aeCompInfo(comp) });`);
}

// ---------------------------------------------------------------- layers

export interface FootageLayerOptions {
  compRef?: string | number | undefined; itemRef?: string | number | undefined; path?: string | undefined; asSequence: boolean;
  name?: string | undefined; startTime?: number | undefined; inPoint?: number | undefined; outPoint?: number | undefined;
  placement: 'top' | 'bottom'; fit: 'none' | 'cover' | 'contain'; locked: boolean; position?: [number, number] | undefined;
}

export function addFootageLayerScript(o: FootageLayerOptions): string {
  return aeScript('Add footage layer', `
  var comp = __aeRequireComp(${js(o.compRef ?? null)});
  var item = ${o.path ? `__aeImportFile(${js(o.path)}, ${o.asSequence ? 'true' : 'false'})` : `__aeFindItem(${js(o.itemRef ?? null)})`};
  if (!item) return __aeResult({ success: false, error: "Footage item not found: " + ${js(o.itemRef ?? o.path ?? null)} });
  var L = comp.layers.add(item);
  ${o.name ? `L.name = ${js(o.name)};` : ''}
  ${o.startTime !== undefined ? `L.startTime = ${n(o.startTime)};` : ''}
  __aeTiming(L, ${o.inPoint !== undefined ? n(o.inPoint) : 'null'}, ${o.outPoint !== undefined ? n(o.outPoint) : 'null'});
  ${o.placement === 'bottom' ? 'L.moveToEnd();' : ''}
  var fit = ${js(o.fit)};
  if (fit !== "none" && item.width && item.height) {
    var sx = comp.width / item.width, sy = comp.height / item.height;
    var s = (fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy)) * 100;
    var sc = L.property("ADBE Transform Group").property("ADBE Scale"); var cur = sc.value;
    sc.setValue(cur.length === 3 ? [s, s, cur[2]] : [s, s]);
  }
  ${o.position ? `__aeSetPosition(L, [${n(o.position[0])}, ${n(o.position[1])}]);` : ''}
  ${o.locked ? 'L.locked = true;' : ''}
  return __aeResult({ success: true, layer: __aeLayerInfo(L), item: { id: item.id, name: item.name } });`);
}

export interface TextLayerOptions {
  compRef?: string | number | undefined; text: string; name?: string | undefined; font?: string | undefined; fontSize?: number | undefined;
  color?: string | undefined; strokeColor?: string | undefined; strokeWidth?: number | undefined; tracking?: number | undefined;
  leading?: number | undefined; justification?: 'left' | 'center' | 'right' | undefined; allCaps?: boolean | undefined;
  position?: [number, number] | undefined; anchor: 'center' | 'left' | 'right'; inPoint?: number | undefined; outPoint?: number | undefined;
  boxSize?: [number, number] | undefined;
}

export function addTextLayerScript(o: TextLayerOptions): string {
  return aeScript('Add text layer', `
  var comp = __aeRequireComp(${js(o.compRef ?? null)});
  var L = ${o.boxSize ? `comp.layers.addBoxText([${n(o.boxSize[0])}, ${n(o.boxSize[1])}], ${js(o.text)})` : `comp.layers.addText(${js(o.text)})`};
  ${o.name ? `L.name = ${js(o.name)};` : ''}
  var warnings = __aeStyleText(L, ${js({
    font: o.font, fontSize: o.fontSize, color: o.color ?? '#FFFFFF', strokeColor: o.strokeColor, strokeWidth: o.strokeWidth,
    tracking: o.tracking, leading: o.leading, justification: o.justification ?? (o.anchor === 'center' ? 'center' : o.anchor), allCaps: o.allCaps,
  })});
  __aeTiming(L, ${o.inPoint !== undefined ? n(o.inPoint) : 'null'}, ${o.outPoint !== undefined ? n(o.outPoint) : 'null'});
  __aeAnchorTo(L, ${js(o.anchor)}, L.inPoint);
  __aeSetPosition(L, ${o.position ? `[${n(o.position[0])}, ${n(o.position[1])}]` : '[comp.width / 2, comp.height / 2]'});
  return __aeResult({ success: true, layer: __aeLayerInfo(L), warnings: warnings });`);
}

export interface ShapeLayerOptions {
  compRef?: string | number | undefined; shape: 'rectangle' | 'ellipse'; size: [number, number]; position?: [number, number] | undefined;
  fillColor?: string | undefined; strokeColor?: string | undefined; strokeWidth?: number | undefined; roundness?: number | undefined;
  name?: string | undefined; inPoint?: number | undefined; outPoint?: number | undefined;
}

export function addShapeLayerScript(o: ShapeLayerOptions): string {
  return aeScript('Add shape layer', `
  var comp = __aeRequireComp(${js(o.compRef ?? null)});
  var L = __aeAddShape(comp, ${js(o.shape)}, [${n(o.size[0])}, ${n(o.size[1])}], ${js(o.fillColor ?? (o.strokeColor ? null : '#FFFFFF'))}, ${js(o.strokeColor ?? null)}, ${n(o.strokeWidth ?? 0)}, ${n(o.roundness ?? 0)});
  ${o.name ? `L.name = ${js(o.name)};` : ''}
  __aeSetPosition(L, ${o.position ? `[${n(o.position[0])}, ${n(o.position[1])}]` : '[comp.width / 2, comp.height / 2]'});
  __aeTiming(L, ${o.inPoint !== undefined ? n(o.inPoint) : 'null'}, ${o.outPoint !== undefined ? n(o.outPoint) : 'null'});
  return __aeResult({ success: true, layer: __aeLayerInfo(L) });`);
}

export interface SolidLayerOptions {
  compRef?: string | number | undefined; kind: 'solid' | 'adjustment' | 'null'; name?: string | undefined; color?: string | undefined;
  width?: number | undefined; height?: number | undefined; inPoint?: number | undefined; outPoint?: number | undefined;
}

export function addSolidLayerScript(o: SolidLayerOptions): string {
  return aeScript(`Add ${o.kind} layer`, `
  var comp = __aeRequireComp(${js(o.compRef ?? null)});
  var L;
  if (${js(o.kind)} === "null") { L = comp.layers.addNull(); }
  else {
    L = comp.layers.addSolid(__aeHex(${js(o.color ?? (o.kind === 'adjustment' ? '#FFFFFF' : '#000000'))}), ${js(o.name ?? (o.kind === 'adjustment' ? 'Adjustment Layer' : 'Solid'))}, ${o.width ? Math.round(o.width) : 'comp.width'}, ${o.height ? Math.round(o.height) : 'comp.height'}, comp.pixelAspect);
    if (${js(o.kind)} === "adjustment") L.adjustmentLayer = true;
  }
  ${o.name ? `L.name = ${js(o.name)};` : ''}
  __aeTiming(L, ${o.inPoint !== undefined ? n(o.inPoint) : 'null'}, ${o.outPoint !== undefined ? n(o.outPoint) : 'null'});
  return __aeResult({ success: true, layer: __aeLayerInfo(L) });`);
}

export interface LayerProperties {
  name?: string | undefined; inPoint?: number | undefined; outPoint?: number | undefined; startTime?: number | undefined;
  enabled?: boolean | undefined; locked?: boolean | undefined; shy?: boolean | undefined; threeD?: boolean | undefined;
  parent?: string | number | null | undefined; blendingMode?: string | undefined; label?: number | undefined;
  moveTo?: 'top' | 'bottom' | undefined; position?: [number, number] | undefined; scale?: number | [number, number] | undefined;
  rotation?: number | undefined; opacity?: number | undefined; anchorPoint?: [number, number] | undefined;
  text?: string | undefined; color?: string | undefined; fontSize?: number | undefined; font?: string | undefined;
}

const BLEND_MODES = ['NORMAL', 'ADD', 'SCREEN', 'MULTIPLY', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'LIGHTEN', 'DARKEN', 'DIFFERENCE', 'COLOR_DODGE', 'COLOR_BURN', 'LINEAR_DODGE', 'LINEAR_BURN', 'LIGHTER_COLOR', 'DARKER_COLOR', 'VIVID_LIGHT', 'LINEAR_LIGHT', 'PIN_LIGHT', 'HARD_MIX', 'EXCLUSION', 'SUBTRACT', 'DIVIDE', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY', 'STENCIL_ALPHA', 'SILHOUETE_ALPHA'] as const;
export const AE_BLEND_MODES = BLEND_MODES;

export function setLayerPropertiesScript(compRef: string | number | undefined, layerRef: string | number, p: LayerProperties): string {
  const lines: string[] = [];
  const staticSet = (match: string, value: string): string =>
    `(function(){ var pr = L.property("ADBE Transform Group").property(${js(match)}); if (pr.numKeys > 0) warnings.push(${js(`${match} has keyframes; set a static value only on un-keyed properties (use ae_set_keyframes).`)}); else { var cur = pr.value; var v = ${value}; if (cur instanceof Array && v instanceof Array && cur.length === 3 && v.length === 2) v = [v[0], v[1], cur[2]]; pr.setValue(v); } })();`;
  if (p.locked === false) lines.push('L.locked = false;');
  if (p.name !== undefined) lines.push(`L.name = ${js(p.name)};`);
  if (p.startTime !== undefined) lines.push(`L.startTime = ${n(p.startTime)};`);
  if (p.inPoint !== undefined || p.outPoint !== undefined) lines.push(`__aeTiming(L, ${p.inPoint !== undefined ? n(p.inPoint) : 'null'}, ${p.outPoint !== undefined ? n(p.outPoint) : 'null'});`);
  if (p.enabled !== undefined) lines.push(`L.enabled = ${p.enabled};`);
  if (p.shy !== undefined) lines.push(`L.shy = ${p.shy};`);
  if (p.threeD !== undefined) lines.push(`L.threeDLayer = ${p.threeD};`);
  if (p.parent !== undefined) lines.push(p.parent === null ? 'L.parent = null;' : `L.parent = __aeRequireLayer(comp, ${js(p.parent)});`);
  if (p.blendingMode !== undefined) lines.push(`L.blendingMode = BlendingMode[${js(p.blendingMode.toUpperCase())}];`);
  if (p.label !== undefined) lines.push(`L.label = ${Math.round(p.label)};`);
  if (p.moveTo === 'top') lines.push('L.moveToBeginning();');
  if (p.moveTo === 'bottom') lines.push('L.moveToEnd();');
  if (p.anchorPoint) lines.push(staticSet('ADBE Anchor Point', `[${n(p.anchorPoint[0])}, ${n(p.anchorPoint[1])}]`));
  if (p.position) lines.push(staticSet('ADBE Position', `[${n(p.position[0])}, ${n(p.position[1])}]`));
  if (p.scale !== undefined) {
    const s = Array.isArray(p.scale) ? p.scale : [p.scale, p.scale];
    lines.push(staticSet('ADBE Scale', `[${n(s[0]!)}, ${n(s[1]!)}]`));
  }
  if (p.rotation !== undefined) lines.push(staticSet('ADBE Rotate Z', n(p.rotation)));
  if (p.opacity !== undefined) lines.push(staticSet('ADBE Opacity', n(p.opacity)));
  if (p.text !== undefined || p.color !== undefined || p.fontSize !== undefined || p.font !== undefined) {
    lines.push(`if (!(L instanceof TextLayer)) throw new Error("text, color, font and fontSize apply to text layers only.");`);
    lines.push(`warnings = warnings.concat(__aeStyleText(L, ${js({ text: p.text, color: p.color, fontSize: p.fontSize, font: p.font })}));`);
  }
  if (p.locked === true) lines.push('L.locked = true;');
  return aeScript('Set layer properties', `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var L = __aeRequireLayer(comp, ${js(layerRef)});
  var wasLocked = L.locked;
  if (wasLocked) L.locked = false;
  var warnings = [];
  ${lines.join('\n  ')}
  ${p.locked === undefined ? 'if (wasLocked) L.locked = true;' : ''}
  return __aeResult({ success: true, layer: __aeLayerInfo(L), warnings: warnings });`);
}

export function deleteLayersScript(compRef: string | number | undefined, layers: Array<string | number>, namePrefix: string | undefined): string {
  return aeScript('Delete layers', `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var removed = [];
  ${namePrefix ? `removed = __aeRemoveLayersWithPrefix(comp, ${js(namePrefix)});` : ''}
  var refs = ${js(layers)};
  var targets = [];
  for (var i = 0; i < refs.length; i++) { var L = __aeFindLayer(comp, refs[i]); if (L) targets.push(L); }
  for (var j = 0; j < targets.length; j++) { var name = targets[j].name; if (targets[j].locked) targets[j].locked = false; targets[j].remove(); removed.push(name); }
  return __aeResult({ success: true, removed: removed });`);
}

// ---------------------------------------------------------------- animation

export interface Keyframe { time: number; value: number | number[] | string }

export function setKeyframesScript(compRef: string | number | undefined, layerRef: string | number, property: string, keyframes: Keyframe[], interpolation: 'ease' | 'linear' | 'hold', influence: number, clear: boolean): string {
  const keys = keyframes.map((k) => `[${n(k.time)}, ${typeof k.value === 'string' ? `__aeHex(${js(k.value)})` : js(k.value)}]`).join(', ');
  return aeScript(`Keyframes on ${property}`, `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var L = __aeRequireLayer(comp, ${js(layerRef)});
  var prop = __aeProp(L, ${js(property)});
  var count = __aeSetKeys(prop, [${keys}], ${js(interpolation)}, ${n(influence)}, ${clear ? 'true' : 'false'});
  return __aeResult({ success: true, layer: L.name, property: prop.name, matchName: prop.matchName, numKeys: count });`);
}

export function setExpressionScript(compRef: string | number | undefined, layerRef: string | number, property: string, expression: string): string {
  return aeScript(`Expression on ${property}`, `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var L = __aeRequireLayer(comp, ${js(layerRef)});
  var prop = __aeProp(L, ${js(property)});
  if (!prop.canSetExpression) return __aeResult({ success: false, error: "Property '" + prop.name + "' cannot take an expression." });
  var err = __aeExpression(prop, ${js(expression)});
  return __aeResult({ success: err === "", layer: L.name, property: prop.name, expressionError: err || null });`);
}

export interface MicroMotionSpec { style: 'drift' | 'breathe' | 'sway' | 'float' | 'none'; amount?: number | undefined; speed?: number | undefined }

/** Gentle defaults: noticeable on a big screen, never fast or jumpy. `scale` is output height / 1080. */
export function microMotionDefaults(style: MicroMotionSpec['style'], scale: number): { amount: number; speed: number } {
  switch (style) {
    case 'drift': return { amount: 4 * scale, speed: 0.25 };
    case 'breathe': return { amount: 0.015, speed: 0.3 };
    case 'sway': return { amount: 1, speed: 0.2 };
    case 'float': return { amount: 5 * scale, speed: 0.5 };
    default: return { amount: 0, speed: 0 };
  }
}

export function microMotionScript(compRef: string | number | undefined, layers: Array<string | number>, spec: MicroMotionSpec): string {
  return aeScript('Micro-motion', `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var refs = ${js(layers)};
  var scale = comp.height / 1080;
  var style = ${js(spec.style)};
  var amount = ${spec.amount !== undefined ? n(spec.amount) : 'null'};
  var speed = ${spec.speed !== undefined ? n(spec.speed) : 'null'};
  var d = { drift: [4 * scale, 0.25], breathe: [0.015, 0.3], sway: [1, 0.2], float: [5 * scale, 0.5] };
  var applied = [], errors = [];
  for (var i = 0; i < refs.length; i++) {
    var L = __aeRequireLayer(comp, refs[i]);
    var a = amount !== null ? amount : (d[style] ? d[style][0] : 0);
    var f = speed !== null ? speed : (d[style] ? d[style][1] : 0);
    var err = __aeMicroMotion(L, style, a, f, (L.index * 1.37) % 6.283);
    if (err) errors.push({ layer: L.name, error: err }); else applied.push(L.name);
  }
  return __aeResult({ success: errors.length === 0, applied: applied, errors: errors });`);
}

// ---------------------------------------------------------------- per-element animation, shared by tools and the scene builder

export interface AnimationPlan {
  entry: string; // EntryPreset
  exit: string; // ExitPreset
  in: number;
  inDuration: number;
  revealEnd: number;
  exitStart: number;
  out: number;
  charKeys: Array<{ t: number; chars: number }>;
  totalChars: number;
  pixelSize: number;
  /** Output height / 1080, so motion distances look the same at any size. */
  scale: number;
}

/** Statements that animate layer `L` in comp `comp`. Assumes L's static position is already set. */
export function animationStatements(a: AnimationPlan): string {
  const s: string[] = [];
  const end = a.in + Math.max(a.inDuration, 0.05);
  const px = n(a.pixelSize);
  const coarse = n(a.pixelSize * 1.5);
  switch (a.entry) {
    case 'letter-reveal':
    case 'pixel-letter-reveal': {
      const keys = a.charKeys.length ? a.charKeys : [{ t: a.in, chars: 0 }, { t: end, chars: a.totalChars }];
      s.push(`if (L instanceof TextLayer) { __aeLetterReveal(L, [${keys.map((k) => `[${n(k.t)}, ${k.chars}]`).join(', ')}], ${a.totalChars}); } else { __aeOpacityKeys(L, [[${n(a.in)}, 0], [${n(end)}, 100]]); }`);
      if (a.entry === 'pixel-letter-reveal') s.push(`__aeMosaicKeys(L, comp, [[${n(a.in)}, ${px}], [${n(Math.max(a.revealEnd, a.in + 0.2))}, "fine"]]);`);
      break;
    }
    case 'pixel-letter-reveal-synced':
      // Letters are keyed separately (word-timed); only the pixel resolve is added here.
      s.push(`__aeMosaicKeys(L, comp, [[${n(a.in)}, ${px}], [${n(Math.max(a.revealEnd, a.in + 0.2))}, "fine"]]);`);
      break;
    case 'pixel-resolve':
      s.push(`__aeOpacityKeys(L, [[${n(a.in)}, 0], [${n(a.in + 0.12)}, 100]]);`);
      s.push(`__aeMosaicKeys(L, comp, [[${n(a.in)}, ${coarse}], [${n(end)}, "fine"]]);`);
      break;
    case 'fade-up':
      s.push(`__aeOpacityKeys(L, [[${n(a.in)}, 0], [${n(end)}, 100]]);`);
      s.push(`__aeOffsetKeys(L, [[${n(a.in)}, [0, ${n(30 * a.scale)}]], [${n(end)}, [0, 0]]]);`);
      break;
    case 'fade':
      s.push(`__aeOpacityKeys(L, [[${n(a.in)}, 0], [${n(end)}, 100]]);`);
      break;
    case 'pop':
      s.push(`__aeOpacityKeys(L, [[${n(a.in)}, 0], [${n(a.in + 0.08)}, 100]]);`);
      s.push(`__aeScaleKeys(L, [[${n(a.in)}, [0, 0]], [${n(a.in + a.inDuration * 0.65)}, [108, 108]], [${n(end)}, [100, 100]]]);`);
      break;
    case 'grow-x':
      s.push(`(function(){ var pos = L.property("ADBE Transform Group").property("ADBE Position").value; var r = __aeAnchorTo(L, "left", ${n(a.in)}); __aeSetPosition(L, [pos[0] - r.width / 2, pos[1]]); })();`);
      s.push(`__aeScaleKeys(L, [[${n(a.in)}, [0, 100]], [${n(end)}, [100, 100]]]);`);
      break;
    default:
      break;
  }
  const exitLen = Math.max(a.out - a.exitStart, 0.05);
  switch (a.exit) {
    case 'fade':
      s.push(`__aeOpacityKeys(L, [[${n(a.exitStart)}, 100], [${n(a.out)}, 0]]);`);
      break;
    case 'fade-down':
      s.push(`__aeOpacityKeys(L, [[${n(a.exitStart)}, 100], [${n(a.out)}, 0]]);`);
      s.push(`__aeOffsetKeys(L, [[${n(a.exitStart)}, [0, 0]], [${n(a.out)}, [0, ${n(20 * a.scale)}]]]);`);
      break;
    case 'pixel-out':
      s.push(`__aeMosaicKeys(L, comp, [[${n(a.exitStart)}, "fine"], [${n(a.out)}, ${coarse}]]);`);
      s.push(`__aeOpacityKeys(L, [[${n(Math.max(a.exitStart, a.out - Math.min(0.15, exitLen)))}, 100], [${n(a.out)}, 0]]);`);
      break;
    default:
      break;
  }
  return s.join('\n      ');
}

export interface AnimateLayerOptions {
  compRef?: string | number | undefined; layer: string | number; plan: AnimationPlan; micro?: MicroMotionSpec | undefined;
  /** Letter reveal synced to speech: one entry per on-screen word, in order. Keys are computed from the layer's own text. */
  wordTimes?: Array<{ start: number; end: number }> | undefined;
}

/** ES3 that replaces the letter-reveal keys with ones built from the layer text and word times. */
function wordTimedRevealStatements(wordTimes: Array<{ start: number; end: number }>): string {
  return `(function(){
    if (!(L instanceof TextLayer)) return;
    var text = String(__aeTextDocProp(L).value.text);
    var parts = text.split(/\\s+/), lens = [], total = 0;
    for (var i = 0; i < parts.length; i++) { if (parts[i] === "") continue; lens.push(parts[i].length); total += parts[i].length; }
    var times = ${js(wordTimes)};
    var keys = [], cum = 0, last = -1;
    for (var w = 0; w < lens.length; w++) {
      var wt = times[Math.min(w, times.length - 1)];
      var s = Math.max(wt.start, last), span = Math.min(Math.max(wt.end - wt.start, 0.08), Math.max(0.08, lens[w] * 0.045));
      if (s > last) keys.push([s, cum]);
      cum += lens[w];
      var e = Math.max(s + span, s + comp.frameDuration);
      keys.push([e, cum]); last = e;
    }
    __aeLetterReveal(L, keys, total);
  })();`;
}

export function animateLayerScript(o: AnimateLayerOptions): string {
  const micro = o.micro && o.micro.style !== 'none'
    ? (() => { const d = microMotionDefaults(o.micro.style, o.plan.scale); return `microError = __aeMicroMotion(L, ${js(o.micro.style)}, ${n(o.micro.amount ?? d.amount)}, ${n(o.micro.speed ?? d.speed)}, (L.index * 1.37) % 6.283);`; })()
    : '';
  const synced = o.wordTimes?.length && (o.plan.entry === 'letter-reveal' || o.plan.entry === 'pixel-letter-reveal');
  const plan: AnimationPlan = synced ? { ...o.plan, entry: o.plan.entry === 'pixel-letter-reveal' ? 'pixel-letter-reveal-synced' : 'none' } : o.plan;
  return aeScript('Animate layer', `
  var comp = __aeRequireComp(${js(o.compRef ?? null)});
  var L = __aeRequireLayer(comp, ${js(o.layer)});
  var microError = "";
  ${synced ? wordTimedRevealStatements(o.wordTimes!) : ''}
  ${animationStatements(plan)}
  ${micro}
  return __aeResult({ success: true, layer: __aeLayerInfo(L), microMotionError: microError || null });`);
}

// ---------------------------------------------------------------- effects & markers

export function applyEffectScript(compRef: string | number | undefined, layerRef: string | number, effect: string, params: Record<string, unknown>, keyframes: Record<string, Keyframe[]>, reuseExisting: boolean): string {
  const paramLines = Object.entries(params).map(([k, v]) => `__aeSetParam(__aeEffectParam(fx, ${js(/^[0-9]+$/.test(k) ? Number(k) : k)}), ${typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v) ? `__aeHex(${js(v)})` : js(v)});`);
  const keyLines = Object.entries(keyframes).map(([k, keys]) => `__aeSetKeys(__aeEffectParam(fx, ${js(/^[0-9]+$/.test(k) ? Number(k) : k)}), [${keys.map((kf) => `[${n(kf.time)}, ${typeof kf.value === 'string' ? `__aeHex(${js(kf.value)})` : js(kf.value)}]`).join(', ')}], "ease", 70, true);`);
  return aeScript(`Apply ${effect}`, `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var L = __aeRequireLayer(comp, ${js(layerRef)});
  var fx = ${reuseExisting ? `__aeFindEffect(L, ${js(effect)}) || ` : ''}__aeAddEffect(L, ${js(effect)});
  ${paramLines.join('\n  ')}
  ${keyLines.join('\n  ')}
  return __aeResult({ success: true, layer: L.name, effect: fx.name, matchName: fx.matchName, params: __aeEffectParams(fx) });`);
}

export interface MarkerSpec { time: number; comment: string; duration?: number | undefined; label?: number | undefined }

export function addMarkersScript(compRef: string | number | undefined, markers: MarkerSpec[]): string {
  return aeScript('Add markers', `
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var added = 0;
  ${markers.map((m) => `if (__aeMarker(comp, ${n(m.time)}, ${js(m.comment)}, ${n(m.duration ?? 0)}, ${m.label !== undefined ? Math.round(m.label) : 'null'})) added++;`).join('\n  ')}
  return __aeResult({ success: true, added: added, total: comp.markerProperty.numKeys });`);
}

// ---------------------------------------------------------------- review & render

export function saveFramesScript(compRef: string | number | undefined, frames: Array<{ time: number; path: string }>): string {
  return aeReadScript(`
  var comp = __aeRequireComp(${js(compRef ?? null)});
  var frames = ${js(frames)};
  var results = [];
  var direct = (typeof comp.saveFrameToPng === "function");
  for (var i = 0; i < frames.length; i++) {
    var fr = frames[i];
    var f = new File(fr.path);
    if (f.parent && !f.parent.exists) f.parent.create();
    if (direct) {
      try { comp.saveFrameToPng(fr.time, f); results.push({ time: fr.time, path: fr.path, method: "saveFrameToPng" }); continue; } catch (e1) { direct = false; }
    }
    var rq = app.project.renderQueue;
    var item = rq.items.add(comp);
    try {
      item.timeSpanStart = fr.time;
      item.timeSpanDuration = comp.frameDuration;
      var om = item.outputModule(1);
      var tpls = om.templates, chosen = null;
      for (var t = 0; t < tpls.length && !chosen; t++) if (/png/i.test(tpls[t])) chosen = tpls[t];
      if (!chosen) throw new Error("No PNG output module template is available.");
      om.applyTemplate(chosen);
      var base = fr.path.replace(/\.png$/i, "");
      om.file = new File(base + "_[#####].png");
      rq.render();
      results.push({ time: fr.time, path: base + "_" + "#####" + ".png", pattern: true, method: "renderQueue" });
    } finally {
      try { item.remove(); } catch (eRm) {}
    }
  }
  return __aeResult({ success: true, frames: results });`);
}

export interface RenderOptions {
  compRef?: string | number | undefined; outputPath: string; format: 'h264' | 'prores' | 'prores4444' | 'png-sequence';
  template?: string | undefined; useMediaEncoder: boolean; workAreaOnly: boolean; startRender: boolean;
}

export function renderScript(o: RenderOptions): string {
  const preferences: Record<RenderOptions['format'], string[]> = {
    h264: ['^H\\.264 - Match Render Settings - 15', '^H\\.264 - Match Render Settings', '^H\\.264'],
    prores: ['ProRes 422 HQ', 'ProRes 422', 'High Quality$'],
    prores4444: ['ProRes 4444', 'High Quality with Alpha', 'Lossless with Alpha'],
    'png-sequence': ['^PNG'],
  };
  return aeReadScript(`
  var comp = __aeRequireComp(${js(o.compRef ?? null)});
  var rq = app.project.renderQueue;
  if (rq.rendering) return __aeResult({ success: false, retry: true, error: "After Effects is already rendering. Wait for it to finish." });
  var item = rq.items.add(comp);
  try { item.applyTemplate("Best Settings"); } catch (eRs) {}
  if (${o.workAreaOnly ? 'false' : 'true'}) { try { item.timeSpanStart = 0; item.timeSpanDuration = comp.duration; } catch (eSpan) {} }
  var om = item.outputModule(1);
  var tpls = om.templates;
  var chosen = ${js(o.template ?? null)};
  var wanted = ${js(preferences[o.format])};
  if (!chosen) {
    for (var w = 0; w < wanted.length && !chosen; w++) { var re = new RegExp(wanted[w], "i"); for (var t = 0; t < tpls.length; t++) if (re.test(tpls[t])) { chosen = tpls[t]; break; } }
  }
  if (!chosen) {
    item.remove();
    return __aeResult({ success: false, retry: false, error: "No output module template matches ${o.format}. Pass template with one of: " + tpls.join(", "), templates: tpls });
  }
  om.applyTemplate(chosen);
  var out = new File(${js(o.outputPath)});
  if (out.parent && !out.parent.exists) out.parent.create();
  om.file = out;
  var finalPath = om.file ? om.file.fsName : ${js(o.outputPath)};
  if (${o.useMediaEncoder ? 'true' : 'false'}) {
    try { rq.queueInAME(true); } catch (eAme) { return __aeResult({ success: false, error: "Could not send to Adobe Media Encoder: " + String(eAme) }); }
    return __aeResult({ success: true, status: "queued_in_media_encoder", outputPath: finalPath, template: chosen });
  }
  if (!${o.startRender ? 'true' : 'false'}) return __aeResult({ success: true, status: "queued", outputPath: finalPath, template: chosen });
  var started = new Date().getTime();
  rq.render();
  var status = "unknown";
  try { status = item.status === RQItemStatus.DONE ? "done" : String(item.status); } catch (eSt) {}
  return __aeResult({ success: status === "done", status: status, outputPath: finalPath, template: chosen, seconds: Math.round((new Date().getTime() - started) / 1000) });`);
}

export function runScript(script: string): string {
  // Caller-authored body: wrapped like every other command so it gets the helpers,
  // an undo group and dialog suppression, but otherwise passed through untouched.
  return aeScript('Run script', script);
}

// ---------------------------------------------------------------- storyboard: setup and scene build

export interface SetupOptions {
  compName: string; footagePath: string; output: Storyboard['output']; duration: number | null; background?: string | undefined;
  markers: MarkerSpec[];
  /** Save the project here even if it was already saved elsewhere ("Save As"). */
  projectPath?: string | undefined;
  /** Save here only when the open project has never been saved. */
  defaultProjectPath?: string | undefined;
  reuseComp: boolean;
}

export function setupFromStoryboardScript(o: SetupOptions): string {
  return aeScript('Set up storyboard comp', `
  var footage = __aeImportFile(${js(o.footagePath)}, false);
  var folder = __aeFolder("Footage");
  if (folder && footage.parentFolder !== folder) footage.parentFolder = folder;
  var duration = ${o.duration !== null ? n(o.duration) : 'footage.duration'};
  var comp = null;
  if (${o.reuseComp ? 'true' : 'false'}) comp = __aeFindComp(${js(o.compName)});
  var created = false;
  if (!comp) {
    comp = app.project.items.addComp(${js(o.compName)}, ${Math.round(o.output.width)}, ${Math.round(o.output.height)}, 1, duration, ${n(o.output.fps)});
    created = true;
  }
  ${o.background ? `comp.bgColor = __aeHex(${js(o.background)});` : ''}
  var bg = __aeFindLayer(comp, "BG_raw_footage");
  if (!bg) {
    bg = comp.layers.add(footage);
    bg.name = "BG_raw_footage";
    bg.startTime = 0;
    bg.moveToEnd();
    if (footage.width && footage.height) {
      var s = Math.max(comp.width / footage.width, comp.height / footage.height) * 100;
      bg.property("ADBE Transform Group").property("ADBE Scale").setValue([s, s]);
    }
    bg.locked = true;
  }
  var added = 0;
  ${o.markers.map((m) => `if (__aeMarker(comp, ${n(m.time)}, ${js(m.comment)}, ${n(m.duration ?? 0)}, ${m.label !== undefined ? Math.round(m.label) : 'null'})) added++;`).join('\n  ')}
  try { comp.openInViewer(); } catch (eOpen) {}
  var saved = null;
  var savePath = ${o.projectPath ? js(o.projectPath) : o.defaultProjectPath ? `(app.project.file ? null : ${js(o.defaultProjectPath)})` : 'null'};
  if (savePath) { try { var pf = new File(savePath); if (pf.parent && !pf.parent.exists) pf.parent.create(); app.project.save(pf); } catch (eSave) { saved = "error: " + String(eSave); } }
  if (!saved && app.project.file) saved = app.project.file.fsName;
  return __aeResult({ success: true, compCreated: created, comp: __aeCompInfo(comp), footage: { id: footage.id, name: footage.name, duration: __aeRound(footage.duration), width: footage.width, height: footage.height, frameRate: footage.frameRate, hasAudio: footage.hasAudio }, markersAdded: added, projectSavedTo: saved });`);
}

export interface SceneBuildOptions {
  compRef: string | number;
  beat: ResolvedBeat;
  output: Storyboard['output'];
  pixelSize: number;
  replace: boolean;
  /** Absolute paths for media elements, keyed by element id. */
  mediaPaths: Record<string, string>;
}

function elementBlock(el: ResolvedElement, o: SceneBuildOptions, index: number): string {
  const e = el.element;
  const W = o.output.width;
  const H = o.output.height;
  const scale = H / 1080;
  const x = e.x * W;
  const y = e.y * H;
  let create: string;
  if (e.kind === 'text') {
    const anchor = e.align === 'left' ? 'left' : e.align === 'right' ? 'right' : 'center';
    create = `L = comp.layers.addText(${js(e.text ?? '')});
      L.name = ${js(el.layerName)};
      warnings = warnings.concat(__aeStyleText(L, ${js({
        font: el.font?.postscript, fontSize: el.size, color: el.color, strokeColor: e.strokeColor, strokeWidth: e.strokeWidth,
        tracking: e.tracking, justification: e.align ?? 'center', allCaps: e.allCaps,
      })}));
      __aeTiming(L, ${n(el.timing.in)}, ${n(el.timing.out)});
      __aeAnchorTo(L, ${js(anchor)}, ${n(Math.max(el.timing.revealEnd, el.timing.in))});
      __aeSetPosition(L, [${n(x)}, ${n(y)}]);`;
  } else if (e.kind === 'shape') {
    const w = (e.width ?? 0.2) * W;
    const h = e.shape === 'underline' ? Math.max(4 * scale, (e.height ?? 0.008) * H) : (e.height ?? (e.width ?? 0.2) * (W / H)) * H;
    create = `L = __aeAddShape(comp, ${js(e.shape === 'ellipse' ? 'ellipse' : 'rectangle')}, [${n(w)}, ${n(h)}], ${js(e.fill ?? el.color)}, ${js(e.strokeColor ?? null)}, ${n(e.strokeWidth ?? 0)}, ${n(e.roundness ?? (e.shape === 'underline' ? h / 2 : 0))});
      L.name = ${js(el.layerName)};
      __aeSetPosition(L, [${n(x)}, ${n(y)}]);
      __aeTiming(L, ${n(el.timing.in)}, ${n(el.timing.out)});`;
  } else {
    const path = o.mediaPaths[e.id];
    create = `var item = __aeImportFile(${js(path ?? '')}, ${e.sequence ? 'true' : 'false'});
      var mf = __aeFolder("Elements"); if (mf && item.parentFolder !== mf) item.parentFolder = mf;
      L = comp.layers.add(item);
      L.name = ${js(el.layerName)};
      L.startTime = ${n(el.timing.in)};
      try { __aeTiming(L, ${n(el.timing.in)}, ${n(el.timing.out)}); } catch (eT) { warnings.push(${js(`${el.layerName}: media is shorter than its beat; it ends early.`)}); }
      if (item.width) { var ms = (${n((e.width ?? 0.3) * W)} / item.width) * 100; L.property("ADBE Transform Group").property("ADBE Scale").setValue([ms, ms]); }
      __aeSetPosition(L, [${n(x)}, ${n(y)}]);`;
  }
  const plan: AnimationPlan = {
    entry: el.animIn, exit: el.animOut, in: el.timing.in, inDuration: el.timing.inDuration, revealEnd: el.timing.revealEnd,
    exitStart: el.timing.exitStart, out: el.timing.out, charKeys: el.timing.charKeys, totalChars: el.timing.totalChars,
    pixelSize: o.pixelSize * scale, scale,
  };
  const d = microMotionDefaults(el.microMotion, scale);
  const micro = el.microMotion !== 'none'
    ? `var me = __aeMicroMotion(L, ${js(el.microMotion)}, ${n(d.amount)}, ${n(d.speed)}, ${n((index * 1.37) % 6.283)}); if (me) warnings.push(${js(`${el.layerName} micro-motion: `)} + me);`
    : '';
  return `
  (function () {
    var L = null;
    try {
      ${create}
      ${animationStatements(plan)}
      ${micro}
      created.push(L.name);
    } catch (err) {
      failed.push({ element: ${js(e.id)}, layer: ${js(el.layerName)}, error: String(err && err.message ? err.message : err), line: (err && err.line) ? err.line : null });
      if (L) { try { L.remove(); } catch (eRm) {} }
    }
  })();`;
}

export function buildSceneScript(o: SceneBuildOptions): string {
  const beat = o.beat.beat;
  const scale = o.output.height / 1080;
  // Later layers stack on top, so create in element order: the first element ends up lowest.
  const blocks = o.beat.elements.map((el, i) => elementBlock(el, o, i)).join('\n');
  const flash = o.beat.transition.type === 'pixel-flash' && o.beat.transition.duration > 0
    ? (() => {
      const d = o.beat.transition.duration;
      const a = Math.max(0, beat.end - d / 2);
      const b = beat.end + d / 2;
      return `
  (function () {
    try {
      var A = comp.layers.addSolid([1, 1, 1], ${js(`${beat.id}_transition_pixel`)}, comp.width, comp.height, comp.pixelAspect);
      A.adjustmentLayer = true;
      __aeTiming(A, ${n(a)}, ${n(Math.min(b, 1e6))});
      var L = A;
      __aeMosaicKeys(L, comp, [[${n(a)}, "fine"], [${n(beat.end)}, ${n(o.pixelSize * scale * 3)}], [${n(b)}, "fine"]]);
      A.moveToBeginning();
      created.push(A.name);
    } catch (err) { failed.push({ element: "transition", error: String(err && err.message ? err.message : err) }); }
  })();`;
    })()
    : '';
  return aeScript(`Build ${beat.id} ${beat.name}`, `
  var comp = __aeRequireComp(${js(o.compRef)});
  var created = [], failed = [], warnings = [], removed = [];
  ${o.replace ? `removed = __aeRemoveLayersWithPrefix(comp, ${js(`${beat.id}_`)});` : ''}
  __aeMarker(comp, ${n(beat.start)}, ${js(`${beat.id} ${beat.name}`)}, ${n(beat.end - beat.start)}, null);
  ${blocks}
  ${flash}
  var bg = __aeFindLayer(comp, "BG_raw_footage");
  if (bg) { var wasLocked = bg.locked; if (wasLocked) bg.locked = false; bg.moveToEnd(); if (wasLocked) bg.locked = true; }
  comp.time = ${n(Math.min(beat.end, Math.max(beat.start, (beat.start + beat.end) / 2)))};
  return __aeResult({ success: failed.length === 0, beat: ${js(beat.id)}, created: created, failed: failed, removed: removed, warnings: warnings });`);
}
