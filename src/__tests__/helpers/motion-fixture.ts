/**
 * A small, realistic motion project on disk: a transcript of a talking-head
 * intro, a storyboard with three beats, a face zone, and a placeholder video
 * file. Tests that need files call makeMotionProject() and clean up after.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WORDS = [
  ['Hi,', 0.4, 0.6], ["I'm", 0.62, 0.8], ['Somrat', 0.82, 1.2], ['Dutta.', 1.22, 1.7],
  ['I', 2.1, 2.2], ['teach', 2.22, 2.5], ['motion', 2.55, 2.9], ['design', 2.92, 3.4],
  ['to', 3.5, 3.6], ['solo', 3.62, 3.95], ['founders', 3.97, 4.6],
  ['and', 5.0, 5.1], ['it', 5.12, 5.2], ['changes', 5.22, 5.6], ['everything.', 5.62, 6.3],
] as const;

export function whisperJson(): Record<string, unknown> {
  return {
    language: 'en',
    duration: 7,
    segments: [
      { start: 0.4, end: 1.7, text: " Hi, I'm Somrat Dutta.", words: WORDS.slice(0, 4).map(([w, s, e]) => ({ word: ` ${w}`, start: s, end: e, probability: w === 'Somrat' ? 0.41 : 0.97 })) },
      { start: 2.1, end: 4.6, text: ' I teach motion design to solo founders', words: WORDS.slice(4, 11).map(([w, s, e]) => ({ word: ` ${w}`, start: s, end: e, probability: 0.95 })) },
      { start: 5.0, end: 6.3, text: ' and it changes everything.', words: WORDS.slice(11).map(([w, s, e]) => ({ word: ` ${w}`, start: s, end: e, probability: 0.95 })) },
    ],
  };
}

export function storyboard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    title: 'Solo Founder Intro',
    footage: { path: '../footage/interview.mp4', duration: 7, width: 1920, height: 1080, fps: 30 },
    output: { width: 1920, height: 1080, fps: 60 },
    transcript: '../transcript/words.json',
    style: {
      palette: ['#F5F5F0', '#3DDC84', '#0B3D2E'],
      fonts: { primary: { family: 'Inter', postscript: 'Inter-Bold', weight: 700 }, accent: { family: 'Instrument Serif', postscript: 'InstrumentSerif-Italic', style: 'italic' } },
      pixelSize: 12,
      textAnimation: 'pixel-letter-reveal',
      exitAnimation: 'fade',
      microMotion: 'drift',
      minHold: 0.5,
      maxFonts: 2,
      reservedBottom: 0,
      textOnlyWhenSpoken: true,
    },
    rules: ['Text appears only when it is said.', 'Text never covers the face.'],
    noGoZones: [{ label: 'face', x: 0.38, y: 0.1, w: 0.2, h: 0.55 }],
    beats: [
      {
        id: 'S01', name: 'name card', start: 0, end: 2.0,
        elements: [
          { id: 'name', kind: 'text', text: 'SOMRAT DUTTA', font: 'primary', size: 80, color: '#3DDC84', x: 0.8, y: 0.45, role: 'hero' },
          { id: 'rule', kind: 'shape', shape: 'underline', width: 0.12, x: 0.8, y: 0.52, fill: '#F5F5F0', animIn: 'grow-x' },
        ],
      },
      {
        id: 'S02', name: 'what i teach', start: 2.0, end: 4.9,
        elements: [
          { id: 'what', kind: 'text', text: 'MOTION DESIGN', font: 'primary', size: 84, color: '#F5F5F0', x: 0.18, y: 0.4 },
          { id: 'who', kind: 'text', text: 'solo founders', font: 'accent', size: 54, color: '#3DDC84', x: 0.18, y: 0.52, animIn: 'fade-up' },
        ],
        transitionOut: { type: 'pixel', duration: 0.4 },
      },
      {
        id: 'S03', name: 'payoff', start: 4.9, end: 7.0,
        elements: [
          { id: 'everything', kind: 'text', text: 'EVERYTHING', font: 'primary', size: 120, color: '#3DDC84', x: 0.8, y: 0.5, role: 'hero' },
        ],
        transitionOut: { type: 'pixel-flash', duration: 0.5 },
      },
    ],
    ...overrides,
  };
}

export interface MotionProject {
  root: string;
  storyboardPath: string;
  wordsPath: string;
  footagePath: string;
}

export function makeMotionProject(sb: Record<string, unknown> = storyboard()): MotionProject {
  const root = mkdtempSync(join(tmpdir(), 'motion-project-'));
  for (const d of ['footage', 'transcript', 'storyboard', 'ae', 'renders', 'review', 'references']) mkdirSync(join(root, d), { recursive: true });
  const footagePath = join(root, 'footage', 'interview.mp4');
  writeFileSync(footagePath, 'placeholder');
  const wordsPath = join(root, 'transcript', 'words.json');
  writeFileSync(wordsPath, JSON.stringify(whisperJson()));
  const storyboardPath = join(root, 'storyboard', 'storyboard.json');
  writeFileSync(storyboardPath, JSON.stringify(sb, null, 2));
  return { root, storyboardPath, wordsPath, footagePath };
}
