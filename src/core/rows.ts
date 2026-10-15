// Event rows from POST /api/get_all_events_with_count/ are arrays, not objects,
// read by position (see "The event row" in the API reference). New values are only
// added at the end, so unknown trailing values are ignored.

export interface ImpactTag {
  label: string;
  sev: string;
}

export interface EventRow {
  createdAt: string;
  where: string;
  value: string;
  count: number;
  machine: string;
  severity: string;
  product: string;
  id: number;
  sourceLabel: string;
  context: string;
  suppressed: boolean;
  sanitizeReason: string;
  impact: ImpactTag[];
  labels: { id: number; name: string; color: string }[];
  hasComment: boolean;
  extension: string;
  taintSource: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function parseRow(row: unknown): EventRow | undefined {
  if (!Array.isArray(row) || row.length < 8) {
    return undefined;
  }
  const id = num(row[7]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return undefined;
  }
  const impact = Array.isArray(row[12])
    ? (row[12] as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({ label: str(t.label), sev: str(t.sev) }))
    : [];
  const labels = Array.isArray(row[13])
    ? (row[13] as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({ id: num(t.id), name: str(t.name), color: str(t.color) }))
    : [];
  return {
    createdAt: str(row[0]),
    where: str(row[1]),
    value: str(row[2]),
    count: num(row[3]),
    machine: str(row[4]),
    severity: str(row[5]).toLowerCase(),
    product: str(row[6]),
    id,
    sourceLabel: str(row[8]),
    context: str(row[9]),
    suppressed: row[10] === true,
    sanitizeReason: str(row[11]),
    impact,
    labels,
    hasComment: row[14] === true,
    extension: str(row[15]),
    taintSource: str(row[16]),
  };
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export function severityRank(sev: string): number {
  const i = (SEVERITIES as readonly string[]).indexOf(sev);
  return i < 0 ? SEVERITIES.length : i;
}

const PRODUCT_NAMES: Record<string, string> = {
  python: 'es-python',
  browser: 'es-chromium',
};

/** The product name for an agent kind / view value: python -> es-python. */
export function productName(kind: string): string {
  return PRODUCT_NAMES[kind] ?? `es-${kind}`;
}

/** Collapses whitespace and cuts a value to fit on one tree line. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
