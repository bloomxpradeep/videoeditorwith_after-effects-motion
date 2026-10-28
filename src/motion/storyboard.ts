/**
 * The storyboard: the one blueprint both the HTML preview and the After Effects
 * build read from.
 *
 * An editor approves the storyboard in a browser, then After Effects is built
 * from the same file, so what was approved is what gets built. Positions are
 * fractions of the frame (0..1) so the same numbers drive a small preview card
 * and a 1920x1080 composition. Times are seconds on the source footage.
 *
 * `resolveStoryboard` turns the file plus the word-level transcript into exact
 * per-element timings (when each letter appears, when the exit starts) and
 * checks the editor's rules against them.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { normalizeToken, readTranscript, tokenize, type Transcript, type TranscriptWord } from './words.js';

export const ENTRY_PRESETS = ['letter-reveal', 'pixel-letter-reveal', 'pixel-resolve', 'fade-up', 'fade', 'pop', 'grow-x', 'none'] as const;
export const EXIT_PRESETS = ['fade', 'pixel-out', 'fade-down', 'none'] as const;
export const MICRO_MOTIONS = ['drift', 'breathe', 'sway', 'float', 'none'] as const;
export const TRANSITIONS = ['cut', 'fade', 'pixel', 'pixel-flash'] as const;

export type EntryPreset = (typeof ENTRY_PRESETS)[number];
export type ExitPreset = (typeof EXIT_PRESETS)[number];
export type MicroMotion = (typeof MICRO_MOTIONS)[number];
export type TransitionType = (typeof TRANSITIONS)[number];

const hex = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Colour must be a 6-digit hex like #3DDC84');
const unit = z.number().min(-0.5).max(1.5);
const seconds = z.number().min(0);

export const NoGoZoneSchema = z.object({
  label: z.string().optional().describe('What the zone protects, e.g. "face"'),
  start: seconds.optional().describe('Zone applies from this time (default: whole video)'),
  end: seconds.optional().describe('Zone applies until this time (default: whole video)'),
  x: unit, y: unit, w: z.number().positive(), h: z.number().positive(),
});

export const ElementSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Element id: letters, digits, _ or - only').describe('Short id, used in the layer name S01_text_<id>'),
  kind: z.enum(['text', 'shape', 'media']),
  // text
  text: z.string().optional().describe('Text to show. Use \\n for a line break.'),
  font: z.string().optional().describe('Key in style.fonts (e.g. "primary") or a PostScript font name'),
  size: z.number().positive().optional().describe('Font size in pixels at the output resolution'),
  color: hex.optional(),
  strokeColor: hex.optional(),
  strokeWidth: z.number().min(0).optional(),
  tracking: z.number().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  allCaps: z.boolean().optional(),
  role: z.enum(['hero', 'support', 'label']).optional(),
  // shape
  shape: z.enum(['rectangle', 'ellipse', 'underline']).optional(),
  width: z.number().positive().optional().describe('Shape or media width as a fraction of frame width'),
  height: z.number().positive().optional().describe('Shape height as a fraction of frame height'),
  fill: hex.optional(),
  roundness: z.number().min(0).optional(),
  // media
  src: z.string().optional().describe('Image, video or PNG sequence path, relative to the storyboard file'),
  sequence: z.boolean().optional().describe('src is the first frame of an image sequence (e.g. a Blender render)'),
  // placement
  x: unit.describe('Centre x as a fraction of frame width'),
  y: unit.describe('Centre y as a fraction of frame height'),
  // timing
  sync: z.boolean().optional().describe('Text only: appear word by word as the words are spoken (default true)'),
  syncPhrase: z.string().optional().describe('Spoken words to sync to when they differ from the on-screen text'),
  appearAt: seconds.optional().describe('Absolute appear time in seconds when not synced to speech'),
  until: seconds.optional().describe('Absolute time the element is gone (default: end of its beat)'),
  // motion
  animIn: z.enum(ENTRY_PRESETS).optional(),
  animInDuration: z.number().positive().optional(),
  animOut: z.enum(EXIT_PRESETS).optional(),
  animOutDuration: z.number().positive().optional(),
  microMotion: z.enum(MICRO_MOTIONS).optional(),
});

export const BeatSchema = z.object({
  id: z.string().regex(/^S\d{2,3}$/, 'Beat id must look like S01'),
  name: z.string().min(1),
  start: seconds,
  end: seconds,
  say: z.string().optional().describe('What is spoken in this beat (for reference)'),
  elements: z.array(ElementSchema).default([]),
  transitionOut: z.object({
    type: z.enum(TRANSITIONS),
    duration: z.number().positive().optional(),
  }).optional(),
  notes: z.string().optional(),
});

export const FontSchema = z.object({
  family: z.string().min(1).describe('Font family name, used by the HTML preview'),
  postscript: z.string().optional().describe('PostScript name After Effects needs, e.g. "Inter-Bold". Find with ae_find_fonts.'),
  weight: z.number().optional(),
  style: z.enum(['normal', 'italic']).optional(),
});

export const StoryboardSchema = z.object({
  version: z.literal(1).default(1),
  title: z.string().min(1),
  footage: z.object({
    path: z.string().min(1).describe('Raw footage, relative to the storyboard file'),
    duration: z.number().positive().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    fps: z.number().positive().optional(),
  }),
  output: z.object({
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
    fps: z.number().positive().default(60),
  }).default({ width: 1920, height: 1080, fps: 60 }),
  transcript: z.string().optional().describe('words.json from motion_transcribe, relative to the storyboard file'),
  style: z.object({
    palette: z.array(hex).default([]),
    fonts: z.record(z.string(), FontSchema).default({}),
    pixelSize: z.number().positive().default(12).describe('Pixel block size in output pixels for pixel effects'),
    textAnimation: z.enum(ENTRY_PRESETS).default('pixel-letter-reveal'),
    exitAnimation: z.enum(EXIT_PRESETS).default('fade'),
    microMotion: z.enum(MICRO_MOTIONS).default('drift'),
    minHold: z.number().min(0).default(0.5).describe('Seconds an element must sit still after animating in, before its exit'),
    maxFonts: z.number().int().positive().default(2),
    reservedBottom: z.number().min(0).max(0.5).default(0).describe('Fraction of the frame bottom kept clear (e.g. 0.2 for captions)'),
    textOnlyWhenSpoken: z.boolean().default(true),
    background: hex.optional(),
  }).default({
    palette: [], fonts: {}, pixelSize: 12, textAnimation: 'pixel-letter-reveal', exitAnimation: 'fade',
    microMotion: 'drift', minHold: 0.5, maxFonts: 2, reservedBottom: 0, textOnlyWhenSpoken: true,
  }),
  rules: z.array(z.string()).default([]),
  noGoZones: z.array(NoGoZoneSchema).default([]),
  beats: z.array(BeatSchema).min(1),
});

export type Storyboard = z.infer<typeof StoryboardSchema>;
export type Beat = z.infer<typeof BeatSchema>;
export type StoryElement = z.infer<typeof ElementSchema>;
export type NoGoZone = z.infer<typeof NoGoZoneSchema>;

export interface Box { x: number; y: number; w: number; h: number }

export interface CharKey { t: number; chars: number }

export interface ResolvedElement {
  beatId: string;
  element: StoryElement;
  layerName: string;
  font: { family: string; postscript: string; weight?: number; style?: string } | null;
  color: string;
  size: number;
  animIn: EntryPreset;
  animOut: ExitPreset;
  microMotion: MicroMotion;
  timing: {
    in: number;
    inDuration: number;
    revealEnd: number;
    exitStart: number;
    out: number;
    /** Letter reveal: how many non-space characters are visible from each time on. */
    charKeys: CharKey[];
    totalChars: number;
  };
  /** Spoken words the element was synced to. */
  syncedWords: TranscriptWord[];
  /** Estimated footprint as fractions of the frame, for rule checks and previews. */
  box: Box;
}

export interface ResolvedBeat {
  beat: Beat;
  elements: ResolvedElement[];
  transition: { type: TransitionType; duration: number };
  words: TranscriptWord[];
}

export interface LintIssue {
  level: 'error' | 'warning';
  rule: string;
  beat?: string;
  element?: string;
  message: string;
}

export interface ResolvedStoryboard {
  storyboard: Storyboard;
  beats: ResolvedBeat[];
  issues: LintIssue[];
  duration: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function hexColor(value: string | undefined, fallback = '#FFFFFF'): string {
  const v = (value ?? fallback).replace(/^#/, '').toUpperCase();
  return `#${v}`;
}

function nonSpaceLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

/** Rough text footprint: good enough to catch text drawn over a face, not a layout engine. */
export function estimateTextBox(text: string, size: number, tracking: number, x: number, y: number, align: 'left' | 'center' | 'right', out: { width: number; height: number }, allCaps = false): Box {
  const lines = text.split('\n');
  const widest = Math.max(...lines.map((l) => {
    let units = 0;
    for (const ch of allCaps ? l.toUpperCase() : l) {
      if (ch === ' ') units += 0.3;
      else if (/[A-Z0-9]/.test(ch)) units += 0.64;
      else if (/[il.,'!|:;]/.test(ch)) units += 0.28;
      else if (/[mwMW]/.test(ch)) units += 0.85;
      else units += 0.54;
    }
    return units * size + Math.max(0, l.length - 1) * (tracking / 1000) * size;
  }));
  const w = widest / out.width;
  const h = (lines.length * size * 1.15) / out.height;
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  return { x: left, y: y - h / 2, w, h };
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function overlapsTime(aStart: number, aEnd: number, bStart: number | undefined, bEnd: number | undefined): boolean {
  const s = bStart ?? -Infinity;
  const e = bEnd ?? Infinity;
  return aStart < e && s < aEnd;
}

/** Finds the element's words in the transcript, in order, inside the beat window. */
export function matchSpokenWords(phrase: string, words: TranscriptWord[], from: number, to: number): { matched: TranscriptWord[]; tokens: string[]; missing: string[] } {
  const tokens = tokenize(phrase);
  const pool = words.filter((w) => w.start >= from - 0.3 && w.start <= to + 0.3);
  const poolTokens = pool.map((w) => normalizeToken(w.word));
  if (!tokens.length || !pool.length) return { matched: [], tokens, missing: tokens };

  // Exact consecutive match first.
  for (let i = 0; i + tokens.length <= pool.length; i++) {
    if (tokens.every((t, k) => poolTokens[i + k] === t)) {
      return { matched: pool.slice(i, i + tokens.length), tokens, missing: [] };
    }
  }
  // Otherwise in order, allowing other words in between.
  const matched: TranscriptWord[] = [];
  const missing: string[] = [];
  let cursor = 0;
  for (const t of tokens) {
    let found = -1;
    for (let j = cursor; j < pool.length; j++) {
      if (poolTokens[j] === t || (t.length > 3 && (poolTokens[j]!.startsWith(t) || t.startsWith(poolTokens[j]!)) && poolTokens[j]!.length > 3)) { found = j; break; }
    }
    if (found === -1) missing.push(t);
    else { matched.push(pool[found]!); cursor = found + 1; }
  }
  return { matched, tokens, missing };
}

function defaultInDuration(preset: EntryPreset): number {
  switch (preset) {
    case 'pop': return 0.45;
    case 'fade': return 0.4;
    case 'none': return 0;
    default: return 0.6;
  }
}

export function resolveStoryboard(storyboardInput: unknown, transcript: Transcript | null): ResolvedStoryboard {
  const storyboard = StoryboardSchema.parse(storyboardInput);
  const out = storyboard.output;
  const style = storyboard.style;
  const words = transcript?.words ?? [];
  const issues: LintIssue[] = [];
  const frame = 1 / out.fps;
  const duration = storyboard.footage.duration ?? transcript?.duration ?? Math.max(...storyboard.beats.map((b) => b.end));

  // Beat order and coverage.
  const ids = new Set<string>();
  const sorted = [...storyboard.beats].sort((a, b) => a.start - b.start);
  sorted.forEach((b, i) => {
    if (ids.has(b.id)) issues.push({ level: 'error', rule: 'beats', beat: b.id, message: `Beat id ${b.id} is used twice.` });
    ids.add(b.id);
    if (b.end <= b.start) issues.push({ level: 'error', rule: 'beats', beat: b.id, message: `Beat ${b.id} ends (${b.end}s) before it starts (${b.start}s).` });
    const next = sorted[i + 1];
    if (next && next.start < b.end - 0.01) issues.push({ level: 'error', rule: 'beats', beat: b.id, message: `Beat ${b.id} overlaps ${next.id} (${b.end}s > ${next.start}s).` });
    if (next && next.start - b.end > 0.05) issues.push({ level: 'warning', rule: 'coverage', beat: b.id, message: `Gap of ${r3(next.start - b.end)}s between ${b.id} and ${next.id} with no beat.` });
  });
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (first.start > 0.05) issues.push({ level: 'warning', rule: 'coverage', beat: first.id, message: `The first ${r3(first.start)}s of footage have no beat.` });
  if (duration - last.end > 0.05) issues.push({ level: 'warning', rule: 'coverage', beat: last.id, message: `The last ${r3(duration - last.end)}s of footage (after ${last.end}s, video is ${r3(duration)}s) have no beat.` });

  const fontsUsed = new Set<string>();
  const palette = new Set(style.palette.map((c) => hexColor(c)));

  const beats: ResolvedBeat[] = sorted.map((beat) => {
    const transitionType: TransitionType = beat.transitionOut?.type ?? (style.exitAnimation === 'pixel-out' ? 'pixel' : style.exitAnimation === 'none' ? 'cut' : 'fade');
    const transition = { type: transitionType, duration: beat.transitionOut?.duration ?? (transitionType === 'cut' ? 0 : 0.4) };
    const beatWords = words.filter((w) => w.start >= beat.start - 0.05 && w.start < beat.end);

    const elements: ResolvedElement[] = beat.elements.map((el) => {
      const isText = el.kind === 'text';
      const text = el.text ?? '';
      if (isText && !text.trim()) issues.push({ level: 'error', rule: 'content', beat: beat.id, element: el.id, message: 'Text element has no text.' });
      if (el.kind === 'media' && !el.src) issues.push({ level: 'error', rule: 'content', beat: beat.id, element: el.id, message: 'Media element has no src.' });

      const fontEntry = el.font ? style.fonts[el.font] : undefined;
      const font = isText
        ? (fontEntry
          ? { family: fontEntry.family, postscript: fontEntry.postscript ?? fontEntry.family, ...(fontEntry.weight !== undefined ? { weight: fontEntry.weight } : {}), ...(fontEntry.style ? { style: fontEntry.style } : {}) }
          : el.font ? { family: el.font, postscript: el.font } : null)
        : null;
      if (isText) fontsUsed.add(font?.postscript ?? '(default)');

      let animIn: EntryPreset = el.animIn ?? (isText ? style.textAnimation : 'pixel-resolve');
      if (!isText && (animIn === 'letter-reveal' || animIn === 'pixel-letter-reveal')) animIn = 'pixel-resolve';
      const transitionExit: ExitPreset = transition.type === 'pixel' || transition.type === 'pixel-flash' ? 'pixel-out' : transition.type === 'cut' ? 'none' : 'fade';
      const animOut: ExitPreset = el.animOut ?? (beat.transitionOut ? transitionExit : style.exitAnimation);
      const microMotion: MicroMotion = el.microMotion ?? style.microMotion;
      const size = el.size ?? (el.role === 'hero' ? 110 : el.role === 'label' ? 36 : 64);
      const color = hexColor(el.color ?? el.fill ?? style.palette[0] ?? '#FFFFFF');

      // When does it appear? Spoken words win for text.
      let syncedWords: TranscriptWord[] = [];
      const wantsSync = isText && el.sync !== false && words.length > 0;
      if (wantsSync) {
        const phrase = el.syncPhrase ?? text;
        const match = matchSpokenWords(phrase, words, beat.start, beat.end);
        syncedWords = match.matched;
        if (!match.matched.length) {
          if (style.textOnlyWhenSpoken) {
            issues.push({ level: 'error', rule: 'spoken', beat: beat.id, element: el.id, message: `"${phrase}" is not spoken between ${beat.start}s and ${beat.end}s, so it cannot appear "only when it's said". Fix the text, set syncPhrase to the words actually spoken, or set sync:false with appearAt.` });
          }
        } else if (match.missing.length) {
          issues.push({ level: 'warning', rule: 'spoken', beat: beat.id, element: el.id, message: `Not spoken in this beat: ${match.missing.join(', ')}. Those words appear with the previous spoken word.` });
        }
      } else if (isText && el.sync !== false && words.length === 0 && style.textOnlyWhenSpoken) {
        issues.push({ level: 'warning', rule: 'spoken', beat: beat.id, element: el.id, message: 'No transcript loaded, so text cannot be synced to speech. Run motion_transcribe and set "transcript".' });
      }

      const appear = syncedWords.length ? syncedWords[0]!.start : (el.appearAt ?? beat.start);
      const inDuration = el.animInDuration ?? defaultInDuration(animIn);
      const totalChars = isText ? nonSpaceLength(text) : 0;

      // Letter reveal keys: the count of visible characters over time.
      let charKeys: CharKey[] = [];
      if (isText && (animIn === 'letter-reveal' || animIn === 'pixel-letter-reveal')) {
        const textTokens = text.split(/\s+/).filter(Boolean);
        if (syncedWords.length) {
          // Map each on-screen token to a spoken word in order; unspoken tokens ride along with the previous one.
          const spoken = syncedWords.map((w) => normalizeToken(w.word));
          let cursor = 0;
          let cumulative = 0;
          let lastTime = appear;
          const keys: CharKey[] = [{ t: appear, chars: 0 }];
          for (const tok of textTokens) {
            const norm = normalizeToken(tok);
            let idx = -1;
            for (let j = cursor; j < spoken.length; j++) if (spoken[j] === norm || (norm.length > 3 && spoken[j]!.startsWith(norm))) { idx = j; break; }
            const word = idx >= 0 ? syncedWords[idx]! : undefined;
            if (idx >= 0) cursor = idx + 1;
            const start = word ? Math.max(word.start, lastTime) : lastTime;
            const len = nonSpaceLength(tok);
            const span = word ? Math.min(Math.max(word.end - word.start, 0.08), Math.max(0.08, len * 0.045)) : Math.max(0.06, len * 0.03);
            if (start > keys[keys.length - 1]!.t + 1e-6) keys.push({ t: r3(start), chars: cumulative });
            cumulative += len;
            const end = Math.max(start + span, keys[keys.length - 1]!.t + frame);
            keys.push({ t: r3(end), chars: cumulative });
            lastTime = end;
          }
          charKeys = keys;
        } else {
          const span = el.animInDuration ?? Math.min(1.2, Math.max(0.3, totalChars * 0.04));
          charKeys = [{ t: r3(appear), chars: 0 }, { t: r3(appear + span), chars: totalChars }];
        }
      }

      const revealEnd = charKeys.length ? charKeys[charKeys.length - 1]!.t + (animIn === 'pixel-letter-reveal' ? 0.25 : 0) : appear + inDuration;
      const outTime = el.until ?? beat.end;
      const outDuration = animOut === 'none' ? 0 : (el.animOutDuration ?? Math.max(transition.duration, 0.3));
      const exitStart = Math.max(appear, outTime - outDuration);

      // Footprint.
      let box: Box;
      if (isText) {
        box = estimateTextBox(text, size, el.tracking ?? 0, el.x, el.y, el.align ?? 'center', out, el.allCaps ?? false);
      } else {
        const w = el.width ?? (el.kind === 'media' ? 0.3 : 0.2);
        const h = el.height ?? (el.shape === 'underline' ? 0.008 : el.kind === 'media' ? w * (out.width / out.height) * 0.5625 : w * (out.width / out.height));
        box = { x: el.x - w / 2, y: el.y - h / 2, w, h };
      }

      const resolved: ResolvedElement = {
        beatId: beat.id,
        element: el,
        layerName: `${beat.id}_${el.kind}_${el.id}`,
        font,
        color,
        size,
        animIn,
        animOut,
        microMotion,
        timing: { in: r3(appear), inDuration: r3(inDuration), revealEnd: r3(revealEnd), exitStart: r3(exitStart), out: r3(outTime), charKeys, totalChars },
        syncedWords,
        box,
      };

      // Rule checks that need the resolved numbers.
      const where = { beat: beat.id, element: el.id };
      for (const zone of storyboard.noGoZones) {
        if (overlapsTime(appear, outTime, zone.start, zone.end) && intersects(box, zone)) {
          issues.push({ level: 'error', rule: 'no-go', ...where, message: `Overlaps the ${zone.label ?? 'no-go'} zone. Move it beside the zone, not on it.` });
        }
      }
      if (style.reservedBottom > 0 && box.y + box.h > 1 - style.reservedBottom) {
        issues.push({ level: 'error', rule: 'reserved-bottom', ...where, message: `Reaches into the bottom ${Math.round(style.reservedBottom * 100)}% that is kept clear.` });
      }
      if (box.x < -0.01 || box.y < -0.01 || box.x + box.w > 1.01 || box.y + box.h > 1.01) {
        issues.push({ level: 'warning', rule: 'frame', ...where, message: 'Probably runs off the edge of the frame.' });
      }
      if (animOut !== 'none' && exitStart - revealEnd < style.minHold - 1e-6) {
        issues.push({ level: 'warning', rule: 'hold', ...where, message: `Only ${r3(Math.max(0, exitStart - revealEnd))}s between finishing its entrance and starting its exit (minimum ${style.minHold}s). Animate in, hold, then transition.` });
      }
      if ((animIn !== 'none' && inDuration < 0.25) || (animOut !== 'none' && outDuration < 0.2)) {
        issues.push({ level: 'warning', rule: 'abrupt', ...where, message: 'Animation shorter than 0.25s in or 0.2s out reads as abrupt.' });
      }
      if (microMotion === 'none') {
        issues.push({ level: 'warning', rule: 'static', ...where, message: 'Has no micro-motion, so it sits completely still once it lands.' });
      }
      if (palette.size && isText && !palette.has(color)) {
        issues.push({ level: 'warning', rule: 'palette', ...where, message: `Colour ${color} is not in the palette.` });
      }
      if (appear < beat.start - 0.3 || outTime > beat.end + 0.3) {
        issues.push({ level: 'warning', rule: 'beats', ...where, message: `Runs outside its beat (${beat.start}s–${beat.end}s).` });
      }
      return resolved;
    });

    // Elements stacked on each other at the same moment.
    for (let i = 0; i < elements.length; i++) {
      for (let j = i + 1; j < elements.length; j++) {
        const a = elements[i]!;
        const b = elements[j]!;
        if (a.element.kind === 'text' && b.element.kind === 'text' && overlapsTime(a.timing.in, a.timing.out, b.timing.in, b.timing.out) && intersects(a.box, b.box)) {
          issues.push({ level: 'warning', rule: 'overlap', beat: beat.id, element: `${a.element.id},${b.element.id}`, message: `Text "${a.element.id}" and "${b.element.id}" overlap on screen.` });
        }
      }
    }

    return { beat, elements, transition, words: beatWords };
  });

  if (fontsUsed.size > style.maxFonts) {
    issues.push({ level: 'warning', rule: 'fonts', message: `${fontsUsed.size} fonts used (${[...fontsUsed].join(', ')}); the limit is ${style.maxFonts}.` });
  }

  return { storyboard, beats, issues, duration: r3(duration) };
}

export function resolvePathFrom(baseFile: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(baseFile), target);
}

/** Reads storyboard.json and, when it names one, its transcript; then resolves both. */
export async function loadResolvedStoryboard(storyboardPath: string): Promise<ResolvedStoryboard & { path: string; transcriptPath: string | null }> {
  const raw = JSON.parse(await fs.readFile(storyboardPath, 'utf8'));
  const parsed = StoryboardSchema.parse(raw);
  let transcript: Transcript | null = null;
  let transcriptPath: string | null = null;
  if (parsed.transcript) {
    transcriptPath = resolvePathFrom(storyboardPath, parsed.transcript);
    transcript = await readTranscript(transcriptPath);
  }
  return { ...resolveStoryboard(parsed, transcript), path: storyboardPath, transcriptPath };
}

export function summarizeIssues(issues: LintIssue[]): { errors: number; warnings: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {};
  for (const i of issues) byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
  return {
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length,
    byRule,
  };
}
