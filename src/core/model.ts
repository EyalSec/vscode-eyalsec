// What the tree shows under one event, built from the list row and the event's
// detail. Kept free of the VS Code API so it can be tested on its own.

import type { EventDetail } from './api';
import { CodeLocation, isNonFilePath, parseCodeHeader, parseTrace } from './locations';
import { EventRow, oneLine } from './rows';

export type DetailKind = 'source' | 'sink' | 'value' | 'created' | 'impact' | 'context' | 'trace' | 'frame' | 'command' | 'extension';

export interface DetailNode {
  kind: DetailKind;
  label: string;
  description: string;
  /** Plain text. Event text is untrusted, so it is never rendered as Markdown. */
  tooltip?: string;
  location?: CodeLocation;
  /** Text the Copy command puts on the clipboard. */
  copy?: string;
  children?: DetailNode[];
}

/** Where the data came in, in the fewest words the event allows. */
export function describeSource(row: EventRow, detail?: EventDetail): string {
  if (row.taintSource) {
    return row.taintSource;
  }
  if (row.sourceLabel) {
    return row.sourceLabel;
  }
  if (detail?.rule_source && detail.rule_source !== 'any') {
    return detail.rule_source;
  }
  if (detail?.origin) {
    return oneLine(detail.origin, 80);
  }
  return 'not recorded';
}

/** The innermost frame of a trace that points at a file, if any. */
export function innermostFileFrame(frames: CodeLocation[]): CodeLocation | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (!isNonFilePath(frames[i].path)) {
      return frames[i];
    }
  }
  return undefined;
}

export function buildDetailNodes(row: EventRow, detail: EventDetail): DetailNode[] {
  const nodes: DetailNode[] = [];
  const frames = parseTrace(detail.trace);

  const srcLoc = parseCodeHeader(detail.source_code);
  const srcTip = [detail.origin ? `Where it came from:\n${detail.origin}` : '', detail.source_code ?? '']
    .filter(Boolean)
    .join('\n\n');
  nodes.push({
    kind: 'source',
    label: 'Source',
    description: describeSource(row, detail),
    tooltip: srcTip || undefined,
    location: srcLoc,
    copy: detail.origin || undefined,
  });

  const sinkLoc = parseCodeHeader(detail.sink_code) ?? innermostFileFrame(frames);
  nodes.push({
    kind: 'sink',
    label: 'Sink',
    description: row.where || 'unnamed',
    tooltip: detail.sink_code || undefined,
    location: sinkLoc,
    copy: row.where,
  });

  if (row.value) {
    nodes.push({
      kind: 'value',
      label: 'Value',
      description: oneLine(row.value),
      tooltip: row.value,
      copy: row.value,
    });
  }
  if (detail.repr_created && detail.repr_created !== row.value) {
    nodes.push({
      kind: 'created',
      label: 'Value when it came in',
      description: oneLine(detail.repr_created),
      tooltip: detail.repr_created,
      copy: detail.repr_created,
    });
  }
  if (row.impact.length) {
    const text = row.impact.map((t) => (t.sev ? `${t.label} (${t.sev})` : t.label)).join(', ');
    nodes.push({
      kind: 'impact',
      label: 'Impact',
      description: text,
      tooltip: row.sanitizeReason ? `${text}\n\n${row.sanitizeReason}` : text,
    });
  }
  const ctx = row.context || detail.detail;
  if (ctx) {
    nodes.push({ kind: 'context', label: 'Detail', description: oneLine(ctx), tooltip: ctx, copy: ctx });
  }
  const ext = detail.extension?.label || row.extension;
  if (ext) {
    nodes.push({ kind: 'extension', label: 'Extension', description: ext, copy: ext });
  }
  const cmd = detail.runs?.find((r) => r.cmdline)?.cmdline;
  if (cmd) {
    const runs = detail.runs?.length ?? 0;
    nodes.push({
      kind: 'command',
      label: runs > 1 ? `Command line (${runs} runs)` : 'Command line',
      description: oneLine(cmd),
      tooltip: cmd,
      copy: cmd,
    });
  }
  if (frames.length) {
    nodes.push({
      kind: 'trace',
      label: 'Call path',
      description: `${frames.length} frame${frames.length === 1 ? '' : 's'}, innermost last`,
      tooltip: detail.trace,
      copy: detail.trace,
      children: frames.map((f) => ({
        kind: 'frame' as const,
        label: f.func ? f.func : f.path,
        description: '',
        location: f,
      })),
    });
  }
  return nodes;
}
