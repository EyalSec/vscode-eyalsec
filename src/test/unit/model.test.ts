import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildDetailNodes, describeSource } from '../../core/model';
import { EventRow, parseRow } from '../../core/rows';

function mkRow(over: Partial<EventRow> = {}): EventRow {
  const base = parseRow([
    '2026-07-05T12:00:00Z', 'os system', "'8.8.8.8; id'", 3, 'web-01', 'high', 'python', 42,
    '', '', false, 'This value was not sanitized.',
    [{ label: 'command injection', sev: 'critical' }], [], false, '', 'socket',
  ]);
  assert.ok(base);
  return { ...base, ...over };
}

const TRACE = [
  'Traceback (most recent call last):',
  '  File "/srv/demo/app/main.py", line 18, in <module>',
  '    serve()',
  '  File "/srv/demo/app/handler.py", line 12, in ping_host',
  '    os.system(cmd)',
].join('\n');

test('source and sink come from the code listings when the machine sends code', () => {
  const nodes = buildDetailNodes(mkRow(), {
    trace: TRACE,
    origin: 'socket recv 203.0.113.7:51234',
    source_code: '/srv/demo/app/handler.py:9\n>  9  host = request.args["host"]',
    sink_code: '/srv/demo/app/handler.py:12\n> 12  os.system(cmd)',
    repr_created: "'8.8.8.8; id'",
    runs: [{ cmdline: 'es-python app.py' }, { cmdline: 'es-python app.py --debug' }],
  });
  const byKind = Object.fromEntries(nodes.map((n) => [n.kind, n]));
  assert.deepEqual(byKind.source.location, { path: '/srv/demo/app/handler.py', line: 9 });
  assert.equal(byKind.source.description, 'socket');
  assert.match(byKind.source.tooltip ?? '', /203\.0\.113\.7/);
  assert.deepEqual(byKind.sink.location, { path: '/srv/demo/app/handler.py', line: 12 });
  assert.equal(byKind.sink.description, 'os system');
  assert.equal(byKind.value.copy, "'8.8.8.8; id'");
  assert.equal(byKind.created, undefined, 'the value when it came in is skipped when it is the same text');
  assert.equal(byKind.impact.description, 'command injection (critical)');
  assert.equal(byKind.command.label, 'Command line (2 runs)');
  assert.equal(byKind.trace.children?.length, 2);
  assert.deepEqual(byKind.trace.children?.[1].location, { path: '/srv/demo/app/handler.py', line: 12, func: 'ping_host' });
});

test('without code listings the sink falls back to the innermost file frame', () => {
  const nodes = buildDetailNodes(mkRow(), { trace: TRACE + '\n  at https://x.example/a.js:1:1' });
  const sink = nodes.find((n) => n.kind === 'sink');
  assert.deepEqual(sink?.location, { path: '/srv/demo/app/handler.py', line: 12, func: 'ping_host' });
  const source = nodes.find((n) => n.kind === 'source');
  assert.equal(source?.location, undefined);
});

test('an event with almost nothing still gets a source and a sink', () => {
  const nodes = buildDetailNodes(mkRow({ value: '', taintSource: '', impact: [] }), {});
  assert.deepEqual(nodes.map((n) => n.kind), ['source', 'sink']);
  assert.equal(nodes[0].description, 'not recorded');
});

test('describeSource prefers the most specific name the event has', () => {
  assert.equal(describeSource(mkRow({ taintSource: 'env' })), 'env');
  assert.equal(describeSource(mkRow({ taintSource: '', sourceLabel: 'URL query' })), 'URL query');
  assert.equal(describeSource(mkRow({ taintSource: '' }), { rule_source: 'any', origin: 'file /etc/app.conf\nmore' }), 'file /etc/app.conf more');
  assert.equal(describeSource(mkRow({ taintSource: '' }), { rule_source: 'db' }), 'db');
});

test('es-chromium context and extension are shown', () => {
  const nodes = buildDetailNodes(mkRow({ product: 'browser', context: 'https://shop.example/cart', extension: 'Helper 1.2' }), {
    extension: { label: 'Helper 1.2' },
  });
  assert.ok(nodes.some((n) => n.kind === 'context' && n.description === 'https://shop.example/cart'));
  assert.ok(nodes.some((n) => n.kind === 'extension' && n.description === 'Helper 1.2'));
});
