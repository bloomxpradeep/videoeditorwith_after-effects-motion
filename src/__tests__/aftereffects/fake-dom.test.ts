/**
 * Runs the generated After Effects scripts against a fake After Effects DOM
 * (helpers/fake-ae.ts) and checks what they build, not just that they parse.
 *
 * This is the closest this repository can get to After Effects without After
 * Effects: it catches misspelled helpers, wrong property paths, ease arrays of
 * the wrong length, layers edited while locked, and undo groups left open.
 */
import { rmSync } from 'node:fs';
import { PremiereProTools } from '../../tools/index';
import { createFakeAe, type FakeAe, FakeGroup, FakeProperty } from '../helpers/fake-ae';
import { makeMotionProject, type MotionProject } from '../helpers/motion-fixture';
import { resolveStoryboard } from '../../motion/storyboard';
import { normalizeWhisperJson } from '../../motion/words';
import { storyboard, whisperJson } from '../helpers/motion-fixture';

let project: MotionProject;
let ae: FakeAe;
let tools: PremiereProTools;

function prop(group: any, ...path: string[]): any {
  let p = group;
  for (const seg of path) { p = p.property(seg); if (!p) throw new Error(`missing ${path.join('/')}`); }
  return p;
}

beforeEach(() => {
  project = makeMotionProject();
  ae = createFakeAe();
  const bridge = {
    executeScript: async (script: string) => ae.runScript(script),
    ensureHost: async () => ({ ready: true, success: true, status: 'connected' }),
  };
  tools = new PremiereProTools(bridge as any, { app: 'aftereffects' });
});
afterEach(() => { rmSync(project.root, { recursive: true, force: true }); });

const call = (name: string, args: Record<string, unknown> = {}) => tools.executeTool(name, args) as Promise<any>;
const comp = () => ae.project.items.list.find((i: any) => i instanceof ae.CompItem) as any;

describe('storyboard to After Effects, end to end on the fake DOM', () => {
  it('sets up the comp, footage and markers, and saves into the project ae folder', async () => {
    const r = await call('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    expect(r.success).toBe(true);
    const c = comp();
    expect(c).toMatchObject({ name: 'Solo Founder Intro MAIN', width: 1920, height: 1080, frameRate: 60, duration: 7 });
    expect(c.layerList.map((l: any) => l.name)).toEqual(['BG_raw_footage']);
    expect(c.layer(1).locked).toBe(true);
    expect(c.markerProperty.keys.map((k: any) => [k.t, k.v.comment])).toEqual([[0, 'S01 name card'], [2, 'S02 what i teach'], [4.9, 'S03 payoff']]);
    expect(ae.log).toContain(`save ${project.root}/ae/solo-founder-intro.aep`);
    expect(ae.undoDepth).toBe(0);

    // Running it again reuses everything.
    await call('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    expect(ae.project.items.list.filter((i: any) => i instanceof ae.CompItem)).toHaveLength(1);
    expect(comp().numLayers).toBe(1);
    expect(comp().markerProperty.numKeys).toBe(3);
  });

  it('builds every beat as named, editable, animated layers above the untouched footage', async () => {
    await call('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    for (const beatId of ['S01', 'S02', 'S03']) {
      const r = await call('ae_build_scene', { storyboardPath: project.storyboardPath, beatId });
      expect(r.failed).toEqual([]);
      expect(r.success).toBe(true);
    }
    const c = comp();
    const names = c.layerList.map((l: any) => l.name);
    expect(names[names.length - 1]).toBe('BG_raw_footage');
    expect(c.layer(c.numLayers).locked).toBe(true);
    expect(names).toEqual(expect.arrayContaining(['S01_text_name', 'S01_shape_rule', 'S02_text_what', 'S02_text_who', 'S03_text_everything', 'S03_transition_pixel']));
    expect(ae.undoDepth).toBe(0);

    // Live text with the storyboard's font, size and colour.
    const name = c.layer('S01_text_name');
    const td = prop(name, 'ADBE Text Properties', 'ADBE Text Document').value;
    expect(td).toMatchObject({ text: 'SOMRAT DUTTA', font: 'Inter-Bold', fontSize: 80 });
    expect(td.fillColor.map((v: number) => Math.round(v * 255))).toEqual([0x3d, 0xdc, 0x84]);
    expect(name.inPoint).toBe(0.82);
    expect(name.outPoint).toBe(2);
    expect(prop(name, 'ADBE Transform Group', 'ADBE Position').value).toEqual([0.8 * 1920, 0.45 * 1080]);

    // Letter reveal keyed exactly to the resolved character keys.
    const sb = resolveStoryboard(storyboard(), normalizeWhisperJson(whisperJson()));
    const el = sb.beats[0]!.elements[0]!;
    const start = prop(name, 'ADBE Text Properties', 'ADBE Text Animators', 'MCP Letter Reveal', 'ADBE Text Selectors', 'ADBE Text Selector', 'ADBE Text Percent Start');
    expect(start.keys.map((k: any) => [k.t, Math.round(k.v * 100) / 100])).toEqual(el.timing.charKeys.map((k) => [k.t, Math.round((k.chars / 11) * 10000) / 100]));
    expect(prop(name, 'ADBE Text Properties', 'ADBE Text Animators', 'MCP Letter Reveal', 'ADBE Text Animator Properties', 'ADBE Text Opacity').value).toBe(0);
    expect(prop(name, 'ADBE Text Properties', 'ADBE Text Animators', 'MCP Letter Reveal', 'ADBE Text Selectors', 'ADBE Text Selector', 'ADBE Text Range Advanced', 'ADBE Text Range Type2').value).toBe(2);

    // Pixel resolve: coarse 12px blocks at the first word, full resolution once the letters land.
    const h = prop(name, 'ADBE Effect Parade', 'ADBE Mosaic', 'ADBE Mosaic-0001');
    expect(h.keys[0]).toMatchObject({ t: 0.82, v: 160 });
    expect(h.keys[1].v).toBe(1920);

    // Exit after the hold, and micro-motion on top.
    const opacity = prop(name, 'ADBE Transform Group', 'ADBE Opacity');
    expect(opacity.keys.map((k: any) => [k.t, k.v])).toEqual([[1.6, 100], [2, 0]]);
    expect(prop(name, 'ADBE Transform Group', 'ADBE Position').expression).toContain('add(value');

    // Shapes: underline grows from its left edge.
    const rule = c.layer('S01_shape_rule');
    const scale = prop(rule, 'ADBE Transform Group', 'ADBE Scale');
    expect(scale.keys[0].v).toEqual([0, 100]);
    expect(prop(rule, 'ADBE Transform Group', 'ADBE Anchor Point').value).toEqual([-150, 0]);

    // fade-up enters from 30px below.
    const who = c.layer('S02_text_who');
    const pos = prop(who, 'ADBE Transform Group', 'ADBE Position');
    expect(pos.keys[0].v[1] - pos.keys[1].v[1]).toBeCloseTo(30, 5);

    // Pixel transition out of S02, pixel flash after S03.
    expect(prop(c.layer('S02_text_what'), 'ADBE Effect Parade', 'ADBE Mosaic', 'ADBE Mosaic-0001').keys.slice(-2).map((k: any) => k.v)).toEqual([1920, 107]);
    const flash = c.layer('S03_transition_pixel');
    expect(flash.adjustmentLayer).toBe(true);
    expect(flash.index).toBe(1);
  });

  it('rebuilding a beat replaces its layers instead of stacking duplicates', async () => {
    await call('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    await call('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S02' });
    const before = comp().numLayers;
    const r = await call('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S02' });
    expect([...r.removed].sort()).toEqual(['S02_text_what', 'S02_text_who']);
    expect(comp().numLayers).toBe(before);
    expect(comp().markerProperty.numKeys).toBe(3);
  });

  it('reports a font that is not installed instead of pretending it was applied', async () => {
    const sb = storyboard();
    (sb.style as any).fonts.primary.postscript = 'NotInstalled-Black';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(project.storyboardPath, JSON.stringify(sb));
    await call('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    const r = await call('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S01' });
    expect(r.warnings.join(' ')).toContain("Font 'NotInstalled-Black' was not applied");
  });

  it('saves one review frame per beat', async () => {
    await call('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    const r = await call('ae_save_frames', { storyboardPath: project.storyboardPath, contactSheet: false });
    expect(comp().framesSaved.map((f: any) => f.path.replace(/_\d{8}-\d{6}\.png$/, ''))).toEqual(['S01', 'S02', 'S03'].map((b) => `${project.root}/review/${b}`));
    expect(r.missing).toEqual([]);
    expect(r.frames.map((f: any) => f.label)).toEqual(['S01', 'S02', 'S03']);
  });
});

describe('direct tools on the fake DOM', () => {
  beforeEach(async () => {
    await call('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    await call('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S01' });
  });

  it('ae_verify_connection reports the app and turns on script file access', async () => {
    const r = await call('ae_verify_connection');
    expect(r).toMatchObject({ success: true, app: 'After Effects', scriptsCanWriteFiles: true, enabledFileAccess: true, fontsApi: true });
  });

  it('ae_get_project_info and ae_get_comp_info describe what is there', async () => {
    const info = await call('ae_get_project_info');
    expect(info.items.map((i: any) => i.kind)).toEqual(expect.arrayContaining(['comp', 'footage', 'folder']));
    const ci = await call('ae_get_comp_info', { compId: 'Solo Founder Intro MAIN' });
    expect(ci.layers.find((l: any) => l.name === 'S01_text_name')).toMatchObject({ type: 'text', text: 'SOMRAT DUTTA', effects: ['Mosaic'] });
    expect(ci.markers).toHaveLength(3);
  });

  it('text, shape, solid, keyframes, expressions, effects, markers, micro-motion and deletes all work', async () => {
    const steps: Array<[string, Record<string, unknown>]> = [
      ['ae_add_text_layer', { text: 'HELLO', name: 'T', font: 'Inter-Bold', fontSize: 50, color: '#FFFFFF', position: [100, 100], anchor: 'left', inPoint: 1, outPoint: 3 }],
      ['ae_add_shape_layer', { shape: 'ellipse', size: [50, 50], fillColor: '#3DDC84', strokeColor: '#000000', strokeWidth: 3, name: 'E' }],
      ['ae_add_solid_layer', { kind: 'adjustment', name: 'ADJ' }],
      ['ae_add_solid_layer', { kind: 'null', name: 'CTRL' }],
      ['ae_set_keyframes', { layer: 'T', property: 'Opacity', keyframes: [{ time: 1, value: 0 }, { time: 1.5, value: 100 }] }],
      ['ae_set_keyframes', { layer: 'T', property: 'Scale', keyframes: [{ time: 1, value: [80, 80] }, { time: 2, value: [100, 100] }], interpolation: 'ease', easeInfluence: 60 }],
      ['ae_set_keyframes', { layer: 'T', property: 'Position', keyframes: [{ time: 1, value: [100, 100] }, { time: 2, value: [200, 100] }], interpolation: 'linear' }],
      ['ae_set_expression', { layer: 'E', property: 'Rotation', expression: 'time * 10' }],
      ['ae_apply_effect', { layer: 'ADJ', effect: 'Gaussian Blur', params: { Blurriness: 12 }, keyframes: { Blurriness: [{ time: 0, value: 30 }, { time: 1, value: 0 }] } }],
      ['ae_apply_effect', { layer: 'ADJ', effect: 'ADBE Gaussian Blur 2', params: { 'Blur Dimensions': 2 }, reuseExisting: true }],
      ['ae_animate_layer', { layer: 'T', entry: 'pixel-letter-reveal', entryStart: 1, wordTimes: [{ start: 1, end: 1.4 }], exit: 'pixel-out', exitStart: 2.5, exitEnd: 3, microMotion: 'breathe' }],
      ['ae_add_micro_motion', { layers: ['E', 'ADJ'], style: 'sway' }],
      ['ae_add_markers', { markers: [{ time: 6, comment: 'end card', duration: 1 }] }],
      ['ae_set_layer_properties', { layer: 'E', name: 'E2', opacity: 50, rotation: 10, scale: [90, 90], parent: 'CTRL', blendingMode: 'SCREEN', moveTo: 'bottom', locked: true }],
      ['ae_set_layer_properties', { layer: 'S01_text_name', text: 'SOMRAT DUTTA.', color: '#F5F5F0' }],
      ['ae_delete_layers', { layers: ['CTRL'] }],
      ['ae_set_comp_settings', { frameRate: 30, backgroundColor: '#101010', workAreaStart: 0, workAreaDuration: 5 }],
      ['ae_create_comp', { name: 'Logo', duration: 3 }],
      ['ae_find_fonts', { query: 'inter' }],
      ['ae_render', { compId: 'Solo Founder Intro MAIN', outputPath: `${project.root}/renders/final.mp4` }],
      ['ae_save_project', {}],
      ['ae_run_script', { script: 'var c = __aeRequireComp("Solo Founder Intro MAIN"); return __aeResult({ success: true, layers: c.numLayers });' }],
    ];
    for (const [name, args] of steps) {
      const r = await call(name, args);
      if (r.success !== true) throw new Error(`${name} failed: ${JSON.stringify(r)}`);
    }
    expect(ae.undoDepth).toBe(0);
    const c = comp();
    expect(prop(c.layer('T'), 'ADBE Transform Group', 'ADBE Scale').keys[0].easeIn).toHaveLength(2);
    expect(prop(c.layer('T'), 'ADBE Transform Group', 'ADBE Position').keys[0].inType).toBe(6612);
    expect(prop(c.layer('ADJ'), 'ADBE Effect Parade').numProperties).toBe(1);
    expect(prop(c.layer('ADJ'), 'ADBE Effect Parade', 'ADBE Gaussian Blur 2', 'Blurriness').keys).toHaveLength(2);
    expect(c.layer('E2').locked).toBe(true);
    expect(c.layer('E2').index).toBe(c.numLayers);
    expect(c.layer('CTRL')).toBeNull();
    expect(prop(c.layer('S01_text_name'), 'ADBE Text Properties', 'ADBE Text Document').value.text).toBe('SOMRAT DUTTA.');
    expect(ae.log.some((l) => l.startsWith('render H.264 - Match Render Settings - 15 Mbps'))).toBe(true);
  });

  it('refuses to clobber an unsaved project and names the fix', async () => {
    ae.project.dirty = true;
    const r = await call('ae_new_project', {});
    expect(r).toMatchObject({ success: false, status: 'unsaved_changes' });
  });

  it('returns After Effects errors instead of claiming success', async () => {
    const r = await call('ae_set_keyframes', { layer: 'No Such Layer', property: 'Opacity', keyframes: [{ time: 0, value: 1 }] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Layer not found');
    const bad = await call('ae_set_keyframes', { layer: 'S01_text_name', property: 'Effects/Nope', keyframes: [{ time: 0, value: 1 }] });
    expect(bad.error).toContain("Property 'ADBE Effect Parade/Nope' not found");
    expect(ae.undoDepth).toBe(0);
  });
});
