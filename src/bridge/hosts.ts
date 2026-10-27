/**
 * Which Adobe app a bridge instance talks to.
 *
 * The file protocol (command-*.json in, response-*.json out, a heartbeat on
 * every poll) is identical for every CEP host, so one bridge class serves them
 * all. What differs is where the app is installed, how to tell it is running,
 * which folder its panel watches, and what to tell a user when it is not there.
 * That is all this profile holds.
 */

export type BridgeHostId = 'premiere' | 'aftereffects';

export interface BridgeHostMessages {
  /** No heartbeat at all: the panel is not open, or the app is closed. */
  panelNotRunning: string;
  /** Heartbeat present but the panel's bridge is stopped. */
  notStarted: string;
  /** App installed, not running, and could not be launched from here. */
  installedNotLaunched: string;
  /** App not found in the usual install location. */
  notInstalled: string;
  /** App was launched but the panel never reported in. */
  launchedNoPanel: string;
  /** A command was written and no response arrived before the timeout. */
  responseTimeout(tempDir: string): string;
}

export interface BridgeHostProfile {
  id: BridgeHostId;
  /** Human name used in logs and messages. */
  displayName: string;
  /** Install folders start with this, e.g. "Adobe After Effects 2025". */
  installDirPrefix: string;
  /** `pgrep -f` pattern on macOS. */
  macProcessPattern: string;
  /** Executable inside the install folder on Windows. */
  windowsExecutable: string;
  /** Image name `tasklist` reports on Windows. */
  windowsImageName: string;
  /** Environment variable that overrides the bridge folder. */
  tempDirEnv: string;
  /**
   * Shared folder name under the OS temp dir, matching the panel's default.
   * When unset, the server falls back to a private per-session folder, which
   * only works when the env var above points the panel and server at the same
   * place.
   */
  sharedTempDirName?: string;
  /** The read-only readiness tool agents are told to call. */
  verifyTool: string;
  messages: BridgeHostMessages;
}

// Kept byte-identical to the strings the Premiere bridge has always produced:
// tests, telemetry templates and isBridgeUnavailableMessage match on them.
export const PREMIERE_PANEL_NOT_RUNNING =
  'MCP Bridge is not running. Open Adobe Premiere Pro. The MCP Bridge panel auto-starts when Premiere opens it. If the panel is missing, choose Window > Extensions > MCP Bridge. Call verify_premiere_connection once rather than retrying other tools.';
export const PREMIERE_BRIDGE_NOT_STARTED =
  'MCP Bridge panel is open but the bridge is not started. Click Start Bridge, wait until it says Connected, then retry once.';

export const PREMIERE_HOST_PROFILE: BridgeHostProfile = {
  id: 'premiere',
  displayName: 'Adobe Premiere Pro',
  installDirPrefix: 'Adobe Premiere Pro',
  macProcessPattern: 'Adobe Premiere Pro',
  windowsExecutable: 'Adobe Premiere Pro.exe',
  windowsImageName: 'Adobe Premiere Pro.exe',
  tempDirEnv: 'PREMIERE_TEMP_DIR',
  verifyTool: 'verify_premiere_connection',
  messages: {
    panelNotRunning: PREMIERE_PANEL_NOT_RUNNING,
    notStarted: PREMIERE_BRIDGE_NOT_STARTED,
    installedNotLaunched:
      'Adobe Premiere Pro is installed but could not be launched from this environment. Open Premiere yourself. The MCP Bridge panel auto-starts. Then run verify_premiere_connection once.',
    notInstalled:
      'Adobe Premiere Pro is not installed in the usual location, so this server cannot launch it. Open Premiere, choose Window > Extensions > MCP Bridge if the panel does not appear, and run verify_premiere_connection once.',
    launchedNoPanel:
      'Premiere was launched but the MCP Bridge panel did not connect in time. When Premiere finishes opening, confirm Window > Extensions > MCP Bridge is visible, then run verify_premiere_connection once. Do not retry other tools yet.',
    responseTimeout: (tempDir: string) =>
      'Bridge response timeout. Ensure Premiere Pro is open, MCP Bridge (CEP or UXP) panel is open, ' +
      'Temp Directory is set to ' + tempDir + ', and Start Bridge is clicked. Do not retry until the panel says Connected.',
  },
};

export const AE_PANEL_NOT_RUNNING =
  'MCP Bridge is not running in After Effects. Open Adobe After Effects, then choose Window > Extensions > MCP Bridge (CEP). The bridge starts when the panel opens. Call ae_verify_connection once rather than retrying other tools.';
export const AE_BRIDGE_NOT_STARTED =
  'The MCP Bridge panel is open in After Effects but the bridge is stopped. Click Start Bridge in the panel, wait until it says Connected, then retry once.';

export const AFTER_EFFECTS_HOST_PROFILE: BridgeHostProfile = {
  id: 'aftereffects',
  displayName: 'Adobe After Effects',
  installDirPrefix: 'Adobe After Effects',
  macProcessPattern: 'Adobe After Effects',
  windowsExecutable: 'Support Files\\AfterFX.exe',
  windowsImageName: 'AfterFX.exe',
  tempDirEnv: 'AE_TEMP_DIR',
  sharedTempDirName: 'ae-mcp-bridge',
  verifyTool: 'ae_verify_connection',
  messages: {
    panelNotRunning: AE_PANEL_NOT_RUNNING,
    notStarted: AE_BRIDGE_NOT_STARTED,
    installedNotLaunched:
      'Adobe After Effects is installed but could not be launched from here. Open After Effects yourself, open Window > Extensions > MCP Bridge (CEP), then run ae_verify_connection once.',
    notInstalled:
      'Adobe After Effects was not found in the usual location, so this server cannot launch it. Open After Effects, open Window > Extensions > MCP Bridge (CEP), and run ae_verify_connection once.',
    launchedNoPanel:
      'After Effects was launched but the MCP Bridge panel did not connect in time. When After Effects finishes opening, choose Window > Extensions > MCP Bridge (CEP), then run ae_verify_connection once. Do not retry other tools yet.',
    responseTimeout: (tempDir: string) =>
      'Bridge response timeout. Ensure After Effects is open, the MCP Bridge (CEP) panel is open with ' +
      'Temp Directory set to ' + tempDir + ', and Start Bridge is clicked. A modal dialog open in After Effects also blocks scripts: close it first. Do not retry until the panel says Connected.',
  },
};

export function hostProfileFor(id: BridgeHostId): BridgeHostProfile {
  return id === 'aftereffects' ? AFTER_EFFECTS_HOST_PROFILE : PREMIERE_HOST_PROFILE;
}
