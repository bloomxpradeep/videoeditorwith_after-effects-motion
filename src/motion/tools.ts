/**
 * Motion Director workflow tools: everything around After Effects that turns a
 * talking-head video into a storyboard and back into review material.
 *
 * None of these talk to an Adobe app. They run local helpers (Whisper, OpenCV,
 * ffmpeg, yt-dlp) and read or write files in the editor's project folder.
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { ToolModule } from '../tools/context.js';
import {
  INSTALL_HINTS, MOTION_SCRIPTS_DIR, fileExists, findExecutable, findPython, missingTool, probeMedia, run,
} from './exec.js';
import { applyCorrections, flagSuspectWords, normalizeWhisperJson, readTranscript, toPlainText, toSrt } from './words.js';
import { loadResolvedStoryboard, resolvePathFrom, summarizeIssues, StoryboardSchema } from './storyboard.js';
import { renderStoryboardHtml } from './storyboard-html.js';

const abs = (p: string): string => resolve(p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));

function studioRoot(): string {
  return abs(process.env.MOTION_STUDIO_DIR || process.cwd());
}

export function slugify(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'video';
}

export const PROJECT_FOLDERS = ['footage', 'references', 'transcript', 'storyboard', 'ae', 'renders', 'review'] as const;

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------- handlers

async function newProject(args: { name: string; root?: string }): Promise<unknown> {
  const root = args.root ? abs(args.root) : join(studioRoot(), 'projects');
  const dir = join(root, slugify(args.name));
  const existed = await fileExists(dir);
  for (const f of PROJECT_FOLDERS) await fs.mkdir(join(dir, f), { recursive: true });
  const readme = join(dir, 'README.md');
  if (!(await fileExists(readme))) {
    await fs.writeFile(readme, `# ${args.name}

Drop files here, then tell Claude "Done".

| Folder | What goes in it |
| --- | --- |
| footage/ | The raw video (one file, uncut) |
| references/ | Moodboard images, videos, logo, brand fonts |
| transcript/ | Made by Claude: words.json, transcript.srt, transcript.txt |
| storyboard/ | Made by Claude: storyboard.json and storyboard.html |
| ae/ | The After Effects project |
| renders/ | Final renders |
| review/ | Contact sheets and review frames |
`);
  }
  return {
    success: true,
    created: !existed,
    projectDir: dir,
    folders: Object.fromEntries(PROJECT_FOLDERS.map((f) => [f, join(dir, f)])),
    nextStep: `Ask the editor to put the raw video in ${join(dir, 'footage')} and any references or logo in ${join(dir, 'references')}.`,
  };
}

async function probe(args: { path: string }): Promise<unknown> {
  const info = await probeMedia(abs(args.path));
  if ('success' in info) return info;
  return { success: true, ...info };
}

async function transcribe(args: { mediaPath: string; outputDir?: string; model?: string; language?: string; vocabulary?: string[] }): Promise<unknown> {
  const media = abs(args.mediaPath);
  if (!(await fileExists(media))) return { success: false, retry: false, error: `File not found: ${media}` };
  const python = await findPython();
  if (!python) return missingTool('Python 3', INSTALL_HINTS.python);
  const outDir = args.outputDir ? abs(args.outputDir) : join(dirname(dirname(media)), 'transcript');
  await fs.mkdir(outDir, { recursive: true });
  const rawPath = join(outDir, 'whisper-raw.json');
  const pyArgs = ['-I', join(MOTION_SCRIPTS_DIR, 'transcribe.py'), media, '--out', rawPath, '--model', args.model ?? 'small'];
  if (args.language) pyArgs.push('--language', args.language);
  if (args.vocabulary?.length) pyArgs.push('--prompt', args.vocabulary.join(', '));
  const r = await run(python, pyArgs, { timeoutMs: 60 * 60 * 1000 });
  const lastLine = r.stdout.trim().split('\n').pop() ?? '';
  let status: Record<string, unknown> = {};
  try { status = JSON.parse(lastLine); } catch { /* reported below */ }
  if (r.code !== 0 || status.ok !== true) {
    const notInstalled = r.code === 3 || /No Whisper engine/.test(String(status.error ?? ''));
    if (notInstalled) return missingTool('Whisper (faster-whisper)', 'Install it into the Motion Director Python: ~/.motion-director/venv/bin/pip install faster-whisper.');
    return { success: false, retry: false, error: String(status.error ?? `Transcription failed: ${r.stderr.trim().split('\n').slice(-5).join(' ')}`) };
  }
  const transcript = normalizeWhisperJson(JSON.parse(await fs.readFile(rawPath, 'utf8')), media);
  const wordsPath = join(outDir, 'words.json');
  await writeJson(wordsPath, transcript);
  await fs.writeFile(join(outDir, 'transcript.srt'), toSrt(transcript));
  await fs.writeFile(join(outDir, 'transcript.txt'), toPlainText(transcript));
  const flags = flagSuspectWords(transcript);
  return {
    success: true,
    engine: status.engine,
    language: transcript.language,
    duration: transcript.duration,
    words: transcript.words.length,
    files: { words: wordsPath, srt: join(outDir, 'transcript.srt'), text: join(outDir, 'transcript.txt') },
    text: toPlainText(transcript).slice(0, 4000),
    checkSpelling: flags,
    nextStep: flags.length
      ? 'Show the editor the flagged names and brand words and ask which are misspelled, then call motion_fix_transcript with the corrections before storyboarding.'
      : 'Ask the editor to confirm names and brand words are spelled correctly before storyboarding.',
  };
}

async function fixTranscript(args: { wordsPath: string; corrections: Array<{ from: string; to: string }> }): Promise<unknown> {
  const wordsPath = abs(args.wordsPath);
  const transcript = await readTranscript(wordsPath);
  const { transcript: fixed, changes } = applyCorrections(transcript, args.corrections);
  await writeJson(wordsPath, fixed);
  const dir = dirname(wordsPath);
  await fs.writeFile(join(dir, 'transcript.srt'), toSrt(fixed));
  await fs.writeFile(join(dir, 'transcript.txt'), toPlainText(fixed));
  return {
    success: true,
    changed: changes.length,
    changes,
    notFound: args.corrections.filter((c) => !changes.some((ch) => ch.to === c.to.trim().split(/\s+/).join(' '))).map((c) => c.from),
    files: { words: wordsPath, srt: join(dir, 'transcript.srt'), text: join(dir, 'transcript.txt') },
  };
}

async function detectFaces(args: { videoPath: string; outputPath?: string; sampleEvery?: number; padding?: number }): Promise<unknown> {
  const video = abs(args.videoPath);
  const python = await findPython();
  if (!python) return missingTool('Python 3', INSTALL_HINTS.python);
  const out = args.outputPath ? abs(args.outputPath) : join(dirname(dirname(video)), 'storyboard', 'faces.json');
  await fs.mkdir(dirname(out), { recursive: true });
  const r = await run(python, ['-I', join(MOTION_SCRIPTS_DIR, 'detect_faces.py'), video, '--out', out, '--every', String(args.sampleEvery ?? 0.5), '--padding', String(args.padding ?? 0.35)], { timeoutMs: 30 * 60 * 1000 });
  let status: Record<string, unknown> = {};
  try { status = JSON.parse(r.stdout.trim().split('\n').pop() ?? ''); } catch { /* below */ }
  if (status.ok !== true) {
    if (r.code === 3 || r.code === 4) return missingTool('OpenCV 4 (opencv-python-headless)', "Install it into the Motion Director Python: ~/.motion-director/venv/bin/pip install 'opencv-python-headless>=4.8,<5'.");
    return { success: false, retry: false, error: String(status.error ?? r.stderr.trim().slice(-500)) };
  }
  return {
    success: true,
    facesFile: out,
    duration: status.duration,
    samplesWithFace: status.samplesWithFace,
    noGoZones: status.zones,
    nextStep: 'Copy noGoZones into storyboard.json "noGoZones". Face detection is basic: look at a frame or two (motion_extract_frames) and widen a zone if it is too tight.',
  };
}

async function extractFrames(args: { videoPath: string; outputDir?: string; times?: number[]; count?: number; width?: number }): Promise<unknown> {
  const video = abs(args.videoPath);
  const ffmpeg = await findExecutable('ffmpeg', 'FFMPEG_PATH');
  if (!ffmpeg) return missingTool('ffmpeg', INSTALL_HINTS.ffmpeg);
  const info = await probeMedia(video);
  if ('success' in info) return info;
  const duration = info.duration ?? 0;
  const count = Math.max(1, Math.min(args.count ?? 8, 60));
  const times: number[] = args.times?.length
    ? args.times
    : Array.from({ length: count }, (_v: unknown, i: number) => Math.round(((i + 0.5) * duration / count) * 100) / 100);
  const outDir = args.outputDir ? abs(args.outputDir) : join(dirname(video), `${basename(video, extname(video))}-frames`);
  await fs.mkdir(outDir, { recursive: true });
  const width = args.width ?? 960;
  const frames: Array<{ time: number; path: string }> = [];
  const failed: Array<{ time: number; error: string }> = [];
  for (const t of times) {
    const p = join(outDir, `frame_${t.toFixed(2).replace('.', '_')}s.jpg`);
    const r = await run(ffmpeg, ['-v', 'error', '-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', p], { timeoutMs: 120000 });
    if (r.code === 0 && (await fileExists(p))) frames.push({ time: t, path: p });
    else failed.push({ time: t, error: r.stderr.trim().slice(0, 200) });
  }
  return { success: frames.length > 0, frames, failed, nextStep: 'Read these image files to look at them.' };
}

async function downloadReference(args: { url: string; outputDir: string; maxHeight?: number }): Promise<unknown> {
  const ytdlp = await findExecutable('yt-dlp', 'YTDLP_PATH');
  if (!ytdlp) return missingTool('yt-dlp', INSTALL_HINTS.ytdlp);
  const outDir = abs(args.outputDir);
  await fs.mkdir(outDir, { recursive: true });
  const h = args.maxHeight ?? 1080;
  const r = await run(ytdlp, [
    '--no-playlist', '--restrict-filenames', '--no-progress',
    '-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/b[height<=${h}]/b`,
    '--merge-output-format', 'mp4',
    '-o', join(outDir, '%(title).80s-%(id)s.%(ext)s'),
    '--print', 'after_move:filepath',
    args.url,
  ], { timeoutMs: 30 * 60 * 1000 });
  if (r.code !== 0) return { success: false, retry: false, error: `yt-dlp could not download ${args.url}: ${r.stderr.trim().split('\n').slice(-3).join(' ')}` };
  const files = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && isAbsolute(l));
  return { success: true, files, nextStep: 'Call motion_extract_frames on each file to look at it, then note what to take from it: colours, type, motion, pacing.' };
}

async function buildStoryboard(args: { storyboardPath: string; htmlPath?: string }): Promise<unknown> {
  const sbPath = abs(args.storyboardPath);
  let resolved;
  try {
    resolved = await loadResolvedStoryboard(sbPath);
  } catch (error) {
    const issues = error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)
      ? (error as { issues: Array<{ path: unknown[]; message: string }> }).issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      : [error instanceof Error ? error.message : String(error)];
    return { success: false, retry: false, status: 'invalid_storyboard', error: 'storyboard.json does not match the storyboard format.', problems: issues.slice(0, 30) };
  }
  const footagePath = resolvePathFrom(sbPath, resolved.storyboard.footage.path);
  const mediaPaths: Record<string, string> = {};
  for (const b of resolved.beats) for (const el of b.elements) if (el.element.src) mediaPaths[el.element.id] = resolvePathFrom(sbPath, el.element.src);
  const htmlPath = args.htmlPath ? abs(args.htmlPath) : join(dirname(sbPath), 'storyboard.html');
  await fs.writeFile(htmlPath, renderStoryboardHtml({ resolved, htmlPath, footagePath, mediaPaths }));
  const summary = summarizeIssues(resolved.issues);
  return {
    success: true,
    htmlPath,
    beats: resolved.beats.length,
    duration: resolved.duration,
    footageFound: await fileExists(footagePath),
    transcript: resolved.transcriptPath,
    checks: summary,
    issues: resolved.issues,
    nextStep: summary.errors
      ? 'Fix the rule errors in storyboard.json and rebuild before showing the editor.'
      : `Ask the editor to open ${htmlPath} in a browser (double-click it), press Play full storyboard, and give feedback. Explain how each rule was applied.`,
  };
}

async function contactSheet(args: { images: string[]; outputPath: string; columns?: number; tileWidth?: number }): Promise<unknown> {
  const ffmpeg = await findExecutable('ffmpeg', 'FFMPEG_PATH');
  if (!ffmpeg) return missingTool('ffmpeg', INSTALL_HINTS.ffmpeg);
  const images = [];
  for (const p of args.images.map(abs)) if (await fileExists(p)) images.push(p);
  if (!images.length) return { success: false, retry: false, error: 'None of the images exist.' };
  const cols = Math.max(1, Math.min(args.columns ?? 4, images.length));
  const rows = Math.ceil(images.length / cols);
  const tile = args.tileWidth ?? 480;
  const staging = await fs.mkdtemp(join(tmpdir(), 'motion-sheet-'));
  try {
    for (let i = 0; i < images.length; i++) await fs.copyFile(images[i]!, join(staging, `f${String(i).padStart(4, '0')}${extname(images[i]!).toLowerCase() || '.png'}`));
    const ext = extname(images[0]!).toLowerCase() || '.png';
    // Same-format inputs only; convert mixed sets to png first.
    const mixed = images.some((p) => extname(p).toLowerCase() !== ext);
    if (mixed) {
      for (let i = 0; i < images.length; i++) {
        const src = join(staging, `f${String(i).padStart(4, '0')}${extname(images[i]!).toLowerCase()}`);
        await run(ffmpeg, ['-v', 'error', '-y', '-i', src, join(staging, `g${String(i).padStart(4, '0')}.png`)]);
      }
    }
    const pattern = mixed ? join(staging, 'g%04d.png') : join(staging, `f%04d${ext}`);
    const out = abs(args.outputPath);
    await fs.mkdir(dirname(out), { recursive: true });
    const r = await run(ffmpeg, ['-v', 'error', '-y', '-i', pattern, '-vf', `scale=${tile}:-2,pad=iw+8:ih+8:4:4:color=0x111111,tile=${cols}x${rows}:color=0x111111`, '-frames:v', '1', out], { timeoutMs: 120000 });
    if (r.code !== 0) return { success: false, error: `ffmpeg could not build the contact sheet: ${r.stderr.trim().slice(0, 300)}` };
    return { success: true, path: out, columns: cols, rows, order: images, nextStep: 'Read the contact sheet image and check each tile against the storyboard and the rules.' };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function storyboardTemplate(args: { title: string; footagePath: string; transcriptPath?: string; storyboardPath: string }): Promise<unknown> {
  const sbPath = abs(args.storyboardPath);
  if (await fileExists(sbPath)) return { success: false, retry: false, error: `${sbPath} already exists. Edit it instead of starting over.` };
  const info = await probeMedia(abs(args.footagePath));
  const rel = (p: string): string => relative(dirname(sbPath), abs(p)) || basename(p);
  const footage: Record<string, unknown> = { path: rel(args.footagePath) };
  if (!('success' in info)) {
    if (info.duration) footage.duration = info.duration;
    if (info.width) footage.width = info.width;
    if (info.height) footage.height = info.height;
    if (info.fps) footage.fps = info.fps;
  }
  const template = {
    version: 1,
    title: args.title,
    footage,
    output: { width: 1920, height: 1080, fps: 60 },
    ...(args.transcriptPath ? { transcript: rel(args.transcriptPath) } : {}),
    style: {
      palette: ['#F5F5F0', '#3DDC84', '#0B3D2E'],
      fonts: { primary: { family: 'Inter', postscript: 'Inter-Bold', weight: 700 }, accent: { family: 'Instrument Serif', postscript: 'InstrumentSerif-Italic', style: 'italic' } },
      pixelSize: 12, textAnimation: 'pixel-letter-reveal', exitAnimation: 'fade', microMotion: 'drift',
      minHold: 0.5, maxFonts: 2, reservedBottom: 0, textOnlyWhenSpoken: true,
    },
    rules: [
      'Text is pixelated and appears only when it is said.',
      'Text reveals letter by letter.',
      'Text never covers the face; it sits beside it.',
      'Clear hierarchy: one hero word per scene.',
      'Nothing static: everything has micro-motion.',
      'No fast or abrupt moves.',
      'Use the whole video, no cuts.',
    ],
    noGoZones: [],
    beats: [
      { id: 'S01', name: 'intro', start: 0, end: Math.min(3, Number(footage.duration ?? 3)), elements: [{ id: 'hero', kind: 'text', text: 'REPLACE ME', font: 'primary', size: 110, role: 'hero', x: 0.72, y: 0.45 }] },
    ],
  };
  StoryboardSchema.parse(template);
  await writeJson(sbPath, template);
  return { success: true, storyboardPath: sbPath, nextStep: 'Fill in beats from the transcript and references, then call motion_build_storyboard.' };
}

// ---------------------------------------------------------------- catalog

export const motionTools: ToolModule[] = [
  {
    name: 'motion_new_project',
    description: 'Creates a project folder for one video (footage/, references/, transcript/, storyboard/, ae/, renders/, review/) under the Motion Studio projects folder. Start every new video with this.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Video name, e.g. "Solo founder intro"'),
      root: z.string().optional().describe('Folder to create it in. Defaults to <Motion Studio>/projects.'),
    }),
    run: (_ctx, args) => newProject(args),
  },
  {
    name: 'motion_probe_media',
    description: 'Reads duration, resolution, frame rate and whether a video has audio (ffprobe).',
    inputSchema: z.object({ path: z.string().min(1).describe('Absolute path to a video or image') }),
    run: (_ctx, args) => probe(args),
  },
  {
    name: 'motion_transcribe',
    description: 'Transcribes a video locally with Whisper and writes words.json (every word with start and end time), transcript.srt and transcript.txt. Flags names and brand words that may be misspelled. Can take a few minutes. Runs on this computer; nothing is uploaded.',
    inputSchema: z.object({
      mediaPath: z.string().min(1).describe('Absolute path to the video'),
      outputDir: z.string().optional().describe('Folder for the transcript files. Defaults to the project transcript/ folder.'),
      model: z.enum(['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo']).optional().describe('Whisper model. small (default) is a good balance; medium or large-v3 is more accurate and slower.'),
      language: z.string().optional().describe('Language code such as "en" or "hi". Detected automatically when omitted.'),
      vocabulary: z.array(z.string()).optional().describe('Names and brand words to help Whisper spell them, e.g. ["Somrat Dutta", "Indian School of Motion"]'),
    }),
    run: (_ctx, args) => transcribe(args),
  },
  {
    name: 'motion_fix_transcript',
    description: 'Corrects spellings everywhere in words.json, transcript.srt and transcript.txt while keeping every word\'s timing. Use it for names Whisper misheard, before storyboarding.',
    inputSchema: z.object({
      wordsPath: z.string().min(1).describe('Absolute path to words.json'),
      corrections: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).min(1).describe('e.g. [{"from": "Somrud Dutta", "to": "Somrat Dutta"}]'),
    }),
    run: (_ctx, args) => fixTranscript(args),
  },
  {
    name: 'motion_detect_faces',
    description: 'Finds the speaker\'s face over time and returns padded no-go zones (fractions of the frame) for storyboard.json, so text is placed near the face but never on it.',
    inputSchema: z.object({
      videoPath: z.string().min(1),
      outputPath: z.string().optional().describe('Where to write faces.json. Defaults to the project storyboard/ folder.'),
      sampleEvery: z.number().positive().optional().describe('Seconds between sampled frames (default 0.5)'),
      padding: z.number().min(0).optional().describe('Padding around the face as a fraction of face size (default 0.35)'),
    }),
    run: (_ctx, args) => detectFaces(args),
  },
  {
    name: 'motion_extract_frames',
    description: 'Saves still frames from a video as JPEGs so you can look at them (footage, or references). Give exact times or a count spread across the video.',
    inputSchema: z.object({
      videoPath: z.string().min(1),
      outputDir: z.string().optional(),
      times: z.array(z.number().min(0)).optional().describe('Seconds to grab'),
      count: z.number().int().positive().optional().describe('Evenly spaced frames when times is omitted (default 8)'),
      width: z.number().int().positive().optional().describe('Frame width in pixels (default 960)'),
    }),
    run: (_ctx, args) => extractFrames(args),
  },
  {
    name: 'motion_download_reference',
    description: 'Downloads a reference video (YouTube, Shorts, Vimeo and other sites yt-dlp supports) into the project references folder.',
    inputSchema: z.object({
      url: z.string().url(),
      outputDir: z.string().min(1).describe('Usually <project>/references'),
      maxHeight: z.number().int().positive().optional().describe('Highest resolution to fetch (default 1080)'),
    }),
    run: (_ctx, args) => downloadReference(args),
  },
  {
    name: 'motion_storyboard_template',
    description: 'Writes a starter storyboard.json (style, rules, one example beat) with the footage details filled in. Then edit it into the full storyboard.',
    inputSchema: z.object({
      title: z.string().min(1),
      footagePath: z.string().min(1).describe('Absolute path to the raw video'),
      transcriptPath: z.string().optional().describe('Absolute path to words.json'),
      storyboardPath: z.string().min(1).describe('Absolute path for storyboard.json, usually <project>/storyboard/storyboard.json'),
    }),
    run: (_ctx, args) => storyboardTemplate(args),
  },
  {
    name: 'motion_build_storyboard',
    description: 'Checks storyboard.json against the editor\'s rules (text only when spoken, never on the face, hold before transitions, every second used, palette, fonts, nothing static) and writes storyboard.html: a card per beat previewing the animation over the real footage, plus a Play full storyboard button with audio. Run after every storyboard edit.',
    inputSchema: z.object({
      storyboardPath: z.string().min(1).describe('Absolute path to storyboard.json'),
      htmlPath: z.string().optional().describe('Where to write the page. Defaults to storyboard.html beside the JSON.'),
    }),
    run: (_ctx, args) => buildStoryboard(args),
  },
  {
    name: 'motion_contact_sheet',
    description: 'Tiles review frames into one contact sheet image (ffmpeg), so a whole video can be checked at a glance.',
    inputSchema: z.object({
      images: z.array(z.string()).min(1).describe('Absolute image paths in order'),
      outputPath: z.string().min(1).describe('Absolute path for the sheet, e.g. <project>/review/contact-sheet.png'),
      columns: z.number().int().positive().optional().describe('Tiles per row (default 4)'),
      tileWidth: z.number().int().positive().optional().describe('Width of each tile in pixels (default 480)'),
    }),
    run: (_ctx, args) => contactSheet(args),
  },
];

export { contactSheet as buildContactSheet };
