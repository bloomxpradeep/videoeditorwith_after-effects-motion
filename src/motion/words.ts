/**
 * Word-level transcripts: the "ears" of the motion workflow.
 *
 * Claude cannot hear a video. Every timing decision downstream (when a word of
 * on-screen text appears, where a beat starts) is made against this file, so it
 * is normalised into one small shape no matter which Whisper produced it.
 */
import { promises as fs } from 'node:fs';

export interface TranscriptWord {
  /** The word as spoken, without surrounding whitespace. */
  word: string;
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  /** Whisper's confidence, 0..1, when it reported one. */
  probability?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  version: 1;
  source?: string;
  language?: string;
  duration?: number;
  words: TranscriptWord[];
  segments: TranscriptSegment[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function cleanWord(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Accepts the JSON written by openai-whisper (`--word_timestamps True`),
 * faster-whisper via scripts/motion/transcribe.py, whisper.cpp's `-ojf`
 * output, or an already-normalised transcript, and returns a Transcript.
 */
export function normalizeWhisperJson(raw: unknown, source?: string): Transcript {
  if (!raw || typeof raw !== 'object') throw new Error('Transcript JSON is empty or not an object.');
  const data = raw as Record<string, any>;

  const words: TranscriptWord[] = [];
  const segments: TranscriptSegment[] = [];

  const pushWord = (text: unknown, start: unknown, end: unknown, probability?: unknown): void => {
    const word = cleanWord(text);
    const s = Number(start);
    const e = Number(end);
    if (!word || !Number.isFinite(s) || !Number.isFinite(e)) return;
    const entry: TranscriptWord = { word, start: round3(s), end: round3(Math.max(e, s)) };
    const p = Number(probability);
    if (probability !== undefined && Number.isFinite(p)) entry.probability = Math.round(p * 1000) / 1000;
    words.push(entry);
  };

  const segmentsCarryWords = Array.isArray(data.segments) && data.segments.some((seg: any) => Array.isArray(seg?.words));
  if (Array.isArray(data.words) && !segmentsCarryWords && !Array.isArray(data.transcription)) {
    // Already normalised (our words.json, whose segments are text-only) or a flat word list.
    for (const w of data.words) pushWord(w.word ?? w.text, w.start, w.end, w.probability);
    if (Array.isArray(data.segments)) {
      for (const seg of data.segments) {
        const text = cleanWord(seg.text);
        if (text && Number.isFinite(Number(seg.start)) && Number.isFinite(Number(seg.end))) segments.push({ start: round3(Number(seg.start)), end: round3(Number(seg.end)), text });
      }
    }
  } else if (Array.isArray(data.segments)) {
    for (const seg of data.segments) {
      const segWords = Array.isArray(seg.words) ? seg.words : [];
      for (const w of segWords) pushWord(w.word ?? w.text, w.start, w.end, w.probability ?? w.score);
      const text = cleanWord(seg.text);
      if (text && Number.isFinite(Number(seg.start)) && Number.isFinite(Number(seg.end))) {
        segments.push({ start: round3(Number(seg.start)), end: round3(Number(seg.end)), text });
      }
    }
  } else if (Array.isArray(data.transcription)) {
    // whisper.cpp -ojf: transcription[].tokens[] with offsets in ms.
    for (const seg of data.transcription) {
      const text = cleanWord(seg.text);
      const from = Number(seg.offsets?.from) / 1000;
      const to = Number(seg.offsets?.to) / 1000;
      if (text && Number.isFinite(from) && Number.isFinite(to)) segments.push({ start: round3(from), end: round3(to), text });
      let current: { text: string; start: number; end: number; p: number[] } | null = null;
      for (const tok of Array.isArray(seg.tokens) ? seg.tokens : []) {
        const t = String(tok.text ?? '');
        if (!t || /^\[.*\]$/.test(t.trim())) continue;
        const s = Number(tok.offsets?.from) / 1000;
        const e = Number(tok.offsets?.to) / 1000;
        if (/^\s/.test(t) || !current) {
          if (current) pushWord(current.text, current.start, current.end, current.p.reduce((a, b) => a + b, 0) / current.p.length);
          current = { text: t, start: s, end: e, p: [Number(tok.p ?? 1)] };
        } else {
          current.text += t;
          current.end = e;
          current.p.push(Number(tok.p ?? 1));
        }
      }
      if (current) pushWord(current.text, current.start, current.end, current.p.reduce((a, b) => a + b, 0) / current.p.length);
    }
  } else {
    throw new Error('Unrecognised transcript JSON: expected "segments" (Whisper), "transcription" (whisper.cpp) or "words".');
  }

  words.sort((a, b) => a.start - b.start);
  if (segments.length === 0 && words.length > 0) segments.push(...segmentsFromWords(words));

  const transcript: Transcript = { version: 1, words, segments };
  if (source) transcript.source = source;
  if (typeof data.language === 'string') transcript.language = data.language;
  const duration = Number(data.duration);
  if (Number.isFinite(duration) && duration > 0) transcript.duration = round3(duration);
  else if (words.length) transcript.duration = words[words.length - 1]!.end;
  return transcript;
}

/** Groups words into subtitle-sized segments: a pause, sentence end, or ~42 characters. */
export function segmentsFromWords(words: TranscriptWord[], maxChars = 42, maxGap = 0.6): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptWord[] = [];
  const flush = (): void => {
    if (!cur.length) return;
    out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.word).join(' ') });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const length = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
    if (prev && (w.start - prev.end > maxGap || length > maxChars)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word)) flush();
  }
  flush();
  return out;
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(transcript: Transcript): string {
  const segs = transcript.segments.length ? transcript.segments : segmentsFromWords(transcript.words);
  return segs
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text}\n`)
    .join('\n');
}

export function toPlainText(transcript: Transcript): string {
  const segs = transcript.segments.length ? transcript.segments : segmentsFromWords(transcript.words);
  return segs.map((s) => s.text).join('\n') + '\n';
}

/** Lowercase letters and digits only, so "Dutta," and "dutta" compare equal. */
export function normalizeToken(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

export function tokenize(text: string): string[] {
  return text.split(/\s+/).map(normalizeToken).filter(Boolean);
}

export interface SpellingFlag {
  word: string;
  start: number;
  reason: 'low_confidence' | 'proper_noun';
  probability?: number;
}

/**
 * Words worth a human look before anything is built on them: low-confidence
 * words, and capitalised words mid-sentence (names and brands Whisper is most
 * likely to misspell).
 */
export function flagSuspectWords(transcript: Transcript, threshold = 0.6): SpellingFlag[] {
  const flags: SpellingFlag[] = [];
  const seen = new Set<string>();
  const words = transcript.words;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const bare = w.word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!bare) continue;
    const key = bare.toLowerCase();
    const prev = words[i - 1];
    const sentenceStart = !prev || /[.!?]$/.test(prev.word);
    if (w.probability !== undefined && w.probability < threshold && !seen.has(key)) {
      seen.add(key);
      flags.push({ word: bare, start: w.start, reason: 'low_confidence', probability: w.probability });
    } else if (!sentenceStart && /^\p{Lu}/u.test(bare) && bare !== 'I' && !seen.has(key)) {
      seen.add(key);
      flags.push({ word: bare, start: w.start, reason: 'proper_noun' });
    }
  }
  return flags;
}

export interface Correction {
  from: string;
  to: string;
}

/**
 * Applies spelling corrections across the word list, keeping each spoken word's
 * timing. A multi-word "from" ("Somrud Dutta") is matched across consecutive
 * words; when "to" has the same number of words they are corrected one for one,
 * otherwise the whole phrase collapses into the first word's slot spanning the
 * original timing. Punctuation attached to the original words is preserved.
 */
export function applyCorrections(transcript: Transcript, corrections: Correction[]): { transcript: Transcript; changes: Array<{ from: string; to: string; at: number }> } {
  let words = transcript.words.map((w) => ({ ...w }));
  const changes: Array<{ from: string; to: string; at: number }> = [];
  for (const c of corrections) {
    const fromTokens = tokenize(c.from);
    const toWords = c.to.trim().split(/\s+/).filter(Boolean);
    if (!fromTokens.length || !toWords.length) continue;
    const next: TranscriptWord[] = [];
    for (let i = 0; i < words.length; ) {
      const window = words.slice(i, i + fromTokens.length);
      const matches = window.length === fromTokens.length && window.every((w, k) => normalizeToken(w.word) === fromTokens[k]);
      if (!matches) {
        next.push(words[i]!);
        i++;
        continue;
      }
      const lead = window[0]!.word.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? '';
      const trail = window[window.length - 1]!.word.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? '';
      if (toWords.length === window.length) {
        window.forEach((w, k) => {
          const pre = k === 0 ? lead : '';
          const post = k === window.length - 1 ? trail : (w.word.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? '');
          next.push({ ...w, word: pre + toWords[k]! + post });
        });
      } else {
        const first = window[0]!;
        const last = window[window.length - 1]!;
        const merged: TranscriptWord = { word: lead + toWords.join(' ') + trail, start: first.start, end: last.end };
        if (first.probability !== undefined) merged.probability = first.probability;
        next.push(merged);
      }
      changes.push({ from: window.map((w) => w.word).join(' '), to: toWords.join(' '), at: window[0]!.start });
      i += fromTokens.length;
    }
    words = next;
  }

  const fixText = (text: string): string => {
    let out = text;
    for (const c of corrections) {
      const pattern = c.from.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      if (!pattern) continue;
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'), c.to);
    }
    return out;
  };
  const segments = transcript.segments.map((s) => ({ ...s, text: fixText(s.text) }));
  return { transcript: { ...transcript, words, segments }, changes };
}

export async function readTranscript(path: string): Promise<Transcript> {
  const raw = JSON.parse(await fs.readFile(path, 'utf8'));
  return normalizeWhisperJson(raw);
}
