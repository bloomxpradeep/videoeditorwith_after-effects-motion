/**
 * The storyboard resolver turns the editor's rules into checks. Each test here
 * is one rule from the motion design workflow, broken on purpose.
 */
import { resolveStoryboard, matchSpokenWords, estimateTextBox } from '../../motion/storyboard';
import { normalizeWhisperJson } from '../../motion/words';
import { storyboard, whisperJson } from '../helpers/motion-fixture';

const transcript = normalizeWhisperJson(whisperJson());
const resolve = (overrides: Record<string, unknown> = {}) => resolveStoryboard(storyboard(overrides), transcript);
const issuesFor = (r: ReturnType<typeof resolve>, rule: string) => r.issues.filter((i) => i.rule === rule);

describe('resolveStoryboard: the fixture is clean', () => {
  it('resolves three beats with no rule errors', () => {
    const r = resolve();
    expect(r.beats.map((b) => b.beat.id)).toEqual(['S01', 'S02', 'S03']);
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('names layers S01_<kind>_<id>', () => {
    expect(resolve().beats[0]!.elements.map((e) => e.layerName)).toEqual(['S01_text_name', 'S01_shape_rule']);
  });
});

describe('text appears only when it is said', () => {
  it('starts each text element on its first spoken word', () => {
    const r = resolve();
    expect(r.beats[0]!.elements[0]!.timing.in).toBe(0.82); // "Somrat"
    expect(r.beats[1]!.elements[0]!.timing.in).toBe(2.55); // "motion"
  });

  it('reveals letters word by word, never before the word is spoken', () => {
    const el = resolve().beats[0]!.elements[0]!;
    const keys = el.timing.charKeys;
    // SOMRAT (6) is fully shown by the end of its reveal, DUTTA (5) only from 1.22s.
    const at = (t: number) => { let c = 0; for (const k of keys) if (k.t <= t) c = k.chars; return c; };
    expect(at(1.21)).toBe(6);
    expect(at(1.6)).toBe(11);
    expect(keys[0]).toEqual({ t: 0.82, chars: 0 });
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.t).toBeGreaterThanOrEqual(keys[i - 1]!.t);
    expect(el.timing.totalChars).toBe(11);
  });

  it('is an error when the text is never spoken in its beat', () => {
    const sb = storyboard();
    (sb.beats as any[])[2].elements[0].text = 'REVOLUTION';
    const r = resolveStoryboard(sb, transcript);
    expect(issuesFor(r, 'spoken')).toEqual([expect.objectContaining({ level: 'error', beat: 'S03', element: 'everything' })]);
  });

  it('accepts a syncPhrase when the screen text differs from the words', () => {
    const sb = storyboard();
    Object.assign((sb.beats as any[])[2].elements[0], { text: 'ALL OF IT', syncPhrase: 'changes everything' });
    const r = resolveStoryboard(sb, transcript);
    expect(issuesFor(r, 'spoken')).toEqual([]);
    expect(r.beats[2]!.elements[0]!.timing.in).toBe(5.22);
  });

  it('allows unsynced text with an explicit time', () => {
    const sb = storyboard();
    Object.assign((sb.beats as any[])[2].elements[0], { text: 'LOGO', sync: false, appearAt: 5.5 });
    const r = resolveStoryboard(sb, transcript);
    expect(issuesFor(r, 'spoken')).toEqual([]);
    expect(r.beats[2]!.elements[0]!.timing.in).toBe(5.5);
  });
});

describe('text never covers the face', () => {
  it('is an error when an element overlaps a no-go zone', () => {
    const sb = storyboard();
    (sb.beats as any[])[0].elements[0].x = 0.5;
    const r = resolveStoryboard(sb, transcript);
    expect(issuesFor(r, 'no-go')).toEqual([expect.objectContaining({ level: 'error', element: 'name' })]);
  });

  it('only applies a timed zone while it is active', () => {
    const sb = storyboard({ noGoZones: [{ label: 'face', start: 3, end: 7, x: 0.38, y: 0.1, w: 0.2, h: 0.55 }] });
    (sb.beats as any[])[0].elements[0].x = 0.5; // S01 is 0-2s, before the zone starts
    expect(issuesFor(resolveStoryboard(sb, transcript), 'no-go')).toEqual([]);
  });
});

describe('animate in, hold, then transition', () => {
  it('warns when the exit starts before the element has held still', () => {
    const sb = storyboard();
    (sb.beats as any[])[0].end = 1.9;
    (sb.beats as any[])[1].start = 1.9;
    const r = resolveStoryboard(sb, transcript);
    expect(issuesFor(r, 'hold').map((i) => i.element)).toContain('name');
  });

  it('starts exits at the beat end minus the transition', () => {
    const el = resolve().beats[1]!.elements[0]!;
    expect(el.animOut).toBe('pixel-out');
    expect(el.timing.out).toBe(4.9);
    expect(el.timing.exitStart).toBe(4.5);
  });
});

describe('use every second of the footage', () => {
  it('warns about uncovered footage at the end and gaps between beats', () => {
    const sb = storyboard();
    (sb.beats as any[])[2].end = 6.0;
    (sb.beats as any[])[1].end = 4.5;
    const r = resolveStoryboard(sb, transcript);
    const msgs = issuesFor(r, 'coverage').map((i) => i.message);
    expect(msgs.some((m) => m.includes('last 1s'))).toBe(true);
    expect(msgs.some((m) => m.includes('Gap of 0.4s'))).toBe(true);
  });

  it('is an error when beats overlap', () => {
    const sb = storyboard();
    (sb.beats as any[])[1].start = 1.5;
    expect(issuesFor(resolveStoryboard(sb, transcript), 'beats').some((i) => i.level === 'error')).toBe(true);
  });
});

describe('style rules', () => {
  it('warns when nothing moves once it lands', () => {
    const sb = storyboard();
    (sb.beats as any[])[0].elements[0].microMotion = 'none';
    expect(issuesFor(resolveStoryboard(sb, transcript), 'static')).toHaveLength(1);
  });

  it('warns about colours outside the palette and too many fonts', () => {
    const sb = storyboard();
    Object.assign((sb.beats as any[])[0].elements[0], { color: '#FF0000', font: 'Comic-Sans' });
    const r = resolveStoryboard(sb, transcript);
    expect(issuesFor(r, 'palette')).toHaveLength(1);
    expect(issuesFor(r, 'fonts')).toHaveLength(1);
  });

  it('keeps the reserved bottom area clear', () => {
    const sb = storyboard();
    (sb.style as any).reservedBottom = 0.2;
    (sb.beats as any[])[0].elements[0].y = 0.9;
    expect(issuesFor(resolveStoryboard(sb, transcript), 'reserved-bottom')).toHaveLength(1);
  });

  it('flags abrupt animations', () => {
    const sb = storyboard();
    (sb.beats as any[])[1].elements[1].animInDuration = 0.1;
    expect(issuesFor(resolveStoryboard(sb, transcript), 'abrupt')).toHaveLength(1);
  });
});

describe('schema', () => {
  it('rejects a malformed beat id', () => {
    const sb = storyboard();
    (sb.beats as any[])[0].id = 'scene1';
    expect(() => resolveStoryboard(sb, transcript)).toThrow();
  });

  it('works without a transcript, warning that text cannot be synced', () => {
    const r = resolveStoryboard(storyboard(), null);
    expect(r.issues.some((i) => i.rule === 'spoken' && i.level === 'warning')).toBe(true);
    expect(r.beats[0]!.elements[0]!.timing.in).toBe(0);
  });
});

describe('helpers', () => {
  it('matches spoken words in order, ignoring punctuation', () => {
    const m = matchSpokenWords('somrat dutta', transcript.words, 0, 2);
    expect(m.matched.map((w) => w.word)).toEqual(['Somrat', 'Dutta.']);
    expect(m.missing).toEqual([]);
  });

  it('estimates a centred text box around its anchor', () => {
    const box = estimateTextBox('HELLO', 100, 0, 0.5, 0.5, 'center', { width: 1920, height: 1080 });
    expect(box.x + box.w / 2).toBeCloseTo(0.5, 5);
    expect(box.w).toBeGreaterThan(0.1);
  });
});
