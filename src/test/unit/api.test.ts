import { strict as assert } from 'node:assert';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ApiError, EyalSecClient, normalizeBaseUrl } from '../../core/api';
import { loadBatch } from '../../core/pager';
import { parseRow, productName, severityRank } from '../../core/rows';

const KEY = 'es2_unitTestKey000000000000000000000000000000';

function row(id: number, where = 'os system', sev = 'high'): unknown[] {
  return [
    '2026-07-05T12:00:00Z', where, "'x; id'", 3, 'web-01', sev, 'python', id,
    '', '', false, 'This value was not sanitized.',
    [{ label: 'command injection', sev: 'critical' }], [], false, '', 'socket',
  ];
}

interface Seen {
  method: string;
  url: string;
  key: string | undefined;
  body: string;
}

let server: Server;
let base: string;
const seen: Seen[] = [];

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = req.headers['x-api-key'] as string | undefined;
      seen.push({ method: req.method ?? '', url: req.url ?? '', key, body });
      const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(v));
      };
      if (key !== KEY) {
        return json(401, { error: 'invalid or expired API key' });
      }
      if (req.url === '/api/event_view_counts/?bucket=live') {
        return json(200, { python: 3, browser: 0 });
      }
      if (req.url === '/api/rate') {
        return json(429, { error: 'slow down' }, { 'Retry-After': '7' });
      }
      if (req.url === '/api/event/5') {
        return json(200, { trace: 'Traceback', sink_code: '/srv/a.py:1\n> 1 x' });
      }
      if (req.url === '/api/event/6') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>login</html>');
      }
      if (req.url === '/api/get_all_events_with_count/') {
        const q = JSON.parse(body || '{}') as { cursor?: string; view?: string };
        if (q.view === 'hidden') {
          return json(200, { events: [], next_cursor: 'c1', exhausted: true, hidden_by: { id: 4, label: 'mute all' } });
        }
        // Three pages: one event, an EMPTY page that still has a cursor, then two events.
        if (!q.cursor) {
          return json(200, { events: [row(1)], next_cursor: 'c1' });
        }
        if (q.cursor === 'c1') {
          return json(200, { events: [], next_cursor: 'c2' });
        }
        if (q.cursor === 'c2') {
          return json(200, { events: [row(2), row(3), ['bad']], next_cursor: '' });
        }
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('normalizeBaseUrl accepts https and loopback http only', () => {
  assert.equal(normalizeBaseUrl('https://eyalsec.com/'), 'https://eyalsec.com');
  assert.equal(normalizeBaseUrl(' https://eyalsec.com/scanner/events '), 'https://eyalsec.com');
  assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:9'), 'http://127.0.0.1:9');
  assert.throws(() => normalizeBaseUrl('http://eyalsec.com'), /https/);
  assert.throws(() => normalizeBaseUrl('ftp://eyalsec.com'), /https/);
  assert.throws(() => normalizeBaseUrl('https://user:pw@eyalsec.com'), /user name/);
  assert.throws(() => normalizeBaseUrl('not a url'), /not a valid address/);
});

test('the client sends the key in X-API-Key and parses JSON', async () => {
  const c = new EyalSecClient(base, KEY);
  assert.deepEqual(await c.viewCounts('live'), { python: 3, browser: 0 });
  const last = seen[seen.length - 1];
  assert.equal(last.key, KEY);
  assert.equal(last.method, 'GET');
});

test('a wrong key is a 401 ApiError that says what to do', async () => {
  const c = new EyalSecClient(base, 'es2_wrong');
  await assert.rejects(c.viewCounts('live'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /Set a new one/);
    return true;
  });
});

test('429 carries Retry-After', async () => {
  const c = new EyalSecClient(base, KEY);
  // Reach the private request() through a cast: the rate-limit path is shared by every call.
  const req = (c as unknown as { request(m: string, p: string): Promise<unknown> }).request.bind(c);
  await assert.rejects(req('GET', '/api/rate'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfter, 7);
    return true;
  });
});

test('a non-JSON answer is reported as a wrong address, not a crash', async () => {
  const c = new EyalSecClient(base, KEY);
  await assert.rejects(c.event(6), /not JSON/);
  await assert.rejects(c.event(-1), /Not an event id/);
  const d = await c.event(5);
  assert.equal(d.sink_code, '/srv/a.py:1\n> 1 x');
});

test('an unreachable address is a clear error', async () => {
  const c = new EyalSecClient('http://127.0.0.1:1', KEY, undefined, 2000);
  await assert.rejects(c.viewCounts(), /Could not reach/);
});

test('loadBatch follows the cursor past an empty page', async () => {
  const c = new EyalSecClient(base, KEY);
  const before = seen.length;
  const batch = await loadBatch(c, { view: 'python', sort: 'severity' }, '', 100);
  assert.deepEqual(batch.events.map((e) => e.id), [1, 2, 3]);
  assert.equal(batch.cursor, '');
  const bodies = seen.slice(before).map((s) => JSON.parse(s.body));
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].cursor, undefined);
  assert.equal(bodies[1].cursor, 'c1');
  assert.equal(bodies[2].cursor, 'c2');
  assert.ok(bodies.every((b) => b.view === 'python' && b.sort === 'severity'));
});

test('loadBatch stops once it has enough, and hands back the cursor', async () => {
  const c = new EyalSecClient(base, KEY);
  const batch = await loadBatch(c, {}, '', 1);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.cursor, 'c1');
  const capped = await loadBatch(c, {}, '', 100, 2);
  assert.equal(capped.cursor, 'c2', 'the request cap leaves a cursor to continue from');
});

test('loadBatch reports a hide-all rule', async () => {
  const c = new EyalSecClient(base, KEY);
  const batch = await loadBatch(c, { view: 'hidden' }, '', 100);
  assert.deepEqual(batch.hiddenBy, { id: 4, label: 'mute all' });
  assert.equal(batch.cursor, '');
});

test('parseRow reads by position and tolerates extra and missing values', () => {
  const r = parseRow([...row(9), 'a future field']);
  assert.ok(r);
  assert.equal(r.id, 9);
  assert.equal(r.where, 'os system');
  assert.equal(r.taintSource, 'socket');
  assert.deepEqual(r.impact, [{ label: 'command injection', sev: 'critical' }]);
  const old = parseRow(row(10).slice(0, 12));
  assert.ok(old);
  assert.equal(old.taintSource, '');
  assert.deepEqual(old.impact, []);
  assert.equal(parseRow(['x']), undefined);
  assert.equal(parseRow(null), undefined);
  assert.equal(parseRow(row(0)), undefined);
});

test('productName and severityRank', () => {
  assert.equal(productName('python'), 'es-python');
  assert.equal(productName('browser'), 'es-chromium');
  assert.equal(productName('go'), 'es-go');
  assert.ok(severityRank('critical') < severityRank('info'));
  assert.equal(severityRank('nonsense'), 5);
});
