import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  applyPathMappings,
  baseName,
  candidateSuffixes,
  isNonFilePath,
  parseCodeHeader,
  parseTrace,
} from '../../core/locations';

test('parseCodeHeader reads the path:line header of a listing', () => {
  assert.deepEqual(parseCodeHeader("/srv/app/handler.py:12\n  11    q = 1\n> 12    run(q)"), {
    path: '/srv/app/handler.py',
    line: 12,
  });
  assert.deepEqual(parseCodeHeader('C:\\app\\main.py:3\r\n> 3 x'), { path: 'C:\\app\\main.py', line: 3 });
  assert.equal(parseCodeHeader(''), undefined);
  assert.equal(parseCodeHeader(undefined), undefined);
  assert.equal(parseCodeHeader('no header here\n> 1 x'), undefined);
  assert.equal(parseCodeHeader('/a.py:0\n'), undefined);
});

test('parseTrace reads a Python traceback, outermost first', () => {
  const trace = [
    'Traceback (most recent call last):',
    '  File "/srv/app/main.py", line 18, in <module>',
    '    serve()',
    '  File "/srv/app/handler.py", line 12, in ping_host',
    '    os.system("ping " + host)',
  ].join('\n');
  assert.deepEqual(parseTrace(trace), [
    { path: '/srv/app/main.py', line: 18, func: '<module>' },
    { path: '/srv/app/handler.py', line: 12, func: 'ping_host' },
  ]);
});

test('parseTrace reads JavaScript frames and drops non-numeric ones', () => {
  const trace = [
    'Error: boom',
    '    at handler (/srv/web/routes/user.js:40:12)',
    '    at /srv/web/app.js:7:3',
    '    at https://shop.example/static/app.min.js:1:2345',
    '    at node:internal/process/task_queues:95:5',
  ].join('\n');
  const frames = parseTrace(trace);
  assert.deepEqual(frames[0], { path: '/srv/web/routes/user.js', line: 40, column: 12, func: 'handler' });
  assert.deepEqual(frames[1], { path: '/srv/web/app.js', line: 7, column: 3 });
  assert.equal(frames[2].path, 'https://shop.example/static/app.min.js');
  assert.equal(isNonFilePath(frames[2].path), true);
  assert.equal(frames.length, 3, 'node: internals have no file extension and are skipped');
});

test('parseTrace turns a Java frame into a package path', () => {
  const frames = parseTrace('java.lang.RuntimeException\n\tat com.example.web.UserController.find(UserController.java:57)');
  assert.deepEqual(frames, [
    { path: 'com/example/web/UserController.java', line: 57, func: 'com.example.web.UserController.find' },
  ]);
});

test('parseTrace falls back to file.ext:line references (Go, C, Rust)', () => {
  const frames = parseTrace('main.handler(...)\n\t/home/ci/src/app/main.go:42 +0x1d\nsrc/lib.rs:7:9');
  assert.deepEqual(frames, [
    { path: '/home/ci/src/app/main.go', line: 42 },
    { path: 'src/lib.rs', line: 7, column: 9 },
  ]);
});

test('parseTrace handles empty and hostile input without throwing', () => {
  assert.deepEqual(parseTrace(''), []);
  assert.deepEqual(parseTrace(undefined), []);
  const long = 'x'.repeat(100000) + ':1';
  assert.ok(Array.isArray(parseTrace(long)));
  const many = Array.from({ length: 1000 }, (_, i) => `  File "/a/b${i}.py", line ${i + 1}, in f`).join('\n');
  assert.equal(parseTrace(many).length, 200);
});

test('candidateSuffixes lists endings longest first and refuses ..', () => {
  assert.deepEqual(candidateSuffixes('/srv/app/pkg/mod.py'), ['srv/app/pkg/mod.py', 'app/pkg/mod.py', 'pkg/mod.py', 'mod.py']);
  assert.deepEqual(candidateSuffixes('C:\\work\\app\\main.py'), ['work/app/main.py', 'app/main.py', 'main.py']);
  assert.deepEqual(candidateSuffixes('/srv/../etc/passwd'), []);
  const deep = '/' + Array.from({ length: 20 }, (_, i) => `d${i}`).join('/') + '/f.py';
  assert.equal(candidateSuffixes(deep).length, 12);
});

test('applyPathMappings uses the longest matching prefix', () => {
  const m = { '/srv': '/home/me/srv', '/srv/app': '/home/me/code/app/' };
  assert.equal(applyPathMappings('/srv/app/x/y.py', m), '/home/me/code/app/x/y.py');
  assert.equal(applyPathMappings('/srv/other.py', m), '/home/me/srv/other.py');
  assert.equal(applyPathMappings('/srvapp/z.py', m), undefined, 'a prefix matches whole components only');
  assert.equal(applyPathMappings('/opt/z.py', m), undefined);
  assert.equal(applyPathMappings('/srv/app/../../etc/passwd', m), undefined);
});

test('baseName', () => {
  assert.equal(baseName('/a/b/c.py'), 'c.py');
  assert.equal(baseName('C:\\a\\b.js'), 'b.js');
});
