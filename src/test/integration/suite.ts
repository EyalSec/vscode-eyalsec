// Runs inside the VS Code extension host. No test framework: each check is a
// plain async function, and the first failure rejects run().
import { strict as assert } from 'node:assert';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../extension';
import type { Node } from '../../tree';

const KEY = 'es2_integrationKey0000000000000000000000000000';

const TRACE = [
  'Traceback (most recent call last):',
  '  File "/srv/demo/app/main.py", line 18, in <module>',
  '    serve()',
  '  File "/srv/demo/app/handler.py", line 12, in ping_host',
  '    os.system("ping -c 1 " + host)',
].join('\n');

function startFakeApi(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (req.headers['x-api-key'] !== KEY) {
        return json(401, { error: 'invalid or expired API key' });
      }
      if (req.url?.startsWith('/api/event_view_counts/')) {
        return json(200, { python: 2 });
      }
      if (req.url === '/api/get_all_events_with_count/') {
        const q = JSON.parse(body || '{}');
        assert.equal(q.view, 'python');
        return json(200, {
          events: [
            ['2026-10-15T12:00:00Z', 'os system', 'ping -c 1 8.8.8.8; id', 3, 'web-01', 'critical', 'python', 101,
              '', '', false, 'This value was not sanitized.', [{ label: 'command injection', sev: 'critical' }], [], false, '', 'socket'],
            ['2026-10-15T12:00:01Z', 'file write', 'x', 1, 'web-01', 'low', 'python', 102,
              '', '/var/log/app.log', false, '', [], [], false, '', 'file'],
          ],
          next_cursor: '',
        });
      }
      if (req.url === '/api/event/101') {
        return json(200, {
          trace: TRACE,
          origin: 'socket recv 203.0.113.7:51234',
          source_code: "/srv/demo/app/handler.py:9\n>  9    host = request.args['host']",
          sink_code: '/srv/demo/app/handler.py:12\n> 12    os.system("ping -c 1 " + host)',
          runs: [],
        });
      }
      if (req.url === '/api/event/102') {
        return json(200, { sink_code: '/opt/elsewhere/not_here.py:3\n> 3 x', runs: [] });
      }
      json(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

async function itemOf(api: TestApi, node: Node): Promise<vscode.TreeItem> {
  return api.provider.getTreeItem(node);
}

export async function run(): Promise<void> {
  const { server, url } = await startFakeApi();
  const checks: [string, () => Promise<void>][] = [];
  const check = (name: string, fn: () => Promise<void>) => checks.push([name, fn]);
  let api: TestApi;

  check('the extension activates and registers its commands', async () => {
    const ext = vscode.extensions.getExtension<TestApi>('eyalsec.vscode-eyalsec');
    assert.ok(ext, 'extension is installed in the test instance');
    api = (await ext.activate()) as TestApi;
    assert.ok(api?.provider, 'activate() returns the test API in test mode');
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['eyalsec.setApiKey', 'eyalsec.clearApiKey', 'eyalsec.refresh', 'eyalsec.openLocation', 'eyalsec.openEventsPage']) {
      assert.ok(cmds.includes(c), `${c} is registered`);
    }
  });

  check('with no key the tree is empty, so the welcome view shows', async () => {
    await vscode.workspace.getConfiguration('eyalsec').update('url', url, vscode.ConfigurationTarget.Global);
    api.provider.refresh();
    assert.deepEqual(await api.provider.getChildren(), []);
  });

  check('a stored key lists products, events, and the event detail', async () => {
    await api.setApiKey(KEY);
    const roots = await api.provider.getChildren();
    assert.deepEqual(roots.map((r) => r.type === 'product' && r.kind), ['python']);
    assert.equal((await itemOf(api, roots[0])).label, 'es-python');

    const events = await api.provider.getChildren(roots[0]);
    assert.equal(events.length, 2);
    const first = await itemOf(api, events[0]);
    assert.equal(first.label, 'os system');
    assert.match(String(first.description), /critical/);

    const detail = await api.provider.getChildren(events[0]);
    const items = await Promise.all(detail.map((d) => itemOf(api, d)));
    const sink = items.find((i) => i.label === 'Sink');
    assert.ok(sink?.command, 'the sink has a go-to-line command');
    const target = sink.command.arguments?.[0] as vscode.Uri | undefined;
    assert.ok(target, 'the sink resolved to a workspace file');
    assert.ok(target.fsPath.endsWith(path.join('app', 'handler.py')), target.fsPath);

    await vscode.commands.executeCommand(sink.command.command, ...(sink.command.arguments ?? []));
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'an editor opened');
    assert.ok(editor.document.uri.fsPath.endsWith('handler.py'));
    assert.equal(editor.selection.active.line, 11, 'the cursor is on line 12');
    assert.match(editor.document.lineAt(11).text, /os\.system/);

    const source = items.find((i) => i.label === 'Source');
    assert.equal((source?.command?.arguments?.[1] as { line: number }).line, 9);
    assert.match(String(source?.description), /socket/);

    const trace = detail[items.findIndex((i) => i.label === 'Call path')];
    const frames = await api.provider.getChildren(trace);
    const frameItems = await Promise.all(frames.map((f) => itemOf(api, f)));
    assert.equal(frameItems.length, 2);
    assert.ok(frameItems.every((f) => f.command?.arguments?.[0]), 'both frames are in the workspace');
  });

  check('a file that is not in the workspace says so instead of failing', async () => {
    const roots = await api.provider.getChildren();
    const events = await api.provider.getChildren(roots[0]);
    const detail = await api.provider.getChildren(events[1]);
    const items = await Promise.all(detail.map((d) => itemOf(api, d)));
    const sink = items.find((i) => i.label === 'Sink');
    assert.match(String(sink?.description), /not in this workspace/);
    assert.equal(sink?.command?.arguments?.[0], undefined);
  });

  check('a refused key shows a message that offers to set a new one', async () => {
    await api.setApiKey('es2_wrongKey');
    const roots = await api.provider.getChildren();
    assert.equal(roots.length, 1);
    const item = await itemOf(api, roots[0]);
    assert.match(String(item.label), /not accepted/);
    assert.equal(item.command?.command, 'eyalsec.setApiKey');
  });

  check('plain http to a remote address is refused before any key is sent', async () => {
    await vscode.workspace.getConfiguration('eyalsec').update('url', 'http://eyalsec.example', vscode.ConfigurationTarget.Global);
    api.provider.refresh();
    const roots = await api.provider.getChildren();
    const item = await itemOf(api, roots[0]);
    assert.match(String(item.label), /https/);
    await vscode.workspace.getConfiguration('eyalsec').update('url', undefined, vscode.ConfigurationTarget.Global);
  });

  try {
    for (const [name, fn] of checks) {
      try {
        await fn();
        console.log(`  ok  ${name}`);
      } catch (err) {
        console.error(`  FAIL ${name}`);
        throw err;
      }
    }
    console.log(`${checks.length} integration checks passed`);
  } finally {
    server.close();
  }
}
