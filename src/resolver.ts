import * as vscode from 'vscode';
import { applyPathMappings, candidateSuffixes, isNonFilePath, pathComponents } from './core/locations';

/**
 * Finds the workspace file a remote path refers to. The machine that reported
 * the event usually has the code somewhere else (/srv/app, a container, a CI
 * runner), so after the user's path mappings and the literal path, the longest
 * ending of the path that exists under a workspace folder wins.
 */
export class LocationResolver {
  private cache = new Map<string, vscode.Uri | null>();

  clear(): void {
    this.cache.clear();
  }

  async resolve(remotePath: string): Promise<vscode.Uri | undefined> {
    if (!remotePath || isNonFilePath(remotePath)) {
      return undefined;
    }
    const hit = this.cache.get(remotePath);
    if (hit !== undefined) {
      return hit ?? undefined;
    }
    const found = await this.find(remotePath);
    this.cache.set(remotePath, found ?? null);
    return found;
  }

  private async find(remotePath: string): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];

    const mapped = applyPathMappings(remotePath, this.mappings(folders));
    if (mapped) {
      const uri = this.toUri(mapped, folders);
      if (uri && (await isFile(uri))) {
        return uri;
      }
    }

    if (/^(\/|[A-Za-z]:[\\/])/.test(remotePath)) {
      const uri = vscode.Uri.file(remotePath);
      if (folders.some((f) => f.uri.scheme === 'file') && (await isFile(uri))) {
        return uri;
      }
    }

    const suffixes = candidateSuffixes(remotePath);
    for (const suffix of suffixes) {
      if (!suffix.includes('/')) {
        continue; // a bare file name is tried last, below
      }
      for (const folder of folders) {
        const uri = vscode.Uri.joinPath(folder.uri, ...suffix.split('/'));
        if (await isFile(uri)) {
          return uri;
        }
      }
    }

    const name = pathComponents(remotePath).pop();
    if (name && folders.length) {
      const matches = await vscode.workspace.findFiles(`**/${escapeGlob(name)}`, '**/node_modules/**', 2);
      if (matches.length === 1) {
        return matches[0];
      }
    }
    return undefined;
  }

  private mappings(folders: readonly vscode.WorkspaceFolder[]): Record<string, string> {
    const raw = vscode.workspace.getConfiguration('eyalsec').get<Record<string, string>>('pathMappings') ?? {};
    const first = folders[0]?.uri.fsPath ?? '';
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'string') {
        continue;
      }
      out[k] = v.replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (_m, name?: string) => {
        if (name) {
          return folders.find((f) => f.name === name)?.uri.fsPath ?? '';
        }
        return first;
      });
    }
    return out;
  }

  private toUri(p: string, folders: readonly vscode.WorkspaceFolder[]): vscode.Uri | undefined {
    if (/^(\/|[A-Za-z]:[\\/])/.test(p)) {
      return vscode.Uri.file(p);
    }
    const base = folders[0]?.uri;
    return base ? vscode.Uri.joinPath(base, ...pathComponents(p)) : undefined;
  }
}

async function isFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const st = await vscode.workspace.fs.stat(uri);
    return (st.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

function escapeGlob(s: string): string {
  return s.replace(/[*?[\]{}!]/g, (c) => `[${c}]`);
}
