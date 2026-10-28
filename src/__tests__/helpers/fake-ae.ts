/**
 * A small fake of the After Effects scripting DOM, for running generated
 * ExtendScript in Node.
 *
 * It is not After Effects. It models the parts the AE tools touch: 1-based
 * collections, property groups found by match name or display name, keyframes,
 * temporal ease (including After Effects' rule that the ease array length must
 * match the property's dimensions), text animators, shape groups, effects,
 * markers, layers and the render queue. Where real After Effects throws, it
 * throws the same way, so a script that mis-addresses the DOM fails here too.
 */
import vm from 'node:vm';
import { writeFileSync } from 'node:fs';

type Value = unknown;

const SPATIAL_2D = 6413;
const SPATIAL_3D = 6412;
const TWO_D = 6415;
const ONE_D = 6417;
const COLOR = 6418;
const NO_VALUE = 6420;
const CUSTOM = 6419;

export class FakeProperty {
  name: string;
  matchName: string;
  parentProperty: FakeGroup | null = null;
  keys: Array<{ t: number; v: Value; inType?: number; outType?: number; easeIn?: unknown[]; easeOut?: unknown[] }> = [];
  expression = '';
  expressionError = '';
  propertyValueType: number;
  canVaryOverTime = true;
  canSetExpression = true;
  private _value: Value;
  constructor(matchName: string, name: string, value: Value, type?: number) {
    this.matchName = matchName;
    this.name = name;
    this._value = value;
    this.propertyValueType = type ?? (Array.isArray(value) ? (value.length === 3 ? SPATIAL_3D : TWO_D) : ONE_D);
  }
  get propertyIndex(): number { return this.parentProperty ? this.parentProperty.children.indexOf(this) + 1 : 0; }
  get numKeys(): number { return this.keys.length; }
  get value(): Value {
    const v = this.keys.length ? this.keys[0]!.v : this._value;
    // After Effects hands back a copy of a TextDocument; editing it changes nothing until setValue.
    return v instanceof FakeTextDocument ? Object.assign(new FakeTextDocument(v.text), v) : v;
  }
  setValue(v: Value): void {
    if (this.keys.length) throw new Error(`Can't set value of '${this.name}': it has keyframes`);
    this.check(v);
    this._value = v;
  }
  setValueAtTime(t: number, v: Value): void {
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error('setValueAtTime: time must be a number');
    this.check(v);
    const existing = this.keys.find((k) => Math.abs(k.t - t) < 1e-9);
    if (existing) existing.v = v; else { this.keys.push({ t, v }); this.keys.sort((a, b) => a.t - b.t); }
  }
  valueAtTime(t: number): Value {
    if (!this.keys.length) return this._value;
    let best = this.keys[0]!;
    for (const k of this.keys) if (k.t <= t) best = k;
    return best.v;
  }
  removeKey(i: number): void { this.keyCheck(i); this.keys.splice(i - 1, 1); }
  keyTime(i: number): number { this.keyCheck(i); return this.keys[i - 1]!.t; }
  keyValue(i: number): Value { this.keyCheck(i); return this.keys[i - 1]!.v; }
  setInterpolationTypeAtKey(i: number, inType: number, outType: number): void {
    this.keyCheck(i);
    if (inType === undefined || outType === undefined) throw new Error('interpolation type undefined');
    this.keys[i - 1]!.inType = inType; this.keys[i - 1]!.outType = outType;
  }
  setTemporalEaseAtKey(i: number, easeIn: unknown[], easeOut: unknown[]): void {
    this.keyCheck(i);
    const dims = this.propertyValueType === SPATIAL_2D || this.propertyValueType === SPATIAL_3D ? 1 : (Array.isArray(this._value) ? this._value.length : 1);
    if (!Array.isArray(easeIn) || easeIn.length !== dims || !Array.isArray(easeOut) || easeOut.length !== dims) {
      throw new Error(`setTemporalEaseAtKey on '${this.name}': ease arrays must have ${dims} entries`);
    }
    this.keys[i - 1]!.easeIn = easeIn; this.keys[i - 1]!.easeOut = easeOut;
  }
  private keyCheck(i: number): void { if (!(i >= 1 && i <= this.keys.length)) throw new Error(`Key index ${i} out of range on '${this.name}'`); }
  private check(v: Value): void {
    if (this.propertyValueType === NO_VALUE) throw new Error(`'${this.name}' has no value`);
    if (Array.isArray(this._value) && this.propertyValueType !== CUSTOM && this.propertyValueType !== COLOR) {
      if (!Array.isArray(v)) throw new Error(`'${this.name}' needs an array value, got ${String(v)}`);
      if ((v as unknown[]).some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new Error(`'${this.name}' got a non-number in ${JSON.stringify(v)}`);
      if (this.propertyValueType !== TWO_D && (v as unknown[]).length !== (this._value as unknown[]).length) throw new Error(`'${this.name}' value has the wrong number of dimensions`);
    } else if (this.propertyValueType === ONE_D && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`'${this.name}' needs a number, got ${JSON.stringify(v)}`);
    }
  }
}

type Factory = () => FakeProperty | FakeGroup;

export class FakeGroup {
  name: string;
  matchName: string;
  parentProperty: FakeGroup | null = null;
  children: Array<FakeProperty | FakeGroup> = [];
  enabled = true;
  private addable: Record<string, Factory>;
  constructor(matchName: string, name: string, children: Array<FakeProperty | FakeGroup> = [], addable: Record<string, Factory> = {}) {
    this.matchName = matchName;
    this.name = name;
    this.addable = addable;
    for (const c of children) this.adopt(c);
  }
  private adopt(c: FakeProperty | FakeGroup): void { c.parentProperty = this; this.children.push(c); }
  get numProperties(): number { return this.children.length; }
  get propertyIndex(): number { return this.parentProperty ? this.parentProperty.children.indexOf(this) + 1 : 0; }
  property(ref: string | number): FakeProperty | FakeGroup | null {
    if (typeof ref === 'number') return this.children[ref - 1] ?? null;
    return this.children.find((c) => c.matchName === ref) ?? this.children.find((c) => c.name === ref) ?? null;
  }
  canAddProperty(name: string): boolean { return name in this.addable; }
  addProperty(name: string): FakeProperty | FakeGroup {
    const f = this.addable[name];
    if (!f) throw new Error(`Can't add '${name}' to '${this.name}'`);
    const c = f();
    this.adopt(c);
    return c;
  }
}

const P = (m: string, n: string, v: Value, t?: number) => new FakeProperty(m, n, v, t);
const G = (m: string, n: string, c: Array<FakeProperty | FakeGroup> = [], a: Record<string, Factory> = {}) => new FakeGroup(m, n, c, a);

const EFFECTS: Record<string, Factory> = {
  'ADBE Mosaic': () => G('ADBE Mosaic', 'Mosaic', [P('ADBE Mosaic-0001', 'Horizontal Blocks', 10), P('ADBE Mosaic-0002', 'Vertical Blocks', 10), P('ADBE Mosaic-0003', 'Sharp Colors', 0)]),
  'ADBE Gaussian Blur 2': () => G('ADBE Gaussian Blur 2', 'Gaussian Blur', [P('ADBE Gaussian Blur 2-0001', 'Blurriness', 0), P('ADBE Gaussian Blur 2-0002', 'Blur Dimensions', 1), P('ADBE Gaussian Blur 2-0003', 'Repeat Edge Pixels', 0), P('ADBE Gaussian Blur 2-0004', 'Color', [1, 1, 1, 1], COLOR)]),
};
EFFECTS['Mosaic'] = EFFECTS['ADBE Mosaic']!;
EFFECTS['Gaussian Blur'] = EFFECTS['ADBE Gaussian Blur 2']!;

function transform(position: number[]): FakeGroup {
  return G('ADBE Transform Group', 'Transform', [
    P('ADBE Anchor Point', 'Anchor Point', [0, 0], SPATIAL_2D),
    P('ADBE Position', 'Position', position, SPATIAL_2D),
    P('ADBE Scale', 'Scale', [100, 100], TWO_D),
    P('ADBE Rotate Z', 'Rotation', 0),
    P('ADBE Opacity', 'Opacity', 100),
  ]);
}

export class FakeTextDocument {
  text: string; font = 'ArialMT'; fontSize = 36; applyFill = true; fillColor = [1, 1, 1]; applyStroke = false;
  strokeColor = [0, 0, 0]; strokeWidth = 0; strokeOverFill = false; tracking = 0; leading = 0; autoLeading = true;
  justification = 7413; allCaps = false;
  constructor(text: string) { this.text = text; }
}

function textProperties(text: string, installedFonts: Set<string>): FakeGroup {
  const doc = P('ADBE Text Document', 'Source Text', new FakeTextDocument(text), CUSTOM);
  const original = doc.setValue.bind(doc);
  doc.setValue = (v: Value) => {
    const td = v as FakeTextDocument;
    if (!(td instanceof FakeTextDocument)) throw new Error('Source Text needs a TextDocument');
    // After Effects keeps the old font when asked for one that is not installed.
    if (!installedFonts.has(td.font)) td.font = (doc.value as FakeTextDocument).font;
    original(Object.assign(new FakeTextDocument(td.text), td));
  };
  const selector = (): FakeGroup => G('ADBE Text Selector', 'Range Selector 1', [
    P('ADBE Text Percent Start', 'Start', 0),
    P('ADBE Text Percent End', 'End', 100),
    G('ADBE Text Range Advanced', 'Advanced', [P('ADBE Text Range Type2', 'Based On', 1), P('ADBE Text Selector Smoothness', 'Smoothness', 100)]),
  ]);
  const animator = (): FakeGroup => G('ADBE Text Animator', 'Animator 1', [
    G('ADBE Text Selectors', 'Selectors', [], { 'ADBE Text Selector': selector }),
    G('ADBE Text Animator Properties', 'Properties', [], { 'ADBE Text Opacity': () => P('ADBE Text Opacity', 'Opacity', 100) }),
  ]);
  return G('ADBE Text Properties', 'Text', [doc, G('ADBE Text Animators', 'Animators', [], { 'ADBE Text Animator': animator })]);
}

function shapeContents(): FakeGroup {
  const inner = (): FakeGroup => G('ADBE Vectors Group', 'Contents', [], {
    'ADBE Vector Shape - Rect': () => G('ADBE Vector Shape - Rect', 'Rectangle Path 1', [P('ADBE Vector Rect Size', 'Size', [100, 100], TWO_D), P('ADBE Vector Rect Roundness', 'Roundness', 0)]),
    'ADBE Vector Shape - Ellipse': () => G('ADBE Vector Shape - Ellipse', 'Ellipse Path 1', [P('ADBE Vector Ellipse Size', 'Size', [100, 100], TWO_D)]),
    'ADBE Vector Graphic - Fill': () => G('ADBE Vector Graphic - Fill', 'Fill 1', [P('ADBE Vector Fill Color', 'Color', [1, 0, 0, 1], COLOR)]),
    'ADBE Vector Graphic - Stroke': () => G('ADBE Vector Graphic - Stroke', 'Stroke 1', [P('ADBE Vector Stroke Color', 'Color', [1, 1, 1, 1], COLOR), P('ADBE Vector Stroke Width', 'Stroke Width', 2)]),
  });
  return G('ADBE Root Vectors Group', 'Contents', [], { 'ADBE Vector Group': () => G('ADBE Vector Group', 'Group 1', [inner()]) });
}

export function createFakeAe(options: { fonts?: string[]; saveFrameToPng?: boolean } = {}) {
  const fonts = new Set(['ArialMT', ...(options.fonts ?? ['Inter-Bold', 'InstrumentSerif-Italic'])]);
  const log: string[] = [];
  let nextId = 1;
  let undoDepth = 0;

  class FakeItem { id = nextId++; name = ''; parentFolder: unknown = null; typeName = 'Item'; remove() { project.items.list.splice(project.items.list.indexOf(this as never), 1); } }
  class FolderItem extends FakeItem { typeName = 'Folder'; constructor(name: string) { super(); this.name = name; } }
  class SolidSource {}
  class FileSource { isStill: boolean; constructor(still: boolean) { this.isStill = still; } }
  class FootageItem extends FakeItem {
    typeName = 'Footage'; width = 1920; height = 1080; duration = 7; frameRate = 30; hasAudio = true; hasVideo = true;
    file: FakeFile | null; mainSource: unknown;
    constructor(file: FakeFile | null, still = false, solid = false) {
      super(); this.file = file; this.name = file ? file.name : 'Solid';
      this.mainSource = solid ? new SolidSource() : new FileSource(still);
      if (still) this.duration = 0;
    }
  }
  class AVLayer {
    declare inPoint: number;
    name: string; index = 0; startTime = 0; enabled = true; shy = false; label = 0; parent: AVLayer | null = null;
    threeDLayer = false; adjustmentLayer = false; nullLayer = false; blendingMode = 0; source: unknown = null; containingComp: CompItem;
    groups: FakeGroup[];
    private _out: number; private _locked = false;
    constructor(comp: CompItem, name: string, groups: FakeGroup[]) {
      this.containingComp = comp; this.name = name; this._out = comp.duration;
      this.groups = [transform([comp.width / 2, comp.height / 2]), G('ADBE Effect Parade', 'Effects', [], EFFECTS), ...groups];
    }
    get locked() { return this._locked; }
    set locked(v: boolean) { this._locked = v; }
    get outPoint() { return this._out; }
    set outPoint(v: number) { this.guard(); if (v <= this.inPoint) throw new Error('outPoint must be after inPoint'); this._out = v; }
    property(ref: string | number) { return typeof ref === 'number' ? this.groups[ref - 1] ?? null : this.groups.find((g) => g.matchName === ref || g.name === ref) ?? null; }
    sourceRectAtTime() { return { left: -150, top: -40, width: 300, height: 80 }; }
    moveToEnd() { this.guard(); const l = this.containingComp.layerList; l.splice(l.indexOf(this), 1); l.push(this); this.containingComp.reindex(); }
    moveToBeginning() { this.guard(); const l = this.containingComp.layerList; l.splice(l.indexOf(this), 1); l.unshift(this); this.containingComp.reindex(); }
    remove() { this.guard(); const l = this.containingComp.layerList; l.splice(l.indexOf(this), 1); this.containingComp.reindex(); }
    guard() { if (this._locked) throw new Error(`Layer '${this.name}' is locked`); }
  }
  // inPoint has the same rule as outPoint.
  Object.defineProperty(AVLayer.prototype, 'inPoint', {
    get(this: any) { return this._in ?? 0; },
    set(this: any, v: number) { if (this._locked) throw new Error(`Layer '${this.name}' is locked`); if (this._out !== undefined && v >= this._out) throw new Error('inPoint must be before outPoint'); this._in = v; },
  });
  class TextLayer extends AVLayer {}
  class ShapeLayer extends AVLayer {}
  class CameraLayer extends AVLayer {}
  class LightLayer extends AVLayer {}

  class MarkerValue { comment: string; duration = 0; label = 0; constructor(c: string) { this.comment = c; } }

  class CompItem extends FakeItem {
    typeName = 'Composition'; width: number; height: number; pixelAspect: number; duration: number; frameRate: number;
    bgColor = [0, 0, 0]; workAreaStart = 0; workAreaDuration: number; motionBlur = false; time = 0; layerList: AVLayer[] = [];
    markerProperty = P('ADBE Marker', 'Marker', null, CUSTOM);
    framesSaved: Array<{ t: number; path: string }> = [];
    constructor(name: string, w: number, h: number, pa: number, d: number, fps: number) {
      super(); this.name = name; this.width = w; this.height = h; this.pixelAspect = pa; this.duration = d; this.frameRate = fps; this.workAreaDuration = d;
      this.markerProperty.propertyValueType = CUSTOM;
    }
    get frameDuration() { return 1 / this.frameRate; }
    get numLayers() { return this.layerList.length; }
    reindex() { this.layerList.forEach((l, i) => { l.index = i + 1; }); }
    layer(ref: number | string) { return typeof ref === 'number' ? this.layerList[ref - 1] ?? null : this.layerList.find((l) => l.name === ref) ?? null; }
    openInViewer() { log.push(`open ${this.name}`); }
    declare saveFrameToPng?: (t: number, f: FakeFile) => void;
    layers = {
      addText: (text: string) => this.push(new TextLayer(this, text, [textProperties(text, fonts)])),
      addBoxText: (_size: number[], text: string) => this.push(new TextLayer(this, text, [textProperties(text, fonts)])),
      addShape: () => this.push(new ShapeLayer(this, 'Shape Layer 1', [shapeContents()])),
      addSolid: (color: number[], name: string) => { const l = new AVLayer(this, name, []); l.source = new FootageItem(null, false, true); (l.source as FootageItem).name = name; if (!Array.isArray(color) || color.length !== 3) throw new Error('addSolid colour must be [r,g,b]'); return this.push(l); },
      addNull: () => { const l = new AVLayer(this, 'Null 1', []); l.nullLayer = true; return this.push(l); },
      add: (item: FootageItem | CompItem) => { if (!item) throw new Error('layers.add needs an item'); const l = new AVLayer(this, item.name, []); l.source = item; if (item instanceof FootageItem) l.outPoint = Math.min(this.duration, item.duration || this.duration); return this.push(l); },
    };
    private push(l: AVLayer) { this.layerList.unshift(l); this.reindex(); return l; }
  }
  if (options.saveFrameToPng !== false) {
    CompItem.prototype.saveFrameToPng = function (this: CompItem, t: number, f: FakeFile) {
      this.framesSaved.push({ t, path: f.fsName });
      // A real 1x1 PNG, written a moment later like After Effects does.
      setTimeout(() => { try { writeFileSync(f.fsName, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')); } catch { /* folder may be gone */ } }, 20);
    };
  }

  class FakeFile {
    fsName: string; name: string;
    constructor(path: string) { this.fsName = path; this.name = path.split('/').pop() ?? path; }
    get exists() { return !/missing/.test(this.fsName); }
    get parent() { const dir = this.fsName.split('/').slice(0, -1).join('/'); return { exists: true, fsName: dir, create: () => true }; }
  }
  class ImportOptions { file: FakeFile; sequence = false; forceAlphabetical = false; constructor(f: FakeFile) { this.file = f; } canImportAs() { return true; } }

  const rqItems: any[] = [];
  const project: any = {
    file: null as FakeFile | null,
    dirty: false,
    activeItem: null as unknown,
    items: {
      list: [] as FakeItem[],
      get length() { return project.items.list.length; },
      addComp: (name: string, w: number, h: number, pa: number, d: number, fps: number) => {
        for (const [label, v] of [['width', w], ['height', h], ['pixelAspect', pa], ['duration', d], ['frameRate', fps]] as const) {
          if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`addComp: bad ${label} ${String(v)}`);
        }
        const c = new CompItem(name, w, h, pa, d, fps); project.items.list.push(c); project.activeItem = c; return c;
      },
      addFolder: (name: string) => { const f = new FolderItem(name); project.items.list.push(f); return f; },
    },
    item: (i: number) => project.items.list[i - 1],
    get numItems() { return project.items.list.length; },
    importFile: (io: ImportOptions) => { const f = new FootageItem(io.file, /\.(png|jpe?g)$/i.test(io.file.fsName) && !io.sequence); project.items.list.push(f); return f; },
    save: (f?: FakeFile) => { if (f) project.file = f; if (!project.file) throw new Error('No file to save to'); project.dirty = false; log.push(`save ${project.file.fsName}`); },
    close: () => true,
    renderQueue: {
      rendering: false,
      items: { add: (comp: CompItem) => {
        const om = { templates: ['Best Settings', 'H.264 - Match Render Settings - 15 Mbps', 'High Quality with Alpha', 'Lossless', 'PNG Sequence'], template: '', file: null as FakeFile | null, applyTemplate(t: string) { if (!this.templates.includes(t)) throw new Error(`No template ${t}`); this.template = t; } };
        const item = { comp, status: 0, timeSpanStart: 0, timeSpanDuration: comp.duration, om, applyTemplate() {}, outputModule: () => om, remove: () => { rqItems.splice(rqItems.indexOf(item), 1); } };
        rqItems.push(item); return item;
      } },
      render: () => { for (const i of rqItems) { i.status = 3015; log.push(`render ${i.om.template} -> ${i.om.file?.fsName}`); } },
      queueInAME: () => { log.push('ame'); },
    },
  };
  // 1-based access: project.items[i]
  const itemsProxy = new Proxy(project.items, { get(target, key) { if (typeof key === 'string' && /^\d+$/.test(key)) return target.list[Number(key) - 1]; return (target as any)[key]; } });
  project.items = itemsProxy;

  const prefs: Record<string, number> = {};
  const app = {
    version: '25.0x1', buildName: 'fake',
    project,
    newProject: () => { project.items.list.length = 0; project.file = null; return project; },
    open: (f: FakeFile) => { project.file = f; return project; },
    beginUndoGroup: () => { undoDepth++; },
    endUndoGroup: () => { undoDepth--; },
    beginSuppressDialogs: () => {}, endSuppressDialogs: () => {},
    preferences: {
      getPrefAsLong: (s: string, k: string) => { if (!(`${s}/${k}` in prefs)) throw new Error('no pref'); return prefs[`${s}/${k}`]; },
      savePrefAsLong: (s: string, k: string, v: number) => { prefs[`${s}/${k}`] = v; },
      saveToDisk: () => {}, reload: () => {},
    },
    fonts: { allFonts: [[{ familyName: 'Inter', styleName: 'Bold', postScriptName: 'Inter-Bold' }], [{ familyName: 'Instrument Serif', styleName: 'Italic', postScriptName: 'InstrumentSerif-Italic' }]] },
  };
  prefs['Main Pref Section v2/Pref_SCRIPTING_FILE_NETWORK_SECURITY'] = 0;

  const globals = {
    app, CompItem, FootageItem, FolderItem, TextLayer, ShapeLayer, CameraLayer, LightLayer, AVLayer, SolidSource, FileSource,
    MarkerValue, File: FakeFile, ImportOptions,
    ImportAsType: { FOOTAGE: 1, COMP: 2 },
    KeyframeEase: class { speed: number; influence: number; constructor(s: number, i: number) { if (i < 0.1 || i > 100) throw new Error('KeyframeEase influence must be 0.1-100'); this.speed = s; this.influence = i; } },
    KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 },
    PropertyValueType: { TwoD_SPATIAL: SPATIAL_2D, ThreeD_SPATIAL: SPATIAL_3D, TwoD: TWO_D, OneD: ONE_D, COLOR, NO_VALUE, CUSTOM_VALUE: CUSTOM },
    ParagraphJustification: { LEFT_JUSTIFY: 7413, CENTER_JUSTIFY: 7415, RIGHT_JUSTIFY: 7414 },
    BlendingMode: { NORMAL: 5212, SCREEN: 5220, ADD: 5213, MULTIPLY: 5219 },
    CloseOptions: { DO_NOT_SAVE_CHANGES: 1 },
    RQItemStatus: { DONE: 3015 },
  };
  // Run in this realm, not a vm context: After Effects has one realm, and a
  // separate one makes `value instanceof Array` false for arrays the DOM returns.
  const names = Object.keys(globals);
  const values = names.map((k) => (globals as Record<string, unknown>)[k]);

  /** Runs one generated script the way the bridge does and returns its parsed result. */
  function runScript(script: string): any {
    // Syntax is checked by the ES3 parse elsewhere; here it only has to run.
    vm.createScript(`(function(){\n${script}\n})`);
    const fn = new Function(...names, `return (function(){\n${script}\n})();`);
    const raw = fn(...values);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  return { app, project, log, runScript, get undoDepth() { return undoDepth; }, rqItems, CompItem, FootageItem };
}

export type FakeAe = ReturnType<typeof createFakeAe>;
