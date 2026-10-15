import * as vscode from 'vscode';
import { ApiError, EyalSecClient, normalizeBaseUrl } from './core/api';
import { CodeLocation } from './core/locations';
import { LocationResolver } from './resolver';
import { copyTextOf, EventsProvider, Node } from './tree';

const SECRET_PREFIX = 'eyalsec.apiKey:';

class KeyStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** The configured address, or an error message when it is not usable. */
  baseUrl(): { url?: string; error?: string } {
    const raw = vscode.workspace.getConfiguration('eyalsec').get<string>('url') || 'https://eyalsec.com';
    try {
      return { url: normalizeBaseUrl(raw) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  // The key is stored per address, so pointing the extension at another address
  // never sends it a key that was given for a different one.
  async get(url: string): Promise<string | undefined> {
    return this.secrets.get(SECRET_PREFIX + url);
  }

  async set(url: string, key: string): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + url, key);
  }

  async delete(url: string): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + url);
  }
}

export interface TestApi {
  provider: EventsProvider;
  setApiKey(key: string): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  const keys = new KeyStore(context.secrets);
  let warnedUrl = '';

  const syncContext = async (): Promise<string | undefined> => {
    const { url, error } = keys.baseUrl();
    const key = url ? await keys.get(url) : undefined;
    await vscode.commands.executeCommand('setContext', 'eyalsec.hasApiKey', !!key || !!error);
    if (error && warnedUrl !== error) {
      warnedUrl = error;
      void vscode.window.showErrorMessage(`EyalSec: ${error}`);
    }
    return key;
  };

  const source = {
    async client(): Promise<EyalSecClient | undefined> {
      const { url } = keys.baseUrl();
      if (!url) {
        return undefined;
      }
      const key = await syncContext();
      return key ? new EyalSecClient(url, key) : undefined;
    },
    problem(): string | undefined {
      return keys.baseUrl().error;
    },
  };

  const provider = new EventsProvider(source, new LocationResolver());
  const view = vscode.window.createTreeView<Node>('eyalsec.events', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  const setKey = async (key: string): Promise<void> => {
    const { url } = keys.baseUrl();
    if (!url) {
      throw new Error('The EyalSec address setting is not valid.');
    }
    await keys.set(url, key);
    await syncContext();
    provider.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('eyalsec.setApiKey', async () => {
      const { url, error } = keys.baseUrl();
      if (!url) {
        void vscode.window.showErrorMessage(`EyalSec: ${error}`);
        return;
      }
      const key = (
        await vscode.window.showInputBox({
          title: `EyalSec API key for ${new URL(url).host}`,
          prompt: 'Paste the key from Settings > API access on your dashboard. A read-only key is enough.',
          placeHolder: 'es2_...',
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) => {
            const t = v.trim();
            if (!t) {
              return 'Paste your API key.';
            }
            if (!t.startsWith('es2_') || /\s/.test(t)) {
              return 'An EyalSec API key starts with es2_ and has no spaces.';
            }
            return undefined;
          },
        })
      )?.trim();
      if (!key) {
        return;
      }
      try {
        const account = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'EyalSec: checking the key' },
          () => new EyalSecClient(url, key).account(),
        );
        await setKey(key);
        void vscode.window.showInformationMessage(
          `EyalSec: connected${account.username ? ` as ${account.username}` : ''}. The key is kept in VS Code's secret storage.`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          void vscode.window.showErrorMessage('EyalSec: that key was not accepted. Check that you copied all of it, or generate a new one.');
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `EyalSec: could not check the key (${(err as Error).message}).`,
          'Save anyway',
        );
        if (choice === 'Save anyway') {
          await setKey(key);
        }
      }
    }),

    vscode.commands.registerCommand('eyalsec.clearApiKey', async () => {
      const { url } = keys.baseUrl();
      if (url) {
        await keys.delete(url);
      }
      await syncContext();
      provider.refresh();
      void vscode.window.showInformationMessage('EyalSec: the API key was removed from this editor.');
    }),

    vscode.commands.registerCommand('eyalsec.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('eyalsec.loadMore', (kind: string) => provider.loadMore(kind)),

    vscode.commands.registerCommand('eyalsec.openEventsPage', async (node?: Node) => {
      const { url } = keys.baseUrl();
      if (!url) {
        return;
      }
      const target = vscode.Uri.parse(`${url}/scanner/events`);
      const withView = node?.type === 'product' ? target.with({ query: `view=${encodeURIComponent(node.kind)}` }) : target;
      await vscode.env.openExternal(withView);
    }),

    vscode.commands.registerCommand('eyalsec.copyText', async (node?: Node) => {
      const text = copyTextOf(node);
      if (text !== undefined) {
        await vscode.env.clipboard.writeText(text);
      }
    }),

    vscode.commands.registerCommand('eyalsec.openLocation', async (uri: vscode.Uri | undefined, loc: CodeLocation) => {
      if (!loc) {
        return;
      }
      if (!uri) {
        uri = await provider.resolver.resolve(loc.path);
      }
      if (!uri) {
        const choice = await vscode.window.showInformationMessage(
          `${loc.path} is not in this workspace. Open the folder that holds this code, or map its path with the eyalsec.pathMappings setting.`,
          'Copy path',
          'Open settings',
        );
        if (choice === 'Copy path') {
          await vscode.env.clipboard.writeText(`${loc.path}:${loc.line}`);
        } else if (choice === 'Open settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'eyalsec.pathMappings');
        }
        return;
      }
      const line = Math.max(0, loc.line - 1);
      const col = Math.max(0, (loc.column ?? 1) - 1);
      const doc = await vscode.workspace.openTextDocument(uri);
      const safeLine = Math.min(line, Math.max(0, doc.lineCount - 1));
      const pos = new vscode.Position(safeLine, col);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        preview: true,
      });
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('eyalsec')) {
        void syncContext();
        provider.refresh();
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),

    context.secrets.onDidChange((e) => {
      if (e.key.startsWith(SECRET_PREFIX)) {
        void syncContext();
      }
    }),
  );

  await syncContext();

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return { provider, setApiKey: setKey };
  }
  return undefined;
}

export function deactivate(): void {
  // Nothing to release: every resource is registered on the context.
}
