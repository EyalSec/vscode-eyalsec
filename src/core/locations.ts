// Turning the file:line references in an event into places in the workspace.
// Nothing here touches the disk; the extension decides which candidates exist.

export interface CodeLocation {
  /** The path exactly as the monitored machine reported it. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column, when the frame has one. */
  column?: number;
  /** The function the frame was in, when known. */
  func?: string;
}

/**
 * Reads the "path:line" header that opens an event's source_code or sink_code
 * listing, e.g. "/srv/app/handler.py:12\n  11 ...".
 */
export function parseCodeHeader(code: string | undefined): CodeLocation | undefined {
  if (!code) {
    return undefined;
  }
  const first = code.split(/\r?\n/, 1)[0].trim();
  const m = /^(.+?):(\d+)$/.exec(first);
  if (!m) {
    return undefined;
  }
  const line = Number(m[2]);
  return line > 0 ? { path: m[1], line } : undefined;
}

const PY_FRAME = /^\s*File "(.+?)", line (\d+)(?:, in (.+?))?\s*$/;
const JAVA_FRAME = /^\s*at ([\w$.<>/]+?)\.([\w$<>]+)\(([\w$.-]+\.\w+):(\d+)\)\s*$/;
const JS_FRAME = /^\s*at (?:(.+?) \()?((?:[a-z][\w+.-]*:\/\/)?[^\s()]+?):(\d+)(?::(\d+))?\)?\s*$/i;
const GENERIC = /((?:[A-Za-z]:)?[\w.~@+\-/\\]*[\w-]\.[A-Za-z]\w{0,9}):(\d+)(?::(\d+))?/;

/**
 * Pulls the frames out of a stack trace, outermost first, as the trace lists
 * them. Understands Python tracebacks, JavaScript and Java "at ..." lines, and
 * any other "file.ext:line" reference (Go, Rust, C and C++ traces).
 */
export function parseTrace(trace: string | undefined, max = 200): CodeLocation[] {
  if (!trace) {
    return [];
  }
  const out: CodeLocation[] = [];
  for (const raw of trace.split(/\r?\n/)) {
    if (out.length >= max) {
      break;
    }
    const line = raw.replace(/\t/g, ' ');
    let m = PY_FRAME.exec(line);
    if (m) {
      out.push({ path: m[1], line: Number(m[2]), func: m[3] });
      continue;
    }
    m = JAVA_FRAME.exec(line);
    if (m) {
      const cls = m[1];
      const pkg = cls.includes('.') ? cls.slice(0, cls.lastIndexOf('.')).replace(/\./g, '/') + '/' : '';
      out.push({ path: pkg + m[3], line: Number(m[4]), func: `${cls}.${m[2]}` });
      continue;
    }
    m = JS_FRAME.exec(line);
    if (m && /\.\w+$/.test(m[2].replace(/[?#].*$/, ''))) {
      const loc: CodeLocation = { path: stripFileUrl(m[2]), line: Number(m[3]) };
      if (m[4]) {
        loc.column = Number(m[4]);
      }
      if (m[1]) {
        loc.func = m[1];
      }
      out.push(loc);
      continue;
    }
    if (/^\s*(Traceback|\w*Error\b|\w*Exception\b)/.test(line)) {
      continue;
    }
    m = GENERIC.exec(line);
    if (m && (m[1].includes('/') || m[1].includes('\\') || /\.\w{1,5}$/.test(m[1]))) {
      const loc: CodeLocation = { path: m[1], line: Number(m[2]) };
      if (m[3]) {
        loc.column = Number(m[3]);
      }
      out.push(loc);
    }
  }
  return out.filter((f) => f.line > 0);
}

function stripFileUrl(p: string): string {
  if (p.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(p).pathname);
    } catch {
      return p.slice('file://'.length);
    }
  }
  return p;
}

/** True when a path cannot be a file on disk (an http URL, an internal frame). */
export function isNonFilePath(p: string): boolean {
  return /^[a-z][\w+.-]*:\/\//i.test(p) || p.startsWith('<') || p.startsWith('node:');
}

/** Splits a path into its components, accepting / and \ separators. */
export function pathComponents(p: string): string[] {
  return p
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\//, '/')
    .split('/')
    .filter((c) => c !== '' && c !== '.');
}

/**
 * The relative endings of a remote path to look for in the workspace, longest
 * first: /srv/app/pkg/mod.py -> srv/app/pkg/mod.py, app/pkg/mod.py, pkg/mod.py,
 * mod.py. The longest ending that exists wins, so a file is only matched by its
 * bare name when nothing more specific exists.
 */
export function candidateSuffixes(remotePath: string, maxDepth = 12): string[] {
  const parts = pathComponents(remotePath);
  if (parts.some((c) => c === '..')) {
    return [];
  }
  const start = Math.max(0, parts.length - maxDepth);
  const out: string[] = [];
  for (let i = start; i < parts.length; i++) {
    out.push(parts.slice(i).join('/'));
  }
  return out;
}

/**
 * Applies the user's eyalsec.pathMappings: the longest remote prefix that
 * matches is replaced by its local folder. Returns undefined when none applies.
 */
export function applyPathMappings(remotePath: string, mappings: Record<string, string>): string | undefined {
  const norm = remotePath.replace(/\\/g, '/');
  let best: [string, string] | undefined;
  for (const [prefixRaw, local] of Object.entries(mappings)) {
    if (typeof local !== 'string' || !prefixRaw) {
      continue;
    }
    const prefix = prefixRaw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === prefix || norm.startsWith(prefix + '/')) {
      if (!best || prefix.length > best[0].length) {
        best = [prefix, local];
      }
    }
  }
  if (!best) {
    return undefined;
  }
  const rest = norm.slice(best[0].length).replace(/^\/+/, '');
  if (pathComponents(rest).includes('..')) {
    return undefined;
  }
  const base = best[1].replace(/[\\/]+$/, '');
  return rest ? `${base}/${rest}` : base;
}

/** The file name part of a path, for labels. */
export function baseName(p: string): string {
  const parts = pathComponents(p);
  return parts.length ? parts[parts.length - 1] : p;
}
