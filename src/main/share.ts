import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell, type BrowserWindow } from 'electron';
import { YtmonError } from '../shared/errors';
import { watchUrl } from '../shared/format';

export interface ShareResult {
  method: 'external-url' | 'reveal' | 'mail' | 'unsupported';
  message: string;
}

/**
 * (a) SHARE A URL — always available, no server call, no file implied.
 */
export function shareUrl(videoId: string): Promise<ShareResult> {
  const url = watchUrl(videoId);
  return shell
    .openExternal(url)
    .then(() => ({ method: 'external-url' as const, message: 'Opened on YouTube.' }))
    .catch(() => {
      throw new YtmonError('Could not open the browser. Copy the link instead.', 'share_failed');
    });
}

export function copyText(text: string): ShareResult {
  // clipboard write happens in the renderer via navigator.clipboard (no IPC needed)
  void text;
  return { method: 'external-url', message: text };
}

/**
 * (b) SHARE A FILE — the actual downloaded video. Electron has no generic OS
 * share sheet, so we do platform-appropriate things:
 *   - Windows:  open the containing folder with the file selected
 *   - macOS:    reveal in Finder
 *   - Linux:    open the containing folder in the file manager
 * The reliable fallback everywhere is "Save to this computer".
 */
export async function shareFile(win: BrowserWindow | null, filePath: string): Promise<ShareResult> {
  if (!fs.existsSync(filePath)) {
    throw new YtmonError('The local file is missing. Save it again from the server.', 'file_missing');
  }
  const dir = path.dirname(filePath);
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      await execFileAsync('explorer.exe', [`/select,${path.resolve(filePath)}`]);
      return { method: 'reveal', message: 'File selected in Explorer.' };
    }
    if (platform === 'darwin') {
      win?.show();
      shell.showItemInFolder(filePath);
      return { method: 'reveal', message: 'Revealed in Finder.' };
    }
    // Linux and others: open the containing folder; many desktops have no
    // share target. Callers offer "Save to this computer" as the fallback.
    await shell.openPath(dir);
    return {
      method: 'reveal',
      message: 'Opened the folder. Use "Save to this computer" to choose a destination on any desktop.',
    };
  } catch {
    return {
      method: 'unsupported',
      message: 'This system has no share integration. Use "Save to this computer" instead.',
    };
  }
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err) => (err ? reject(err) : resolve()));
  });
}