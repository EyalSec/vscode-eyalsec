// A small client for the documented EyalSec API (https://eyalsec.com/docs/api).
// It only ever reads: every call here is marked "read only" in the API reference,
// so a read-only key is enough.

export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The body of POST /api/get_all_events_with_count/. Every field is optional. */
export interface EventQuery {
  cursor?: string;
  sort?: 'newest' | 'severity';
  view?: string;
  bucket?: 'live' | 'suppressed' | 'all';
  severity?: string[];
  [extra: string]: unknown;
}

export interface EventPage {
  events: unknown[][];
  next_cursor: string;
  exhausted?: boolean;
  scanned?: number;
  oldest_examined?: string;
  event_limit?: number;
  event_limit_monthly?: boolean;
  hidden_by?: { id: number; label: string };
}

export interface EventRun {
  run_uid?: string;
  cmdline?: string;
  env?: string;
  count?: number;
  first_seen?: string;
  last_seen?: string;
}

export interface EventDetail {
  trace?: string;
  origin?: string;
  repr_created?: string;
  source_code?: string;
  sink_code?: string;
  detail?: string;
  comment?: string;
  rule_source?: string;
  extension?: { id?: string; name?: string; version?: string; label?: string };
  runs?: EventRun[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validates and normalizes an EyalSec address. The API key travels in a header,
 * so plain http is refused except to this machine.
 */
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a valid address. Use something like https://eyalsec.com`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))) {
    throw new Error(`The EyalSec address must start with https:// (got ${u.protocol}//${u.host}).`);
  }
  if (u.username || u.password) {
    throw new Error('The EyalSec address must not contain a user name or password.');
  }
  return u.origin;
}

export class EyalSecClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!apiKey) {
      throw new Error('No API key.');
    }
  }

  /** GET /api/event_view_counts/: one entry per product on the account. */
  viewCounts(bucket?: string): Promise<Record<string, number>> {
    const q = bucket ? `?bucket=${encodeURIComponent(bucket)}` : '';
    return this.request<Record<string, number>>('GET', `/api/event_view_counts/${q}`);
  }

  /** POST /api/get_all_events_with_count/: one page of events. */
  events(query: EventQuery): Promise<EventPage> {
    return this.request<EventPage>('POST', '/api/get_all_events_with_count/', query);
  }

  /** GET /api/event/{id}: the large fields the list leaves out. */
  event(id: number): Promise<EventDetail> {
    if (!Number.isSafeInteger(id) || id < 0) {
      return Promise.reject(new ApiError(400, `Not an event id: ${id}`));
    }
    return this.request<EventDetail>('GET', `/api/event/${id}`);
  }

  /** GET /api/account/: who the key belongs to. Used to check a new key. */
  account(): Promise<{ username?: string }> {
    return this.request<{ username?: string }>('GET', '/api/account/');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      Accept: 'application/json',
      'User-Agent': 'vscode-eyalsec',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: payload, signal: controller.signal });
    } catch (err) {
      const reason = controller.signal.aborted ? 'the request timed out' : String((err as Error)?.message ?? err);
      throw new ApiError(0, `Could not reach ${this.baseUrl}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status === 302 || res.status === 303) {
      // The server redirects an unauthenticated browser to the sign-in page.
      throw new ApiError(401, 'The API key was not accepted.');
    }
    if (res.status < 200 || res.status >= 300) {
      const retry = Number(res.headers.get('Retry-After'));
      throw new ApiError(res.status, describeError(res.status, text), Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, `${this.baseUrl} answered with something that is not JSON. Check the EyalSec address setting.`);
    }
  }
}

function describeError(status: number, body: string): string {
  let msg = '';
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed?.error === 'string') {
      msg = parsed.error;
    }
  } catch {
    // Some endpoints answer in plain text; HTML is never shown.
    if (body && !body.trimStart().startsWith('<')) {
      msg = body.trim().slice(0, 200);
    }
  }
  switch (status) {
    case 401:
      return 'The API key was not accepted (it may be wrong, revoked or expired). Set a new one.';
    case 403:
      return msg ? `Not allowed: ${msg}` : 'Not allowed for this account.';
    case 404:
      return 'Not found.';
    case 429:
      return 'Rate limit reached. Try again in a moment.';
    default:
      return msg ? `${status}: ${msg}` : `The server answered ${status}.`;
  }
}
