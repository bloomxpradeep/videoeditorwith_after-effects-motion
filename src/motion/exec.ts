/**
 * Running the local helpers the motion workflow depends on: ffmpeg, ffprobe,
 * yt-dlp and Python (for faster-whisper and OpenCV).
 *
 * The MCP server is started by the Claude app, and apps launched from the macOS
 * Dock get a minimal PATH (/usr/bin:/bin:...) that does not include Homebrew.
 * So every lookup also checks the usual Homebrew and installer locations, and
 * the installer's own Python is preferred when it exists.
 */
import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const MOTION_SCRIPTS_DIR = join(PACKAGE_ROOT, 'scripts', 'motion');

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin'];

/** Where the installer puts its Python environment. */
export const MOTION_HOME = process.env.MOTION_DIRECTOR_HOME || join(homedir(), '.motion-director');

async function isExecutable(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(name: string, envOverride?: string): Promise<string | null> {
  const override = envOverride ? process.env[envOverride] : undefined;
  if (override && (await isExecutable(override))) return override;
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}

/** The installer's venv Python first (it has faster-whisper and OpenCV), then any python3. */
export async function findPython(): Promise<string | null> {
  const venv = process.platform === 'win32'
    ? join(MOTION_HOME, 'venv', 'Scripts', 'python.exe')
    : join(MOTION_HOME, 'venv', 'bin', 'python');
  const override = process.env.MOTION_PYTHON;
  if (override && (await isExecutable(override))) return override;
  if (await isExecutable(venv)) return venv;
  return findExecutable('python3');
}

export interface RunResult { stdout: string; stderr: string; code: number }

export function run(command: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const extraPath = [...EXTRA_DIRS, process.env.PATH ?? ''].join(delimiter);
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
        cwd: options.cwd,
        env: { ...process.env, PATH: extraPath, PYTHONUNBUFFERED: '1' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : 1) : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (error && !stderr ? String(error.message) : ''), code });
      },
    );
  });
}

export function missingTool(tool: string, install: string): { success: false; retry: false; status: 'missing_dependency'; userActionRequired: true; error: string; nextStep: string } {
  return {
    success: false,
    retry: false,
    status: 'missing_dependency',
    userActionRequired: true,
    error: `${tool} is not installed or not found.`,
    nextStep: `${install} Or re-run the Motion Director installer (scripts/motion/setup-editor-macos.sh), which installs everything this workflow needs.`,
  };
}

export const INSTALL_HINTS = {
  ffmpeg: 'Install it with Homebrew: brew install ffmpeg.',
  ytdlp: 'Install it with Homebrew: brew install yt-dlp.',
  python: 'Install Python 3 with Homebrew: brew install python.',
};

export interface MediaInfo {
  path: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  codec: string | null;
}

function parseRate(rate: unknown): number | null {
  const m = String(rate ?? '').match(/^(\d+)(?:\/(\d+))?$/);
  if (!m) return null;
  const v = Number(m[1]) / Number(m[2] ?? 1);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

export async function probeMedia(path: string): Promise<MediaInfo | { success: false; error: string; [k: string]: unknown }> {
  const ffprobe = await findExecutable('ffprobe', 'FFPROBE_PATH');
  if (!ffprobe) return missingTool('ffprobe (part of ffmpeg)', INSTALL_HINTS.ffmpeg);
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], { timeoutMs: 60000 });
  if (r.code !== 0) return { success: false, error: `ffprobe could not read ${path}: ${r.stderr.trim().slice(0, 400)}` };
  const data = JSON.parse(r.stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? video?.duration);
  return {
    path,
    duration: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
    width: video ? Number(video.width) || null : null,
    height: video ? Number(video.height) || null : null,
    fps: video ? parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) : null,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    codec: video ? String(video.codec_name ?? '') || null : null,
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
