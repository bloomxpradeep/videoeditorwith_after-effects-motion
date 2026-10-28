/**
 * Transcripts are the timing source for everything downstream, so the
 * normaliser has to accept every Whisper flavour and corrections must never
 * shift a word's timing.
 */
import { applyCorrections, flagSuspectWords, normalizeWhisperJson, toSrt, tokenize } from '../../motion/words';
import { whisperJson } from '../helpers/motion-fixture';

describe('normalizeWhisperJson', () => {
  it('reads faster-whisper / openai-whisper segments with word timings', () => {
    const t = normalizeWhisperJson(whisperJson(), '/v.mp4');
    expect(t.words).toHaveLength(15);
    expect(t.words[2]).toEqual({ word: 'Somrat', start: 0.82, end: 1.2, probability: 0.41 });
    expect(t.language).toBe('en');
    expect(t.duration).toBe(7);
    expect(t.segments[0]!.text).toBe("Hi, I'm Somrat Dutta.");
  });

  it('reads whisper.cpp full JSON, joining sub-word tokens into words', () => {
    const t = normalizeWhisperJson({
      transcription: [{
        offsets: { from: 0, to: 2000 }, text: ' Hello there',
        tokens: [
          { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 1 },
          { text: ' Hel', offsets: { from: 100, to: 300 }, p: 0.9 },
          { text: 'lo', offsets: { from: 300, to: 500 }, p: 0.8 },
          { text: ' there', offsets: { from: 600, to: 1000 }, p: 0.95 },
        ],
      }],
    });
    expect(t.words.map((w) => w.word)).toEqual(['Hello', 'there']);
    expect(t.words[0]).toMatchObject({ start: 0.1, end: 0.5 });
  });

  it('round-trips its own output', () => {
    const once = normalizeWhisperJson(whisperJson());
    const twice = normalizeWhisperJson(once);
    expect(twice.words).toEqual(once.words);
  });

  it('rejects something that is not a transcript', () => {
    expect(() => normalizeWhisperJson({ foo: 1 })).toThrow('Unrecognised transcript JSON');
  });
});

describe('applyCorrections', () => {
  const base = normalizeWhisperJson(whisperJson());

  it('fixes a two-word name across words, keeping each word\'s timing and punctuation', () => {
    const wrong = { ...base, words: base.words.map((w) => (w.word === 'Somrat' ? { ...w, word: 'Somrud' } : w)) };
    const { transcript, changes } = applyCorrections(wrong, [{ from: 'Somrud Dutta', to: 'Somrat Dutta' }]);
    expect(changes).toHaveLength(1);
    expect(transcript.words[2]).toMatchObject({ word: 'Somrat', start: 0.82, end: 1.2 });
    expect(transcript.words[3]).toMatchObject({ word: 'Dutta.', start: 1.22, end: 1.7 });
  });

  it('collapses into one slot when the word count changes, spanning the original timing', () => {
    const { transcript } = applyCorrections(base, [{ from: 'solo founders', to: 'solopreneurs' }]);
    const w = transcript.words.find((x) => x.word === 'solopreneurs');
    expect(w).toMatchObject({ start: 3.62, end: 4.6 });
    expect(transcript.words).toHaveLength(14);
  });

  it('also corrects the segment text used for subtitles', () => {
    const { transcript } = applyCorrections(base, [{ from: 'Somrat', to: 'Samrat' }]);
    expect(transcript.segments[0]!.text).toBe("Hi, I'm Samrat Dutta.");
    expect(toSrt(transcript)).toContain("Hi, I'm Samrat Dutta.");
  });
});

describe('flagSuspectWords', () => {
  it('flags low-confidence words and mid-sentence capitalised names', () => {
    const flags = flagSuspectWords(normalizeWhisperJson(whisperJson()));
    expect(flags.find((f) => f.word === 'Somrat')).toMatchObject({ reason: 'low_confidence' });
    expect(flags.find((f) => f.word === 'Dutta')).toMatchObject({ reason: 'proper_noun' });
    expect(flags.find((f) => f.word === 'Hi')).toBeUndefined();
  });
});

describe('toSrt', () => {
  it('writes numbered cues with comma milliseconds', () => {
    const srt = toSrt(normalizeWhisperJson(whisperJson()));
    expect(srt.startsWith('1\n00:00:00,400 --> 00:00:01,700\n')).toBe(true);
  });
});

describe('tokenize', () => {
  it('ignores case, punctuation and accents', () => {
    expect(tokenize("Hi, I'm SOMRÁT!")).toEqual(['hi', 'im', 'somrat']);
  });
});
