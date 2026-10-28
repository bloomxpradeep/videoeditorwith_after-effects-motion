/**
 * The storyboard page is what the editor approves, so it must load, carry the
 * resolved timings, and never let storyboard text break out of its script tag.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderStoryboardHtml } from '../../motion/storyboard-html';
import { resolveStoryboard } from '../../motion/storyboard';
import { normalizeWhisperJson } from '../../motion/words';
import { PremiereProTools } from '../../tools/index';
import { makeMotionProject, storyboard, whisperJson } from '../helpers/motion-fixture';

const transcript = normalizeWhisperJson(whisperJson());

function dataFrom(html: string): any {
  const m = html.match(/const DATA = (.*);\nconst OUT/);
  if (!m) throw new Error('DATA not found');
  return JSON.parse(m[1]!);
}

describe('renderStoryboardHtml', () => {
  it('embeds every beat with resolved timings and a relative footage path', () => {
    const resolved = resolveStoryboard(storyboard(), transcript);
    const html = renderStoryboardHtml({ resolved, htmlPath: '/p/storyboard/storyboard.html', footagePath: '/p/footage/interview.mp4', mediaPaths: {} });
    const data = dataFrom(html);
    expect(data.video).toBe('../footage/interview.mp4');
    expect(data.beats.map((b: any) => b.id)).toEqual(['S01', 'S02', 'S03']);
    expect(data.beats[0].elements[0].t.in).toBe(0.82);
    expect(html).toContain('Play full storyboard');
    expect(html).toContain('<title>Solo Founder Intro — Storyboard</title>');
  });

  it('cannot be broken out of by storyboard text', () => {
    const sb = storyboard({ title: 'A </script><script>alert(1)</script>' });
    (sb.beats as any[])[0].notes = '</script><img src=x onerror=alert(1)>';
    const resolved = resolveStoryboard(sb, transcript);
    const html = renderStoryboardHtml({ resolved, htmlPath: '/p/s/storyboard.html', footagePath: '/p/f.mp4', mediaPaths: {} });
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('A &lt;/script&gt;');
    expect(dataFrom(html).beats[0].notes).toBe('</script><img src=x onerror=alert(1)>');
  });

  it('client script is valid JavaScript', () => {
    const resolved = resolveStoryboard(storyboard(), transcript);
    const html = renderStoryboardHtml({ resolved, htmlPath: '/p/s/storyboard.html', footagePath: '/p/f.mp4', mediaPaths: {} });
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('motion_build_storyboard', () => {
  it('writes storyboard.html beside the JSON and reports the rule checks', async () => {
    const p = makeMotionProject();
    try {
      const tools = new PremiereProTools({ executeScript: async () => ({}) } as any, { app: 'aftereffects' });
      const result: any = await tools.executeTool('motion_build_storyboard', { storyboardPath: p.storyboardPath });
      expect(result.success).toBe(true);
      expect(result.htmlPath).toBe(join(p.root, 'storyboard', 'storyboard.html'));
      expect(result.footageFound).toBe(true);
      expect(result.checks.errors).toBe(0);
      expect(readFileSync(result.htmlPath, 'utf8')).toContain('S03');
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it('explains a storyboard that does not match the format', async () => {
    const p = makeMotionProject();
    try {
      writeFileSync(p.storyboardPath, JSON.stringify({ title: 'x', beats: [] }));
      const tools = new PremiereProTools({ executeScript: async () => ({}) } as any, { app: 'aftereffects' });
      const result: any = await tools.executeTool('motion_build_storyboard', { storyboardPath: p.storyboardPath });
      expect(result).toMatchObject({ success: false, status: 'invalid_storyboard' });
      expect(result.problems.join(' ')).toContain('footage');
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});

describe('motion_fix_transcript and motion_new_project', () => {
  it('corrects words.json in place and rewrites the srt and txt', async () => {
    const p = makeMotionProject();
    try {
      const tools = new PremiereProTools({ executeScript: async () => ({}) } as any, { app: 'aftereffects' });
      const result: any = await tools.executeTool('motion_fix_transcript', { wordsPath: p.wordsPath, corrections: [{ from: 'Somrat', to: 'Samrat' }] });
      expect(result.changed).toBe(1);
      expect(readFileSync(join(p.root, 'transcript', 'transcript.srt'), 'utf8')).toContain('Samrat');
      expect(JSON.parse(readFileSync(p.wordsPath, 'utf8')).words[2].word).toBe('Samrat');
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it('creates the project folders', async () => {
    const p = makeMotionProject();
    try {
      const tools = new PremiereProTools({ executeScript: async () => ({}) } as any, { app: 'aftereffects' });
      const result: any = await tools.executeTool('motion_new_project', { name: 'My Café Video!', root: p.root });
      expect(result.projectDir).toBe(join(p.root, 'my-cafe-video'));
      expect(readFileSync(join(result.projectDir, 'README.md'), 'utf8')).toContain('footage/');
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});
