/**
 * ExtendScript helpers every After Effects command starts with.
 *
 * After Effects runs ExtendScript, an ES3 dialect: no Array.prototype.indexOf,
 * forEach, map, Object.keys, String.prototype.trim, const or let. Everything
 * here is written to that standard, and the generated-script test parses it as
 * ES3 to keep it that way.
 *
 * String.raw keeps backslashes exactly as written; nothing below interpolates.
 * The panel rejects any script containing an eval-style call, a require, or the
 * Node global for the current process, so none of those words appear here, not
 * even in comments.
 *
 * Two After Effects habits shape the helpers:
 *  - Adding a property (an animator, an effect, a shape) can invalidate every
 *    reference previously taken to siblings in that group. Helpers re-resolve
 *    by index after each add rather than holding references.
 *  - Collections are 1-based: comp.layer(1) is the top layer.
 */
export const AE_HELPERS = String.raw`
function __aeResult(obj) { return JSON.stringify(obj); }
function __aeIsComp(item) { return item && (item instanceof CompItem); }
function __aeFindItem(ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  var items = app.project.items;
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    if (String(it.id) === String(ref)) return it;
  }
  for (var j = 1; j <= items.length; j++) {
    if (items[j].name === String(ref)) return items[j];
  }
  return null;
}
function __aeFindComp(ref) {
  if (ref === null || ref === undefined || ref === "") {
    var active = app.project.activeItem;
    return __aeIsComp(active) ? active : null;
  }
  var items = app.project.items;
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    if (__aeIsComp(it) && (String(it.id) === String(ref) || it.name === String(ref))) return it;
  }
  return null;
}
function __aeRequireComp(ref) {
  var c = __aeFindComp(ref);
  if (!c) {
    if (ref === null || ref === undefined || ref === "") throw new Error("No composition is active. Pass compId (from ae_get_project_info) or open a comp.");
    throw new Error("Composition not found: " + ref + ". Call ae_get_project_info to list composition ids.");
  }
  return c;
}
function __aeFindLayer(comp, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  if (typeof ref === "number") return (ref >= 1 && ref <= comp.numLayers) ? comp.layer(ref) : null;
  for (var i = 1; i <= comp.numLayers; i++) {
    var L = comp.layer(i);
    if (L.name === String(ref)) return L;
  }
  if (/^[0-9]+$/.test(String(ref))) {
    var n = parseInt(String(ref), 10);
    if (n >= 1 && n <= comp.numLayers) return comp.layer(n);
  }
  return null;
}
function __aeRequireLayer(comp, ref) {
  var L = __aeFindLayer(comp, ref);
  if (!L) throw new Error("Layer not found in '" + comp.name + "': " + ref + ". Call ae_get_comp_info to list layers.");
  return L;
}
function __aeHex(value) {
  if (value instanceof Array) return value;
  var h = String(value || "FFFFFF").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error("Colour must be a 6-digit hex such as #3DDC84, got: " + value);
  return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255];
}
function __aeToHex(rgb) {
  function two(v) { var s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).toUpperCase(); return s.length < 2 ? "0" + s : s; }
  return "#" + two(rgb[0]) + two(rgb[1]) + two(rgb[2]);
}
function __aeRound(n) { return Math.round(n * 1000) / 1000; }
function __aeLayerType(L) {
  if (L instanceof TextLayer) return "text";
  if (L instanceof ShapeLayer) return "shape";
  if (L instanceof CameraLayer) return "camera";
  if (L instanceof LightLayer) return "light";
  try { if (L.nullLayer) return "null"; } catch (e1) {}
  try { if (L.adjustmentLayer) return "adjustment"; } catch (e2) {}
  try { if (L.source && L.source.mainSource && (L.source.mainSource instanceof SolidSource)) return "solid"; } catch (e3) {}
  try { if (L.source && L.source.mainSource && (L.source.mainSource instanceof FileSource) && L.source.mainSource.isStill) return "still"; } catch (e4) {}
  if (L.source && (L.source instanceof CompItem)) return "precomp";
  return "footage";
}
function __aeLayerInfo(L) {
  var info = {
    index: L.index, name: L.name, type: __aeLayerType(L),
    inPoint: __aeRound(L.inPoint), outPoint: __aeRound(L.outPoint), startTime: __aeRound(L.startTime),
    enabled: L.enabled, locked: L.locked, shy: L.shy, label: L.label,
    parent: L.parent ? L.parent.name : null
  };
  try { info.threeD = L.threeDLayer; } catch (e1) {}
  try { if (L.source) { info.source = L.source.name; info.sourceId = L.source.id; } } catch (e2) {}
  try { if (L instanceof TextLayer) { var td = L.property("ADBE Text Properties").property("ADBE Text Document").value; info.text = td.text; info.font = td.font; info.fontSize = td.fontSize; } } catch (e3) {}
  try {
    var fx = L.property("ADBE Effect Parade");
    if (fx && fx.numProperties > 0) { info.effects = []; for (var i = 1; i <= fx.numProperties; i++) info.effects.push(fx.property(i).name); }
  } catch (e4) {}
  try { var p = L.property("ADBE Transform Group").property("ADBE Position").value; info.position = [__aeRound(p[0]), __aeRound(p[1])]; } catch (e5) {}
  return info;
}
function __aeCompInfo(c) {
  var info = {
    id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect,
    frameRate: c.frameRate, duration: __aeRound(c.duration), numLayers: c.numLayers,
    workAreaStart: __aeRound(c.workAreaStart), workAreaDuration: __aeRound(c.workAreaDuration)
  };
  try { info.backgroundColor = __aeToHex(c.bgColor); } catch (e) {}
  return info;
}
var __AE_PROP_SHORTCUTS = {
  "position": ["ADBE Transform Group", "ADBE Position"],
  "scale": ["ADBE Transform Group", "ADBE Scale"],
  "rotation": ["ADBE Transform Group", "ADBE Rotate Z"],
  "opacity": ["ADBE Transform Group", "ADBE Opacity"],
  "anchor point": ["ADBE Transform Group", "ADBE Anchor Point"],
  "anchor": ["ADBE Transform Group", "ADBE Anchor Point"],
  "source text": ["ADBE Text Properties", "ADBE Text Document"]
};
function __aeSplitPath(path) {
  if (path instanceof Array) return path;
  var parts = String(path).split(/\s*[\/>]\s*/);
  var out = [];
  for (var i = 0; i < parts.length; i++) if (parts[i] !== "") out.push(parts[i]);
  return out;
}
function __aeProp(layer, path) {
  var segs = __aeSplitPath(path);
  if (segs.length === 1) {
    var sc = __AE_PROP_SHORTCUTS[String(segs[0]).toLowerCase()];
    if (sc) segs = sc;
  }
  if (segs.length > 0 && String(segs[0]).toLowerCase() === "transform") segs[0] = "ADBE Transform Group";
  if (segs.length > 0 && (String(segs[0]).toLowerCase() === "effects" || String(segs[0]).toLowerCase() === "effect")) segs[0] = "ADBE Effect Parade";
  var p = layer;
  for (var i = 0; i < segs.length; i++) {
    var next = null;
    try { next = p.property(segs[i]); } catch (e) { next = null; }
    if (!next && /^[0-9]+$/.test(String(segs[i]))) { try { next = p.property(parseInt(segs[i], 10)); } catch (e2) { next = null; } }
    if (!next) throw new Error("Property '" + segs.slice(0, i + 1).join("/") + "' not found on layer '" + layer.name + "'.");
    p = next;
  }
  return p;
}
function __aeDims(prop) {
  try {
    if (prop.propertyValueType === PropertyValueType.TwoD_SPATIAL || prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL) return 1;
    var v = prop.value;
    return (v instanceof Array) ? v.length : 1;
  } catch (e) { return 1; }
}
function __aeEase(prop, kind, influence) {
  var n = prop.numKeys;
  if (!n) return;
  var inf = influence || 75;
  for (var k = 1; k <= n; k++) {
    try {
      if (kind === "linear") { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); continue; }
      if (kind === "hold") { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); continue; }
      prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
      var d = __aeDims(prop);
      var easeIn = [], easeOut = [];
      for (var j = 0; j < d; j++) { easeIn.push(new KeyframeEase(0, inf)); easeOut.push(new KeyframeEase(0, inf)); }
      prop.setTemporalEaseAtKey(k, easeIn, easeOut);
    } catch (e) {}
  }
}
function __aeFitValue(prop, v) {
  // [x, y] for a property that holds [x, y, z] (Position, Scale and Anchor Point
  // do, even on 2D layers): keep the property's own remaining components.
  var cur = null;
  try { cur = prop.value; } catch (e) { cur = null; }
  if ((v instanceof Array) && (cur instanceof Array) && v.length < cur.length && prop.propertyValueType !== PropertyValueType.COLOR) return v.concat(cur.slice(v.length));
  return v;
}
function __aeSetKeys(prop, keys, kind, influence, clear) {
  if (!prop.canVaryOverTime) throw new Error("Property '" + prop.name + "' cannot be keyframed.");
  if (clear) { while (prop.numKeys > 0) prop.removeKey(prop.numKeys); }
  for (var i = 0; i < keys.length; i++) prop.setValueAtTime(keys[i][0], __aeFitValue(prop, keys[i][1]));
  __aeEase(prop, kind || "ease", influence);
  return prop.numKeys;
}
function __aeTextDocProp(layer) { return layer.property("ADBE Text Properties").property("ADBE Text Document"); }
function __aeStyleText(layer, s) {
  var p = __aeTextDocProp(layer);
  var td = p.value;
  var warnings = [];
  if (s.text !== undefined && s.text !== null) td.text = s.text;
  if (s.font) td.font = s.font;
  if (s.fontSize) td.fontSize = s.fontSize;
  if (s.color) { td.applyFill = true; td.fillColor = __aeHex(s.color); }
  if (s.strokeColor && s.strokeWidth) { td.applyStroke = true; td.strokeColor = __aeHex(s.strokeColor); td.strokeWidth = s.strokeWidth; try { td.strokeOverFill = false; } catch (e0) {} }
  if (s.tracking !== undefined && s.tracking !== null) td.tracking = s.tracking;
  if (s.leading) { try { td.autoLeading = false; td.leading = s.leading; } catch (e1) {} }
  if (s.justification) {
    var j = String(s.justification);
    td.justification = j === "left" ? ParagraphJustification.LEFT_JUSTIFY : (j === "right" ? ParagraphJustification.RIGHT_JUSTIFY : ParagraphJustification.CENTER_JUSTIFY);
  }
  if (s.allCaps !== undefined && s.allCaps !== null) { try { td.allCaps = !!s.allCaps; } catch (e2) {} }
  p.setValue(td);
  if (s.font) {
    try { var applied = __aeTextDocProp(layer).value.font; if (applied !== s.font) warnings.push("Font '" + s.font + "' was not applied (got '" + applied + "'). Use ae_find_fonts for the exact PostScript name and check it is installed."); } catch (e3) {}
  }
  return warnings;
}
function __aeAnchorTo(layer, mode, t) {
  var r = layer.sourceRectAtTime(t || 0, false);
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (mode === "left") x = r.left;
  if (mode === "right") x = r.left + r.width;
  var ap = layer.property("ADBE Transform Group").property("ADBE Anchor Point");
  var cur = ap.value;
  ap.setValue(cur.length === 3 ? [x, y, cur[2]] : [x, y]);
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
function __aeSetScale(layer, sx, sy) {
  var p = layer.property("ADBE Transform Group").property("ADBE Scale");
  var cur = p.value;
  p.setValue(cur.length === 3 ? [sx, sy, cur[2]] : [sx, sy]);
}
function __aeSetPosition(layer, xy) {
  var p = layer.property("ADBE Transform Group").property("ADBE Position");
  var cur = p.value;
  p.setValue(cur.length === 3 ? [xy[0], xy[1], cur[2]] : [xy[0], xy[1]]);
}
function __aeTiming(layer, inPoint, outPoint) {
  if (outPoint !== null && outPoint !== undefined && inPoint !== null && inPoint !== undefined && outPoint <= inPoint) throw new Error("outPoint must be after inPoint");
  if (inPoint !== null && inPoint !== undefined) {
    if (layer.outPoint <= inPoint) layer.outPoint = inPoint + layer.containingComp.frameDuration;
    layer.inPoint = inPoint;
  }
  if (outPoint !== null && outPoint !== undefined) layer.outPoint = outPoint;
}
function __aeAddEffect(layer, effect) {
  var parade = layer.property("ADBE Effect Parade");
  if (!parade.canAddProperty(effect)) throw new Error("Effect not available: " + effect + ". Use the match name (e.g. ADBE Gaussian Blur 2) or the exact English display name.");
  var fx = parade.addProperty(effect);
  var idx = fx.propertyIndex;
  return layer.property("ADBE Effect Parade").property(idx);
}
function __aeFindEffect(layer, effect) {
  var parade = layer.property("ADBE Effect Parade");
  for (var i = 1; i <= parade.numProperties; i++) {
    var fx = parade.property(i);
    if (fx.matchName === effect || fx.name === effect) return fx;
  }
  return null;
}
function __aeEffectParams(fx) {
  var out = [];
  for (var i = 1; i <= fx.numProperties; i++) {
    var p = fx.property(i);
    var entry = { index: i, name: p.name, matchName: p.matchName };
    try { if (p.propertyValueType !== PropertyValueType.NO_VALUE && p.propertyValueType !== PropertyValueType.CUSTOM_VALUE) entry.value = p.value; } catch (e) {}
    out.push(entry);
  }
  return out;
}
function __aeEffectParam(fx, ref) {
  if (typeof ref === "number") return fx.property(ref);
  var p = null;
  try { p = fx.property(String(ref)); } catch (e) { p = null; }
  if (!p) {
    for (var i = 1; i <= fx.numProperties; i++) {
      var c = fx.property(i);
      if (String(c.name).toLowerCase() === String(ref).toLowerCase()) return c;
    }
    throw new Error("Effect '" + fx.name + "' has no parameter '" + ref + "'.");
  }
  return p;
}
function __aeSetParam(p, value) {
  if (p.numKeys > 0) throw new Error("'" + p.name + "' is keyframed, so it has no single value to set. Change its keyframes with ae_set_keyframes (clearExisting:true to replace them).");
  p.setValue(value);
}
function __aeMosaic(layer, comp) {
  var fx = __aeFindEffect(layer, "ADBE Mosaic");
  if (!fx) { fx = __aeAddEffect(layer, "ADBE Mosaic"); try { fx.property(3).setValue(1); } catch (e) {} }
  return fx;
}
function __aeMosaicBlocks(comp, pixel) {
  var px = Math.max(1, pixel);
  return [Math.max(1, Math.round(comp.width / px)), Math.max(1, Math.round(comp.height / px))];
}
function __aeMosaicFine(comp) { return [Math.min(4000, comp.width), Math.min(4000, comp.height)]; }
function __aeMosaicKeys(layer, comp, keys) {
  var fx = __aeMosaic(layer, comp);
  var h = fx.property(1), v = fx.property(2);
  for (var i = 0; i < keys.length; i++) {
    var b = keys[i][1] === "fine" ? __aeMosaicFine(comp) : __aeMosaicBlocks(comp, keys[i][1]);
    h.setValueAtTime(keys[i][0], b[0]);
    v.setValueAtTime(keys[i][0], b[1]);
  }
  __aeEase(h, "ease", 60); __aeEase(v, "ease", 60);
  return fx;
}
function __aeLetterReveal(layer, charKeys, total) {
  var animators = layer.property("ADBE Text Properties").property("ADBE Text Animators");
  var anim = animators.addProperty("ADBE Text Animator");
  var ai = anim.propertyIndex;
  function A() { return layer.property("ADBE Text Properties").property("ADBE Text Animators").property(ai); }
  A().name = "MCP Letter Reveal";
  A().property("ADBE Text Selectors").addProperty("ADBE Text Selector");
  A().property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity");
  A().property("ADBE Text Animator Properties").property("ADBE Text Opacity").setValue(0);
  var sel = A().property("ADBE Text Selectors").property(1);
  try { sel.property("ADBE Text Range Advanced").property("ADBE Text Range Type2").setValue(2); } catch (e1) {}
  try { sel.property("ADBE Text Range Advanced").property("ADBE Text Selector Smoothness").setValue(0); } catch (e2) {}
  var start = A().property("ADBE Text Selectors").property(1).property("ADBE Text Percent Start");
  var denom = total > 0 ? total : 1;
  for (var i = 0; i < charKeys.length; i++) start.setValueAtTime(charKeys[i][0], Math.min(100, (charKeys[i][1] / denom) * 100));
  __aeEase(start, "linear");
  return start.numKeys;
}
function __aeOpacityKeys(layer, keys) {
  var p = layer.property("ADBE Transform Group").property("ADBE Opacity");
  for (var i = 0; i < keys.length; i++) p.setValueAtTime(keys[i][0], keys[i][1]);
  __aeEase(p, "ease", 70);
}
function __aeOffsetKeys(layer, keys) {
  var p = layer.property("ADBE Transform Group").property("ADBE Position");
  var base = p.numKeys > 0 ? p.valueAtTime(keys[0][0], true) : p.value;
  for (var i = 0; i < keys.length; i++) {
    var v = base.length === 3 ? [base[0] + keys[i][1][0], base[1] + keys[i][1][1], base[2]] : [base[0] + keys[i][1][0], base[1] + keys[i][1][1]];
    p.setValueAtTime(keys[i][0], v);
  }
  __aeEase(p, "ease", 80);
}
function __aeScaleKeys(layer, keys) {
  var p = layer.property("ADBE Transform Group").property("ADBE Scale");
  var base = p.value;
  for (var i = 0; i < keys.length; i++) {
    var sx = keys[i][1][0], sy = keys[i][1][1];
    p.setValueAtTime(keys[i][0], base.length === 3 ? [sx, sy, base[2]] : [sx, sy]);
  }
  __aeEase(p, "ease", 70);
}
function __aeExpression(prop, expr) {
  prop.expression = expr;
  try { if (prop.expressionError && prop.expressionError !== "") return prop.expressionError; } catch (e) {}
  return "";
}
function __aeMicroMotion(layer, style, amount, speed, phase) {
  var tg = layer.property("ADBE Transform Group");
  var f = speed, a = amount, ph = phase;
  if (style === "drift") return __aeExpression(tg.property("ADBE Position"), "var a=" + a + "; var f=" + f + "; var ph=" + ph + "; var o=[Math.sin(time*f*2*Math.PI+ph)*a, Math.cos(time*f*1.6*Math.PI+ph)*a*0.6]; value.length === 3 ? add(value, [o[0], o[1], 0]) : add(value, o);");
  if (style === "breathe") return __aeExpression(tg.property("ADBE Scale"), "var a=" + a + "; var f=" + f + "; var ph=" + ph + "; value * (1 + a*Math.sin(time*f*2*Math.PI+ph));");
  if (style === "sway") return __aeExpression(tg.property("ADBE Rotate Z"), "var a=" + a + "; var f=" + f + "; var ph=" + ph + "; value + a*Math.sin(time*f*2*Math.PI+ph);");
  if (style === "float") return __aeExpression(tg.property("ADBE Position"), "seedRandom(" + Math.round(ph * 1000) + ", true); wiggle(" + f + ", " + a + ");");
  return "";
}
function __aeAddShape(comp, kind, size, fill, stroke, strokeWidth, roundness) {
  var layer = comp.layers.addShape();
  var root = layer.property("ADBE Root Vectors Group");
  var grp = root.addProperty("ADBE Vector Group");
  var gi = grp.propertyIndex;
  function G() { return layer.property("ADBE Root Vectors Group").property(gi).property("ADBE Vectors Group"); }
  if (kind === "ellipse") {
    G().addProperty("ADBE Vector Shape - Ellipse");
    G().property(1).property("ADBE Vector Ellipse Size").setValue(size);
  } else {
    G().addProperty("ADBE Vector Shape - Rect");
    G().property(1).property("ADBE Vector Rect Size").setValue(size);
    if (roundness) G().property(1).property("ADBE Vector Rect Roundness").setValue(roundness);
  }
  if (fill) {
    G().addProperty("ADBE Vector Graphic - Fill");
    var c = __aeHex(fill);
    G().property(G().numProperties).property("ADBE Vector Fill Color").setValue([c[0], c[1], c[2], 1]);
  }
  if (stroke && strokeWidth) {
    G().addProperty("ADBE Vector Graphic - Stroke");
    var s = __aeHex(stroke);
    var st = G().property(G().numProperties);
    st.property("ADBE Vector Stroke Color").setValue([s[0], s[1], s[2], 1]);
    st.property("ADBE Vector Stroke Width").setValue(strokeWidth);
  }
  return layer;
}
function __aeImportFile(path, asSequence) {
  var f = new File(path);
  if (!f.exists) throw new Error("File not found: " + path);
  var items = app.project.items;
  for (var i = 1; i <= items.length; i++) {
    var it = items[i];
    try { if (it.file && it.file.fsName === f.fsName && !asSequence) return it; } catch (e) {}
  }
  var io = new ImportOptions(f);
  if (asSequence) { if (!io.canImportAs(ImportAsType.FOOTAGE)) throw new Error("Cannot import as footage: " + path); io.sequence = true; io.forceAlphabetical = true; }
  return app.project.importFile(io);
}
function __aeFolder(name) {
  if (!name) return null;
  var items = app.project.items;
  for (var i = 1; i <= items.length; i++) if ((items[i] instanceof FolderItem) && items[i].name === name) return items[i];
  return items.addFolder(name);
}
function __aeRemoveLayersWithPrefix(comp, prefix) {
  var removed = [];
  for (var i = comp.numLayers; i >= 1; i--) {
    var L = comp.layer(i);
    if (L.name.substr(0, prefix.length) === prefix) { var wasLocked = L.locked; if (wasLocked) L.locked = false; removed.push(L.name); L.remove(); }
  }
  return removed;
}
function __aeMarker(comp, t, comment, duration, label) {
  var mp = comp.markerProperty;
  for (var i = 1; i <= mp.numKeys; i++) {
    if (Math.abs(mp.keyTime(i) - t) < 0.001 && mp.keyValue(i).comment === comment) return false;
  }
  var mv = new MarkerValue(comment);
  if (duration) mv.duration = duration;
  if (label !== undefined && label !== null) { try { mv.label = label; } catch (e) {} }
  mp.setValueAtTime(t, mv);
  return true;
}
`;
