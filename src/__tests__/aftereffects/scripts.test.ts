/**
 * Every After Effects tool, driven through the real tool pipeline with a fake
 * bridge, must emit a script that:
 *   - parses as ES3 (what ExtendScript is),
 *   - is accepted by the CEP panel's own safety filter, and
 *   - uses none of the ES5 methods ExtendScript lacks.
 * Then the storyboard-driven tools are checked for what they actually build.
 */
import { parse } from 'acorn';
import { rmSync, writeFileSync } from 'node:fs';
import { PremiereProTools } from '../../tools/index';
import { AE_HELPERS } from '../../aftereffects/prelude';
import { aeTools } from '../../aftereffects/tools';
import { motionTools } from '../../motion/tools';
import { loadPanel } from '../helpers/panel';
import { makeMotionProject, storyboard, type MotionProject } from '../helpers/motion-fixture';

function fakeBridge() {
  const scripts: string[] = [];
  const bridge = {
    scripts,
    bridgeDirectory: '/tmp/ae-mcp-bridge',
    executeScript: async (source: string) => { scripts.push(source); return { success: true, status: 'done', frames: [] }; },
    ensureHost: async () => ({ ready: true, success: true, status: 'connected' }),
  };
  return bridge;
}

const parsesAsEs3 = (source: string): void => {
  parse(`(function(){\n${source}\n})();`, { ecmaVersion: 3, allowReturnOutsideFunction: true });
};

// ExtendScript has none of these; using one is a runtime TypeError in After Effects.
const ES5_ONLY = [/\.forEach\(/, /\.map\(/, /\.filter\(/, /\.reduce\(/, /Object\.keys\(/, /\.trim\(\)/, /\bconst\s/, /\blet\s/, /=>/, /\.includes\(/];
const ARRAY_INDEXOF = /\b(?:items|layers|refs|paths|frames|tpls|wanted|lens|parts|keys|out|results|removed|created|failed|warnings)\.indexOf\(/;

let project: MotionProject;
beforeAll(() => { project = makeMotionProject(); });
afterAll(() => { rmSync(project.root, { recursive: true, force: true }); });

function argsFor(name: string): Record<string, unknown> {
  const p = project;
  const table: Record<string, Record<string, unknown>> = {
    ae_verify_connection: {},
    ae_get_project_info: {},
    ae_new_project: { savePath: `${p.root}/ae/new.aep` },
    ae_open_project: { path: `${p.root}/ae/x.aep` },
    ae_save_project: { path: `${p.root}/ae/x.aep` },
    ae_import_files: { paths: [p.footagePath, `${p.root}/references/logo.png`], folderName: 'Footage', asSequence: false },
    ae_find_fonts: { query: 'inter' },
    ae_setup_from_storyboard: { storyboardPath: p.storyboardPath },
    ae_build_scene: { storyboardPath: p.storyboardPath, beatId: 'S02' },
    ae_save_frames: { storyboardPath: p.storyboardPath, contactSheet: false },
    ae_render: { outputPath: `${p.root}/renders/final.mp4`, format: 'h264' },
    ae_create_comp: { name: 'Test "quoted" comp', duration: 10, backgroundColor: '#112233' },
    ae_get_comp_info: { compId: 'Solo Founder Intro MAIN' },
    ae_set_comp_settings: { compId: 3, frameRate: 60, width: 1920, height: 1080, duration: 48, backgroundColor: '#000000', workAreaStart: 0, workAreaDuration: 10, motionBlur: true, name: 'Renamed' },
    ae_open_comp: { compId: 3 },
    ae_add_footage_layer: { path: p.footagePath, placement: 'bottom', fit: 'cover', locked: true, name: 'BG', startTime: 0, inPoint: 0, outPoint: 5, position: [960, 540] },
    ae_add_text_layer: { text: 'Line one\rLine "two" \\ end', name: 'S09_text_x', font: 'Inter-Bold', fontSize: 80, color: '#3DDC84', strokeColor: '#000000', strokeWidth: 2, tracking: 20, leading: 90, justification: 'left', allCaps: true, position: [100, 200], anchor: 'left', inPoint: 1, outPoint: 4, boxSize: [800, 300] },
    ae_add_shape_layer: { shape: 'rectangle', size: [400, 10], position: [960, 600], fillColor: '#FFFFFF', strokeColor: '#000000', strokeWidth: 2, roundness: 5, name: 'bar', inPoint: 0, outPoint: 3 },
    ae_add_solid_layer: { kind: 'adjustment', name: 'FX', inPoint: 1, outPoint: 2 },
    ae_set_layer_properties: { layer: 'S01_text_name', name: 'new', inPoint: 1, outPoint: 3, startTime: 0, enabled: true, locked: true, shy: false, threeD: true, parent: null, blendingMode: 'SCREEN', label: 3, moveTo: 'top', position: [1, 2], scale: 90, rotation: 5, opacity: 80, anchorPoint: [0, 0], text: 'NEW TEXT', color: '#FFFFFF', fontSize: 70, font: 'Inter-Bold' },
    ae_delete_layers: { layers: ['a', 2], namePrefix: 'S04_' },
    ae_set_keyframes: { layer: 1, property: 'Effects/Mosaic/Horizontal Blocks', keyframes: [{ time: 0, value: 100 }, { time: 1, value: [1, 2] }, { time: 2, value: '#FF00FF' }], interpolation: 'hold', clearExisting: true },
    ae_set_expression: { layer: 'x', property: 'Position', expression: 'wiggle(0.5, 4)' },
    ae_animate_layer: { layer: 'x', entry: 'pixel-letter-reveal', entryStart: 1, wordTimes: [{ start: 1, end: 1.4 }, { start: 1.5, end: 2 }], exit: 'pixel-out', exitStart: 4, exitEnd: 4.4, microMotion: 'breathe' },
    ae_add_micro_motion: { layers: ['a', 'b'], style: 'float' },
    ae_apply_effect: { layer: 'x', effect: 'ADBE Gaussian Blur 2', params: { Blurriness: 10, '2': 1, Color: '#FF0000' }, keyframes: { Blurriness: [{ time: 0, value: 20 }, { time: 1, value: 0 }] }, reuseExisting: true },
    ae_add_markers: { markers: [{ time: 0, comment: 'S01 intro', duration: 2, label: 1 }, { time: 2, comment: 'S02 "quote"' }] },
    ae_run_script: { script: 'var comp = __aeRequireComp(null); return __aeResult({ success: true, n: comp.numLayers });' },
  };
  const a = table[name];
  if (!a) throw new Error(`No test arguments for ${name}; add them so its script is checked.`);
  return a;
}

describe('every After Effects tool emits valid, panel-safe ExtendScript', () => {
  const panel = loadPanel({ appName: 'AEFT' });

  it('the prelude parses as ES3 and avoids ES5-only methods', () => {
    parsesAsEs3(AE_HELPERS + '\nreturn 1;');
    for (const re of ES5_ONLY) expect(AE_HELPERS).not.toMatch(re);
    expect(AE_HELPERS).not.toMatch(ARRAY_INDEXOF);
  });

  it.each(aeTools.map((t) => t.name))('%s', async (name) => {
    const bridge = fakeBridge();
    const tools = new PremiereProTools(bridge as any, { app: 'aftereffects' });
    const result = await tools.executeTool(name, argsFor(name));
    expect(result).not.toHaveProperty('status', 'validation');
    expect(bridge.scripts.length).toBeGreaterThan(0);
    for (const script of bridge.scripts) {
      parsesAsEs3(script);
      expect(panel.bridge.validateScript(script)).toBe(true);
      const body = script.slice(AE_HELPERS.length);
      for (const re of ES5_ONLY) expect(body).not.toMatch(re);
      expect(body).not.toMatch(ARRAY_INDEXOF);
    }
  });
});

describe('the After Effects server catalog', () => {
  const tools = new PremiereProTools(fakeBridge() as any, { app: 'aftereffects' });

  it('advertises every AE and motion tool directly, and no Premiere tools', () => {
    const names = tools.getAdvertisedTools().map((t) => t.name);
    expect(names).toHaveLength(aeTools.length + motionTools.length);
    expect(names.every((n) => n.startsWith('ae_') || n.startsWith('motion_'))).toBe(true);
    expect(names).not.toContain('list_sequences');
  });

  it('does not reach Premiere tools by name', async () => {
    const result = await tools.executeTool('list_sequences', {});
    expect(result).toMatchObject({ success: false, errorCode: 'tool_not_found' });
  });

  it('leaves the Premiere catalog untouched', () => {
    const premiere = new PremiereProTools(fakeBridge() as any);
    expect(premiere.getAvailableTools()).toHaveLength(283);
    expect(premiere.getAvailableTools().some((t) => t.name.startsWith('ae_'))).toBe(false);
  });

  it('points a dead bridge at ae_verify_connection, not the Premiere check', async () => {
    const dead = { executeScript: async () => { throw new Error('MCP Bridge is not running in After Effects.'); } };
    const t = new PremiereProTools(dead as any, { app: 'aftereffects' });
    const r = await t.executeTool('ae_get_project_info', {});
    expect(r).toMatchObject({ success: false, status: 'bridge_unavailable', agentAction: 'ae_verify_connection' });
  });
});

describe('building from the storyboard', () => {
  async function run(name: string, args: Record<string, unknown>) {
    const bridge = fakeBridge();
    const tools = new PremiereProTools(bridge as any, { app: 'aftereffects' });
    const result = await tools.executeTool(name, args);
    return { result, script: bridge.scripts.join('\n') };
  }

  it('sets up the main comp at the output size with the footage uncut at the bottom and a marker per beat', async () => {
    const { result, script } = await run('ae_setup_from_storyboard', { storyboardPath: project.storyboardPath });
    expect(script).toContain('var duration = 7;');
    expect(script).toContain('addComp("Solo Founder Intro MAIN", 1920, 1080, 1, duration, 60)');
    expect(script).toContain('"BG_raw_footage"');
    expect(script).toContain('bg.moveToEnd();');
    expect(script).toContain('bg.locked = true;');
    for (const m of ['S01 name card', 'S02 what i teach', 'S03 payoff']) expect(script).toContain(JSON.stringify(m));
    expect(script).toContain(JSON.stringify(`${project.root}/ae/solo-founder-intro.aep`));
    expect((result as any).beats).toEqual(['S01', 'S02', 'S03']);
  });

  it('builds a beat as named live text layers with speech-timed letter keys', async () => {
    const { script } = await run('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S01' });
    expect(script).toContain('__aeRemoveLayersWithPrefix(comp, "S01_")');
    expect(script).toContain('comp.layers.addText("SOMRAT DUTTA")');
    expect(script).toContain('L.name = "S01_text_name"');
    expect(script).toContain('"font":"Inter-Bold"');
    // Letters start with "Somrat" (0.82s) and all 11 are visible after "Dutta".
    expect(script).toMatch(/__aeLetterReveal\(L, \[\[0\.82, 0\][^\]]*\]*.*, 11\)/);
    expect(script).toContain('__aeMosaicKeys(L, comp, [[0.82, 12]');
    expect(script).toContain('__aeMicroMotion(L, "drift"');
    expect(script).toContain('L.name = "S01_shape_rule"');
  });

  it('adds a whole-frame pixel flash for pixel-flash transitions', async () => {
    const { script } = await run('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S03' });
    expect(script).toContain('"S03_transition_pixel"');
    expect(script).toContain('A.adjustmentLayer = true;');
  });

  it('refuses to build a beat that breaks the rules, unless told to', async () => {
    const sb = storyboard();
    (sb.beats as any[])[0].elements[0].x = 0.5; // onto the face
    writeFileSync(project.storyboardPath, JSON.stringify(sb));
    try {
      const refused = await run('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S01' });
      expect(refused.result).toMatchObject({ success: false, status: 'storyboard_rule_errors' });
      expect(refused.script).toBe('');
      const forced = await run('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S01', ignoreRuleErrors: true });
      expect(forced.script).toContain('S01_text_name');
    } finally {
      writeFileSync(project.storyboardPath, JSON.stringify(storyboard()));
    }
  });

  it('reports an unknown beat id clearly', async () => {
    const { result } = await run('ae_build_scene', { storyboardPath: project.storyboardPath, beatId: 'S09' });
    expect(result).toMatchObject({ success: false });
    expect(String((result as any).error)).toContain('S01, S02, S03');
  });

  it('grabs one review frame per beat at the moment everything has landed', async () => {
    const { script } = await run('ae_save_frames', { storyboardPath: project.storyboardPath, contactSheet: false });
    const frames = JSON.parse(script.match(/var frames = (\[.*?\]);/)![1]!);
    expect(frames).toHaveLength(3);
    expect(frames[0].path).toContain(`${project.root}/review/S01_`);
    expect(frames[0].time).toBeGreaterThanOrEqual(1.6);
    expect(frames[0].time).toBeLessThan(2.0);
  });
});
