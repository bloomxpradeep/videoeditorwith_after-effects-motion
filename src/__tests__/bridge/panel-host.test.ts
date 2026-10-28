/**
 * One panel, two apps.
 *
 * The CEP panel is installed once and shows up in both Premiere Pro and After
 * Effects. Each copy must watch its own app's bridge folder: if the After
 * Effects panel watched Premiere's folder it would pick up Premiere commands
 * and run them against the wrong app.
 */
import { loadPanel } from '../helpers/panel';

function defaultFolderFor(appName: 'PPRO' | 'AEFT'): string | null {
  const panel = loadPanel({ appName });
  // The stub reports every path as a directory so ensureDirectory accepts it.
  (panel.fs as unknown as { statSync: () => { isDirectory: () => boolean } }).statSync =
    () => ({ isDirectory: () => true });
  panel.bridge.tempDirectory = '';
  return panel.bridge.getTempDirectory();
}

describe('CEP panel host detection', () => {
  it('reports the app it was loaded in', () => {
    expect(loadPanel({ appName: 'AEFT' }).host).toBe('AEFT');
    expect(loadPanel({ appName: 'PPRO' }).host).toBe('PPRO');
  });

  it('keeps Premiere on its existing default folder', () => {
    expect(defaultFolderFor('PPRO')).toBe('/tmp/premiere-mcp-bridge');
  });

  it('gives After Effects its own folder, matching the server default', () => {
    expect(defaultFolderFor('AEFT')).toBe('/tmp/ae-mcp-bridge');
  });
});
