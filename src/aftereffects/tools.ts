/**
 * After Effects tools.
 *
 * Two layers of control:
 *  - Storyboard-driven: ae_setup_from_storyboard and ae_build_scene build the
 *    approved storyboard.json scene by scene, with named layers, live text,
 *    speech-synced reveals, micro-motion and exits. This is the main path.
 *  - Direct: comps, layers, keyframes, expressions, effects and markers, for
 *    the fixes an editor asks for after looking at a scene.
 *
 * Every tool reaches After Effects through the same file bridge as Premiere,
 * on its own folder (AE_TEMP_DIR, default /tmp/ae-mcp-bridge).
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolModule } from '../tools/context.js';
import { HEALTH_CHECK_TIMEOUT_MS } from '../bridge/index.js';
import {
  AE_BLEND_MODES, addFootageLayerScript, addMarkersScript, addShapeLayerScript, addSolidLayerScript, addTextLayerScript,
  animateLayerScript, applyEffectScript, buildSceneScript, compInfoScript, createCompScript, deleteLayersScript,
  findFontsScript, importFilesScript, microMotionScript, newProjectScript, openCompScript, openProjectScript,
  projectInfoScript, renderScript, runScript, saveFramesScript, saveProjectScript, setCompSettingsScript,
  setExpressionScript, setKeyframesScript, setLayerPropertiesScript, setupFromStoryboardScript, verifyConnectionScript,
  type AnimationPlan,
} from './scripts.js';
import { ENTRY_PRESETS, EXIT_PRESETS, MICRO_MOTIONS, loadResolvedStoryboard, resolvePathFrom } from '../motion/storyboard.js';
import { buildContactSheet, slugify } from '../motion/tools.js';
import { fileExists } from '../motion/exec.js';

const compId = z.union([z.string(), z.number()]).optional().describe('Composition id or name (from ae_get_project_info). Defaults to the active comp.');
const layerRef = z.union([z.string(), z.number()]).describe('Layer name, or its 1-based index (1 = top)');
const xy = z.tuple([z.number(), z.number()]);
const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #3DDC84');
const abs = (p: string): string => resolve(p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));

const RENDER_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

export function compNameFor(title: string): string {
  return `${title} MAIN`;
}

async function exec(ctx: ToolContext, script: string, timeoutMs?: number): Promise<any> {
  return ctx.bridge.executeScript(script, timeoutMs);
}

async function verify(ctx: ToolContext, args: { launchIfNeeded?: boolean; enableFileAccess?: boolean }): Promise<unknown> {
  if (ctx.bridge.ensureHost) {
    const host = await ctx.bridge.ensureHost({ launchIfNeeded: args.launchIfNeeded !== false });
    if (!host.ready) return host;
  }
  const result = await exec(ctx, verifyConnectionScript(args.enableFileAccess !== false), HEALTH_CHECK_TIMEOUT_MS * 2);
  const dir = (ctx.bridge as { bridgeDirectory?: string }).bridgeDirectory;
  return { ...result, bridgeDirectory: dir ?? null };
}

/** The moment in each beat where everything has landed and nothing has started leaving. */
function reviewTime(beat: { beat: { start: number; end: number }; elements: Array<{ timing: { revealEnd: number; exitStart: number } }> }): number {
  const { start, end } = beat.beat;
  if (!beat.elements.length) return (start + end) / 2;
  const landed = Math.max(...beat.elements.map((e) => e.timing.revealEnd));
  const leaving = Math.min(...beat.elements.map((e) => e.timing.exitStart));
  const t = leaving > landed ? (landed + leaving) / 2 : landed;
  return Math.round(Math.min(end - 0.05, Math.max(start, t)) * 100) / 100;
}

async function waitForFiles(paths: string[], timeoutMs: number): Promise<Set<string>> {
  const deadline = Date.now() + timeoutMs;
  const found = new Set<string>();
  while (Date.now() < deadline) {
    for (const p of paths) if (!found.has(p) && (await fileExists(p))) found.add(p);
    if (found.size === paths.length) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return found;
}

async function saveFrames(ctx: ToolContext, args: { compId?: string | number; times?: number[]; storyboardPath?: string; beats?: string[]; outputDir?: string; contactSheet?: boolean }): Promise<unknown> {
  const labelled: Array<{ time: number; label: string }> = [];
  let outputDir = args.outputDir ? abs(args.outputDir) : null;
  let comp = args.compId;
  if (args.storyboardPath) {
    const sbPath = abs(args.storyboardPath);
    const resolved = await loadResolvedStoryboard(sbPath);
    comp = comp ?? compNameFor(resolved.storyboard.title);
    outputDir = outputDir ?? join(dirname(dirname(sbPath)), 'review');
    for (const b of resolved.beats) {
      if (args.beats?.length && !args.beats.includes(b.beat.id)) continue;
      labelled.push({ time: reviewTime(b), label: b.beat.id });
    }
  }
  for (const t of args.times ?? []) labelled.push({ time: t, label: `t${t.toFixed(2).replace('.', '_')}` });
  if (!labelled.length) return { success: false, retry: false, error: 'Pass times, or storyboardPath to grab one frame per beat.' };
  if (!outputDir) return { success: false, retry: false, error: 'Pass outputDir (or storyboardPath, which defaults to <project>/review).' };
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const frames = labelled.map((f) => ({ time: f.time, label: f.label, path: join(outputDir!, `${f.label}_${stamp}.png`) }));
  const result = await exec(ctx, saveFramesScript(comp, frames.map(({ time, path }) => ({ time, path }))), 10 * 60 * 1000);
  if (!result || result.success === false) return result;

  // saveFrameToPng writes asynchronously; render-queue frames get a frame number appended.
  const reported: Array<{ path?: string; method?: string }> = Array.isArray(result.frames) ? result.frames : [];
  const direct = reported.filter((f) => f.method === 'saveFrameToPng' && typeof f.path === 'string').map((f) => f.path!);
  const found = await waitForFiles(direct, 20000);
  const saved: Array<{ label: string; time: number; path: string }> = [];
  const missing: Array<{ label: string; time: number }> = [];
  const listing = await fs.readdir(outputDir);
  for (const f of frames) {
    if (found.has(f.path)) { saved.push({ label: f.label, time: f.time, path: f.path }); continue; }
    const base = basename(f.path, '.png');
    const numbered = listing.find((name) => name.startsWith(`${base}_`) && name.endsWith('.png'));
    if (numbered) saved.push({ label: f.label, time: f.time, path: join(outputDir, numbered) });
    else missing.push({ label: f.label, time: f.time });
  }
  let sheet: unknown = null;
  if (args.contactSheet !== false && saved.length > 1) {
    sheet = await buildContactSheet({ images: saved.map((s) => s.path), outputPath: join(outputDir, `contact-sheet_${stamp}.png`), columns: Math.min(4, saved.length) });
  }
  return {
    success: saved.length > 0,
    frames: saved,
    missing,
    contactSheet: sheet,
    ...(missing.length ? { note: 'Some frames were not written. If none were, turn on Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network in After Effects (ae_verify_connection can do it).' } : {}),
    nextStep: 'Read the contact sheet (or frames) and check every scene against the storyboard and the rules. List problems and fix them before showing the editor.',
  };
}

async function setupFromStoryboard(ctx: ToolContext, args: { storyboardPath: string; compName?: string; projectPath?: string; reuseComp?: boolean }): Promise<unknown> {
  const sbPath = abs(args.storyboardPath);
  const resolved = await loadResolvedStoryboard(sbPath);
  const sb = resolved.storyboard;
  const footagePath = resolvePathFrom(sbPath, sb.footage.path);
  if (!(await fileExists(footagePath))) return { success: false, retry: false, error: `Footage not found: ${footagePath}` };
  const projectDir = dirname(dirname(sbPath));
  const result = await exec(ctx, setupFromStoryboardScript({
    compName: args.compName ?? compNameFor(sb.title),
    footagePath,
    output: sb.output,
    duration: sb.footage.duration ?? resolved.duration ?? null,
    background: sb.style.background,
    markers: resolved.beats.map((b) => ({ time: b.beat.start, comment: `${b.beat.id} ${b.beat.name}`, duration: b.beat.end - b.beat.start })),
    projectPath: args.projectPath ? abs(args.projectPath) : undefined,
    defaultProjectPath: join(projectDir, 'ae', `${slugify(sb.title)}.aep`),
    reuseComp: args.reuseComp !== false,
  }), BUILD_TIMEOUT_MS);
  const errors = resolved.issues.filter((i) => i.level === 'error');
  return {
    ...result,
    storyboardErrors: errors,
    beats: resolved.beats.map((b) => b.beat.id),
    nextStep: errors.length
      ? 'The storyboard has rule errors. Fix them (motion_build_storyboard) before building scenes.'
      : `Build scene by scene: ae_build_scene with beatId ${resolved.beats[0]?.beat.id ?? 'S01'}, check it, then the next.`,
  };
}

async function buildScene(ctx: ToolContext, args: { storyboardPath: string; beatId: string; compId?: string | number; replace?: boolean; ignoreRuleErrors?: boolean }): Promise<unknown> {
  const sbPath = abs(args.storyboardPath);
  const resolved = await loadResolvedStoryboard(sbPath);
  const beat = resolved.beats.find((b) => b.beat.id === args.beatId);
  if (!beat) return { success: false, retry: false, error: `Beat ${args.beatId} is not in the storyboard. Beats: ${resolved.beats.map((b) => b.beat.id).join(', ')}` };
  const beatIssues = resolved.issues.filter((i) => i.beat === beat.beat.id);
  const beatErrors = beatIssues.filter((i) => i.level === 'error');
  if (beatErrors.length && !args.ignoreRuleErrors) {
    return {
      success: false, retry: false, status: 'storyboard_rule_errors', issues: beatErrors,
      error: `${beat.beat.id} breaks the storyboard rules, so it was not built. Fix storyboard.json (and rebuild the HTML), or pass ignoreRuleErrors:true if the editor approved the exception.`,
    };
  }
  const mediaPaths: Record<string, string> = {};
  for (const el of beat.elements) {
    if (el.element.kind !== 'media' || !el.element.src) continue;
    const p = resolvePathFrom(sbPath, el.element.src);
    if (!(await fileExists(p))) return { success: false, retry: false, error: `${el.layerName}: media file not found: ${p}` };
    mediaPaths[el.element.id] = p;
  }
  const result = await exec(ctx, buildSceneScript({
    compRef: args.compId ?? compNameFor(resolved.storyboard.title),
    beat,
    output: resolved.storyboard.output,
    pixelSize: resolved.storyboard.style.pixelSize,
    replace: args.replace !== false,
    mediaPaths,
  }), BUILD_TIMEOUT_MS);
  const next = resolved.beats[resolved.beats.findIndex((b) => b.beat.id === beat.beat.id) + 1];
  return {
    ...result,
    storyboardWarnings: beatIssues.filter((i) => i.level === 'warning'),
    nextStep: `Check ${beat.beat.id}: ae_save_frames with storyboardPath and beats ["${beat.beat.id}"], look at the frame, fix anything off.${next ? ` Then ae_build_scene ${next.beat.id}.` : ' That was the last scene: run the full review (ae_save_frames with storyboardPath) before rendering.'}${(next && resolved.beats.indexOf(next) % 3 === 0) ? ' You have built a few scenes: render a contact sheet of all built scenes and check them against the rules now.' : ''}`,
  };
}

async function render(ctx: ToolContext, args: { compId?: string | number; outputPath: string; format?: 'h264' | 'prores' | 'prores4444' | 'png-sequence'; template?: string; useMediaEncoder?: boolean; workAreaOnly?: boolean }): Promise<unknown> {
  const outputPath = abs(args.outputPath);
  const result = await exec(ctx, renderScript({
    compRef: args.compId, outputPath, format: args.format ?? 'h264', template: args.template,
    useMediaEncoder: args.useMediaEncoder === true, workAreaOnly: args.workAreaOnly === true, startRender: true,
  }), RENDER_TIMEOUT_MS);
  if (result?.status === 'done') {
    const out = String(result.outputPath ?? outputPath);
    try {
      const st = await fs.stat(out);
      return { ...result, bytes: st.size };
    } catch {
      return { ...result, note: 'Render reported done; the file name may carry an extension After Effects added. Check the renders folder.' };
    }
  }
  return result;
}

function plan(args: { entry?: string; entryStart?: number; entryDuration?: number; exit?: string; exitStart?: number; exitEnd?: number; pixelSize?: number }, outputHeight = 1080): AnimationPlan {
  const inT = args.entryStart ?? 0;
  const inDuration = args.entryDuration ?? 0.6;
  const out = args.exitEnd ?? (args.exitStart !== undefined ? args.exitStart + 0.4 : 1e6);
  return {
    entry: args.entry ?? 'none',
    exit: args.exit ?? 'none',
    in: inT,
    inDuration,
    revealEnd: inT + inDuration,
    exitStart: args.exitStart ?? out,
    out,
    charKeys: [{ t: inT, chars: 0 }, { t: inT + inDuration, chars: 100 }],
    totalChars: 100,
    pixelSize: (args.pixelSize ?? 12) * (outputHeight / 1080),
    scale: outputHeight / 1080,
  };
}

const keyframeValue = z.union([z.number(), z.array(z.number()), hex]);

export const aeTools: ToolModule[] = [
  // ------------------------------------------------------------ connection & project
  {
    name: 'ae_verify_connection',
    description: 'Readiness check for After Effects and its MCP Bridge panel. Call this first, once per session. Launches After Effects if it is installed and not running, waits for the panel, and turns on the "Allow Scripts to Write Files" setting that saving review frames needs. If it fails, tell the user the nextStep and stop.',
    inputSchema: z.object({
      launchIfNeeded: z.boolean().optional().describe('Launch After Effects when it is not running (default true)'),
      enableFileAccess: z.boolean().optional().describe('Turn on "Allow Scripts to Write Files and Access Network" if it is off (default true)'),
    }),
    run: (ctx, args) => verify(ctx, args),
  },
  {
    name: 'ae_get_project_info',
    description: 'Lists everything in the open After Effects project: compositions (with ids), footage (with paths), folders, and which comp is active.',
    inputSchema: z.object({}),
    run: (ctx) => exec(ctx, projectInfoScript()),
  },
  {
    name: 'ae_new_project',
    description: 'Starts a new, empty After Effects project and optionally saves it. Refuses if the open project has unsaved changes unless discardUnsavedChanges is true.',
    inputSchema: z.object({
      savePath: z.string().optional().describe('Absolute .aep path to save the new project to, e.g. <project>/ae/name.aep'),
      discardUnsavedChanges: z.boolean().optional(),
    }),
    run: (ctx, args) => exec(ctx, newProjectScript(args.savePath ? abs(args.savePath) : undefined, args.discardUnsavedChanges === true)),
  },
  {
    name: 'ae_open_project',
    description: 'Opens an .aep project file.',
    inputSchema: z.object({ path: z.string().min(1), discardUnsavedChanges: z.boolean().optional() }),
    run: (ctx, args) => exec(ctx, openProjectScript(abs(args.path), args.discardUnsavedChanges === true)),
  },
  {
    name: 'ae_save_project',
    description: 'Saves the After Effects project, or saves it to a new path.',
    inputSchema: z.object({ path: z.string().optional().describe('Absolute .aep path. Required the first time.') }),
    run: (ctx, args) => exec(ctx, saveProjectScript(args.path ? abs(args.path) : undefined)),
  },
  {
    name: 'ae_import_files',
    description: 'Imports footage, images, audio or an image sequence (e.g. a Blender PNG render) into the project. Already-imported files are reused.',
    inputSchema: z.object({
      paths: z.array(z.string()).min(1).describe('Absolute paths. For a sequence, pass its first frame.'),
      folderName: z.string().optional().describe('Project panel folder to put them in'),
      asSequence: z.boolean().optional().describe('Import numbered images as one sequence'),
    }),
    run: (ctx, args) => exec(ctx, importFilesScript(args.paths.map(abs), args.folderName, args.asSequence === true), BUILD_TIMEOUT_MS),
  },
  {
    name: 'ae_find_fonts',
    description: 'Searches installed fonts and returns their PostScript names, which After Effects needs (e.g. "Inter-Bold"). Needs After Effects 2024 or newer.',
    inputSchema: z.object({ query: z.string().optional().describe('Part of the family, style or PostScript name'), limit: z.number().int().positive().max(200).optional() }),
    run: (ctx, args) => exec(ctx, findFontsScript(args.query ?? '', args.limit ?? 40)),
  },
  // ------------------------------------------------------------ storyboard-driven build
  {
    name: 'ae_setup_from_storyboard',
    description: 'Prepares After Effects for an approved storyboard: imports the raw footage, creates the main comp at the output size and frame rate (default 1920x1080, 60 fps), puts the footage as one uncut locked layer at the bottom (BG_raw_footage), adds one marker per beat, and saves the project into <project>/ae if it was never saved. Safe to run again.',
    inputSchema: z.object({
      storyboardPath: z.string().min(1).describe('Absolute path to storyboard.json'),
      compName: z.string().optional().describe('Defaults to "<title> MAIN"'),
      projectPath: z.string().optional().describe('Save the project here (Save As)'),
      reuseComp: z.boolean().optional().describe('Reuse an existing comp with the same name (default true)'),
    }),
    run: (ctx, args) => setupFromStoryboard(ctx, args),
  },
  {
    name: 'ae_build_scene',
    description: 'Builds one storyboard beat in After Effects as organised, editable layers: S01_text_<id> live text layers with their letter or pixel reveals timed to the spoken words, shapes and media, micro-motion on everything, and exits that start only after the hold. Replaces the beat\'s previous layers, so it is safe to rebuild after feedback. Build one scene, check it with ae_save_frames, then the next.',
    inputSchema: z.object({
      storyboardPath: z.string().min(1),
      beatId: z.string().regex(/^S\d{2,3}$/).describe('e.g. S01'),
      compId,
      replace: z.boolean().optional().describe('Delete this beat\'s existing layers first (default true)'),
      ignoreRuleErrors: z.boolean().optional().describe('Build even if the storyboard check found rule errors in this beat. Only when the editor approved the exception.'),
    }),
    run: (ctx, args) => buildScene(ctx, args),
  },
  {
    name: 'ae_save_frames',
    description: 'Saves still PNG frames from a comp and tiles them into a contact sheet for review. With storyboardPath it grabs one frame per beat at the moment everything has landed, into <project>/review. Read the images to check your work against the storyboard and rules.',
    inputSchema: z.object({
      compId,
      storyboardPath: z.string().optional().describe('Grab one frame per beat of this storyboard'),
      beats: z.array(z.string()).optional().describe('Only these beat ids, e.g. ["S03"]'),
      times: z.array(z.number().min(0)).optional().describe('Extra times in seconds'),
      outputDir: z.string().optional(),
      contactSheet: z.boolean().optional().describe('Also build a contact sheet (default true)'),
    }),
    run: (ctx, args) => saveFrames(ctx, args),
  },
  {
    name: 'ae_render',
    description: 'Renders a comp through the After Effects render queue (or sends it to Media Encoder) with its audio. The comp sets the size and frame rate (ae_set_comp_settings to change them). After Effects is busy until the render finishes.',
    inputSchema: z.object({
      compId,
      outputPath: z.string().min(1).describe('Absolute output path, e.g. <project>/renders/final.mp4'),
      format: z.enum(['h264', 'prores', 'prores4444', 'png-sequence']).optional().describe('h264 (default) for delivery, prores for mastering, prores4444 for overlays with transparency'),
      template: z.string().optional().describe('Exact output module template name, overriding format'),
      useMediaEncoder: z.boolean().optional().describe('Queue in Adobe Media Encoder instead of rendering in After Effects'),
      workAreaOnly: z.boolean().optional().describe('Render only the work area (default: whole comp)'),
    }),
    run: (ctx, args) => render(ctx, args),
  },
  // ------------------------------------------------------------ compositions
  {
    name: 'ae_create_comp',
    description: 'Creates a composition.',
    inputSchema: z.object({
      name: z.string().min(1),
      width: z.number().int().positive().optional().describe('Default 1920'),
      height: z.number().int().positive().optional().describe('Default 1080'),
      frameRate: z.number().positive().optional().describe('Default 60'),
      duration: z.number().positive().describe('Seconds'),
      pixelAspect: z.number().positive().optional(),
      backgroundColor: hex.optional(),
      folderName: z.string().optional(),
      open: z.boolean().optional().describe('Open it in the viewer (default true)'),
    }),
    run: (ctx, args) => exec(ctx, createCompScript({
      name: args.name, width: args.width ?? 1920, height: args.height ?? 1080, frameRate: args.frameRate ?? 60, duration: args.duration,
      pixelAspect: args.pixelAspect ?? 1, backgroundColor: args.backgroundColor, folderName: args.folderName, open: args.open !== false,
    })),
  },
  {
    name: 'ae_get_comp_info',
    description: 'Describes a comp: settings, every layer (index, name, type, timing, text, effects, position) and its markers.',
    inputSchema: z.object({ compId }),
    run: (ctx, args) => exec(ctx, compInfoScript(args.compId)),
  },
  {
    name: 'ae_set_comp_settings',
    description: 'Changes comp settings: name, size, frame rate, duration, background colour, work area, motion blur.',
    inputSchema: z.object({
      compId,
      name: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
      frameRate: z.number().positive().optional(), duration: z.number().positive().optional(), backgroundColor: hex.optional(),
      workAreaStart: z.number().min(0).optional(), workAreaDuration: z.number().positive().optional(), motionBlur: z.boolean().optional(),
    }),
    run: (ctx, args) => exec(ctx, setCompSettingsScript(args.compId, args)),
  },
  {
    name: 'ae_open_comp',
    description: 'Opens a comp in the viewer so the editor sees it.',
    inputSchema: z.object({ compId: z.union([z.string(), z.number()]) }),
    run: (ctx, args) => exec(ctx, openCompScript(args.compId)),
  },
  // ------------------------------------------------------------ layers
  {
    name: 'ae_add_footage_layer',
    description: 'Adds footage, an image or an image sequence to a comp as a layer, from a project item or a file path. Can place it at the bottom, fit it to the frame, and lock it.',
    inputSchema: z.object({
      compId,
      itemId: z.union([z.string(), z.number()]).optional().describe('Project item id or name'),
      path: z.string().optional().describe('Absolute file path (imported if needed)'),
      asSequence: z.boolean().optional(),
      name: z.string().optional(),
      startTime: z.number().optional(), inPoint: z.number().optional(), outPoint: z.number().optional(),
      placement: z.enum(['top', 'bottom']).optional(), fit: z.enum(['none', 'cover', 'contain']).optional(),
      locked: z.boolean().optional(), position: xy.optional(),
    }),
    run: (ctx, args) => {
      if (!args.itemId && !args.path) return { success: false, retry: false, error: 'Pass itemId or path.' };
      return exec(ctx, addFootageLayerScript({
        compRef: args.compId, itemRef: args.itemId, path: args.path ? abs(args.path) : undefined, asSequence: args.asSequence === true,
        name: args.name, startTime: args.startTime, inPoint: args.inPoint, outPoint: args.outPoint,
        placement: args.placement ?? 'top', fit: args.fit ?? 'none', locked: args.locked === true, position: args.position,
      }), BUILD_TIMEOUT_MS);
    },
  },
  {
    name: 'ae_add_text_layer',
    description: 'Adds a live, editable text layer. Positions are comp pixels; the anchor is set so position means the text centre (or left/right edge).',
    inputSchema: z.object({
      compId,
      text: z.string().describe('Use \\r for a line break'),
      name: z.string().optional().describe('Layer name, e.g. S03_text_hero'),
      font: z.string().optional().describe('PostScript name, e.g. Inter-Bold (see ae_find_fonts)'),
      fontSize: z.number().positive().optional(), color: hex.optional(),
      strokeColor: hex.optional(), strokeWidth: z.number().min(0).optional(),
      tracking: z.number().optional(), leading: z.number().positive().optional(),
      justification: z.enum(['left', 'center', 'right']).optional(), allCaps: z.boolean().optional(),
      position: xy.optional(), anchor: z.enum(['center', 'left', 'right']).optional(),
      inPoint: z.number().optional(), outPoint: z.number().optional(),
      boxSize: xy.optional().describe('Paragraph text box [width, height] in pixels'),
    }),
    run: (ctx, args) => exec(ctx, addTextLayerScript({ ...args, compRef: args.compId, anchor: args.anchor ?? 'center' })),
  },
  {
    name: 'ae_add_shape_layer',
    description: 'Adds a rectangle or ellipse shape layer (fill and/or stroke, rounded corners).',
    inputSchema: z.object({
      compId,
      shape: z.enum(['rectangle', 'ellipse']), size: xy.describe('[width, height] in pixels'), position: xy.optional(),
      fillColor: hex.optional(), strokeColor: hex.optional(), strokeWidth: z.number().min(0).optional(), roundness: z.number().min(0).optional(),
      name: z.string().optional(), inPoint: z.number().optional(), outPoint: z.number().optional(),
    }),
    run: (ctx, args) => exec(ctx, addShapeLayerScript({ ...args, compRef: args.compId })),
  },
  {
    name: 'ae_add_solid_layer',
    description: 'Adds a solid colour layer, an adjustment layer (effects on it apply to everything below), or a null (for parenting).',
    inputSchema: z.object({
      compId,
      kind: z.enum(['solid', 'adjustment', 'null']), name: z.string().optional(), color: hex.optional(),
      width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
      inPoint: z.number().optional(), outPoint: z.number().optional(),
    }),
    run: (ctx, args) => exec(ctx, addSolidLayerScript({ ...args, compRef: args.compId })),
  },
  {
    name: 'ae_set_layer_properties',
    description: 'Changes a layer: name, timing, enabled, locked, 3D, parent, blending mode, label, stacking, static transform values (position, scale, rotation, opacity, anchor) and, for text layers, the text, colour, font and size.',
    inputSchema: z.object({
      compId, layer: layerRef,
      name: z.string().optional(), inPoint: z.number().optional(), outPoint: z.number().optional(), startTime: z.number().optional(),
      enabled: z.boolean().optional(), locked: z.boolean().optional(), shy: z.boolean().optional(), threeD: z.boolean().optional(),
      parent: z.union([z.string(), z.number(), z.null()]).optional().describe('Layer to parent to, or null to unparent'),
      blendingMode: z.enum(AE_BLEND_MODES).optional(), label: z.number().int().min(0).max(16).optional(),
      moveTo: z.enum(['top', 'bottom']).optional(),
      position: xy.optional(), scale: z.union([z.number(), xy]).optional().describe('Percent'), rotation: z.number().optional(),
      opacity: z.number().min(0).max(100).optional(), anchorPoint: xy.optional(),
      text: z.string().optional(), color: hex.optional(), fontSize: z.number().positive().optional(), font: z.string().optional(),
    }),
    run: (ctx, args) => {
      const { compId: c, layer, ...props } = args;
      return exec(ctx, setLayerPropertiesScript(c, layer, props));
    },
  },
  {
    name: 'ae_delete_layers',
    description: 'Deletes layers by name or index, or every layer whose name starts with a prefix (e.g. "S04_" to clear a scene).',
    inputSchema: z.object({ compId, layers: z.array(z.union([z.string(), z.number()])).optional(), namePrefix: z.string().optional() }),
    run: (ctx, args) => {
      if (!args.layers?.length && !args.namePrefix) return { success: false, retry: false, error: 'Pass layers or namePrefix.' };
      return exec(ctx, deleteLayersScript(args.compId, args.layers ?? [], args.namePrefix));
    },
  },
  // ------------------------------------------------------------ animation
  {
    name: 'ae_set_keyframes',
    description: 'Sets keyframes on any layer property. Property is a path of names or match names, e.g. "Position", "Opacity", "Transform/Scale", "Effects/Mosaic/Horizontal Blocks". Values are numbers, arrays ([x, y]) or hex colours.',
    inputSchema: z.object({
      compId, layer: layerRef, property: z.string().min(1),
      keyframes: z.array(z.object({ time: z.number().min(0), value: keyframeValue })).min(1),
      interpolation: z.enum(['ease', 'linear', 'hold']).optional().describe('Default ease (smooth, no abrupt moves)'),
      easeInfluence: z.number().min(0.1).max(100).optional().describe('Ease strength 0.1-100 (default 75)'),
      clearExisting: z.boolean().optional().describe('Remove the property\'s existing keyframes first'),
    }),
    run: (ctx, args) => exec(ctx, setKeyframesScript(args.compId, args.layer, args.property, args.keyframes, args.interpolation ?? 'ease', args.easeInfluence ?? 75, args.clearExisting === true)),
  },
  {
    name: 'ae_set_expression',
    description: 'Sets (or clears, with an empty string) an expression on a layer property. Returns After Effects\' error if the expression does not compile.',
    inputSchema: z.object({ compId, layer: layerRef, property: z.string().min(1), expression: z.string() }),
    run: (ctx, args) => exec(ctx, setExpressionScript(args.compId, args.layer, args.property, args.expression)),
  },
  {
    name: 'ae_animate_layer',
    description: 'Applies an entrance and/or exit preset to an existing layer: letter-reveal, pixel-letter-reveal, pixel-resolve, fade-up, fade, pop, grow-x in; fade, pixel-out, fade-down out. Letter reveals can follow word times from words.json so each word appears as it is spoken. Optionally adds micro-motion.',
    inputSchema: z.object({
      compId, layer: layerRef,
      entry: z.enum(ENTRY_PRESETS).optional(), entryStart: z.number().min(0).optional(), entryDuration: z.number().positive().optional(),
      wordTimes: z.array(z.object({ start: z.number().min(0), end: z.number().min(0) })).optional().describe('One {start, end} per on-screen word, from words.json'),
      exit: z.enum(EXIT_PRESETS).optional(), exitStart: z.number().min(0).optional(), exitEnd: z.number().min(0).optional(),
      pixelSize: z.number().positive().optional().describe('Pixel block size at 1080p (default 12)'),
      microMotion: z.enum(MICRO_MOTIONS).optional(),
    }),
    run: (ctx, args) => {
      const p = plan(args);
      if (args.wordTimes?.length) {
        const last = args.wordTimes[args.wordTimes.length - 1]!;
        p.in = args.entryStart ?? args.wordTimes[0]!.start;
        p.revealEnd = last.end + (args.entry === 'pixel-letter-reveal' ? 0.25 : 0);
      }
      return exec(ctx, animateLayerScript({ compRef: args.compId, layer: args.layer, plan: p, micro: args.microMotion ? { style: args.microMotion } : undefined, wordTimes: args.wordTimes }));
    },
  },
  {
    name: 'ae_add_micro_motion',
    description: 'Adds gentle continuous motion so nothing sits static: drift (slow position wander), breathe (tiny scale pulse), sway (slight rotation) or float (soft wiggle). Uses expressions, so keyframed animation still works underneath.',
    inputSchema: z.object({
      compId,
      layers: z.array(z.union([z.string(), z.number()])).min(1),
      style: z.enum(['drift', 'breathe', 'sway', 'float', 'none']),
      amount: z.number().min(0).optional().describe('Pixels for drift/float, fraction for breathe (0.015), degrees for sway'),
      speed: z.number().min(0).optional().describe('Cycles per second (keep under 0.6 for calm motion)'),
    }),
    run: (ctx, args) => exec(ctx, microMotionScript(args.compId, args.layers, { style: args.style, amount: args.amount, speed: args.speed })),
  },
  // ------------------------------------------------------------ effects & markers
  {
    name: 'ae_apply_effect',
    description: 'Applies an effect to a layer by match name (e.g. "ADBE Gaussian Blur 2", "ADBE Mosaic", "ADBE Glo2") or English display name, sets parameters, and can keyframe them. Returns the effect\'s parameter list.',
    inputSchema: z.object({
      compId, layer: layerRef, effect: z.string().min(1),
      params: z.record(z.string(), z.union([z.number(), z.boolean(), z.array(z.number()), z.string()])).optional().describe('Parameter name (or 1-based index) to value'),
      keyframes: z.record(z.string(), z.array(z.object({ time: z.number().min(0), value: keyframeValue }))).optional(),
      reuseExisting: z.boolean().optional().describe('Change the layer\'s existing copy of this effect instead of adding another'),
    }),
    run: (ctx, args) => exec(ctx, applyEffectScript(args.compId, args.layer, args.effect, args.params ?? {}, args.keyframes ?? {}, args.reuseExisting === true)),
  },
  {
    name: 'ae_add_markers',
    description: 'Adds comp markers (one per scene is the convention), skipping ones that already exist.',
    inputSchema: z.object({
      compId,
      markers: z.array(z.object({ time: z.number().min(0), comment: z.string(), duration: z.number().min(0).optional(), label: z.number().int().min(0).max(16).optional() })).min(1),
    }),
    run: (ctx, args) => exec(ctx, addMarkersScript(args.compId, args.markers)),
  },
  {
    name: 'ae_run_script',
    description: 'Runs your own ExtendScript in After Effects, for anything the other tools do not cover. The body runs inside a function with the ae helpers available (__aeRequireComp, __aeRequireLayer, __aeProp, __aeHex, __aeSetKeys, __aeAddEffect...) and must return __aeResult({...}). It is wrapped in an undo group. Prefer the specific tools; read the error and fix the script if it fails.',
    inputSchema: z.object({ script: z.string().min(1).describe('ExtendScript (ES3) body ending in return __aeResult({ success: true, ... })') }),
    run: (ctx, args) => exec(ctx, runScript(args.script), BUILD_TIMEOUT_MS),
  },
];
