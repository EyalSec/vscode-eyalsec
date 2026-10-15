import * as vscode from 'vscode';
import { ApiError, EventDetail, EventQuery, EyalSecClient } from './core/api';
import { baseName, CodeLocation } from './core/locations';
import { buildDetailNodes, DetailNode } from './core/model';
import { loadBatch } from './core/pager';
import { EventRow, productName, severityRank } from './core/rows';
import { LocationResolver } from './resolver';

export type Node =
  | { type: 'product'; kind: string }
  | { type: 'event'; row: EventRow }
  | { type: 'detail'; eventId: number; path: string; node: DetailNode; uri?: vscode.Uri }
  | { type: 'more'; kind: string }
  | { type: 'message'; id: string; text: string; tooltip?: string; command?: vscode.Command; icon?: string };

interface ProductState {
  events: EventRow[];
  cursor: string;
  loaded: boolean;
  hiddenBy?: { id: number; label: string };
  pending?: Promise<void>;
  error?: string;
}

/** The agent kinds in the order the dashboard lists them; others follow by name. */
const PRODUCT_ORDER = ['python', 'browser', 'go', 'c', 'cpp', 'rust', 'node', 'solidity', 'java', 'bash', 'ruby', 'php'];

export interface ClientSource {
  client(): Promise<EyalSecClient | undefined>;
  /** Why no client can be made, when the reason is not simply a missing key. */
  problem(): string | undefined;
}

export class EventsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private products = new Map<string, ProductState>();
  private productNodes = new Map<string, Node>();
  private details = new Map<number, Promise<EventDetail>>();
  private generation = 0;

  constructor(
    private readonly source: ClientSource,
    readonly resolver: LocationResolver,
  ) {}

  refresh(): void {
    this.generation++;
    this.products.clear();
    this.productNodes.clear();
    this.details.clear();
    this.resolver.clear();
    this.changed.fire(undefined);
  }

  async loadMore(kind: string): Promise<void> {
    const state = this.products.get(kind);
    const node = this.productNodes.get(kind);
    if (!state || !state.cursor || !node) {
      return;
    }
    await this.fill(kind, state);
    this.changed.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'product':
        return this.productItem(node.kind);
      case 'event':
        return eventItem(node.row);
      case 'detail':
        return detailItem(node);
      case 'more': {
        const item = new vscode.TreeItem('Load more events', vscode.TreeItemCollapsibleState.None);
        item.id = `more:${node.kind}`;
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.tooltip = 'Fetch the next batch. A search can find older matches further back.';
        item.command = { command: 'eyalsec.loadMore', title: 'Load more', arguments: [node.kind] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = `msg:${node.id}`;
        item.tooltip = node.tooltip ?? node.text;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
        item.command = node.command;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.roots();
    }
    switch (node.type) {
      case 'product':
        return this.productChildren(node.kind);
      case 'event':
        return this.eventChildren(node.row);
      case 'detail':
        return this.resolveAll(node.eventId, node.path, node.node.children ?? []);
      default:
        return [];
    }
  }

  private async roots(): Promise<Node[]> {
    const problem = this.source.problem();
    if (problem) {
      return [
        {
          type: 'message',
          id: 'problem',
          text: problem,
          icon: 'error',
          command: { command: 'workbench.action.openSettings', title: 'Open settings', arguments: ['eyalsec.url'] },
        },
      ];
    }
    const client = await this.source.client();
    if (!client) {
      return [];
    }
    let counts: Record<string, number>;
    try {
      counts = await client.viewCounts(this.config().bucket);
    } catch (err) {
      return [errorNode('roots', err)];
    }
    const kinds = Object.keys(counts).sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));
    if (!kinds.length) {
      return [
        {
          type: 'message',
          id: 'no-products',
          text: 'No product is enabled on this account yet.',
          tooltip: 'Write to sales@eyalsec.com to add one.',
        },
      ];
    }
    return kinds.map((kind) => {
      const n: Node = { type: 'product', kind };
      this.productNodes.set(kind, n);
      return n;
    });
  }

  private productItem(kind: string): vscode.TreeItem {
    const item = new vscode.TreeItem(
      productName(kind),
      this.productNodes.size === 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `product:${kind}`;
    item.contextValue = 'product';
    item.iconPath = new vscode.ThemeIcon('shield');
    const state = this.products.get(kind);
    if (state?.loaded && !state.error) {
      item.description = `${state.events.length}${state.cursor ? '+' : ''} event${state.events.length === 1 ? '' : 's'}`;
    }
    return item;
  }

  private async productChildren(kind: string): Promise<Node[]> {
    let state = this.products.get(kind);
    if (!state) {
      state = { events: [], cursor: '', loaded: false };
      this.products.set(kind, state);
    }
    if (!state.loaded) {
      await this.fill(kind, state);
      const node = this.productNodes.get(kind);
      if (node) {
        // Update the product's description now that its count is known.
        setTimeout(() => this.changed.fire(node), 0);
      }
    }
    const out: Node[] = [];
    if (state.error) {
      out.push({ type: 'message', id: `err:${kind}`, text: state.error, icon: 'error' });
    }
    if (state.hiddenBy) {
      out.push({
        type: 'message',
        id: `hidden:${kind}`,
        text: `Hidden by your rule "${state.hiddenBy.label}"`,
        tooltip: 'One of your enabled Hide rules matches every event in this list. Turn it off or narrow it on the Filters page to see events again.',
        icon: 'eye-closed',
      });
    }
    for (const row of state.events) {
      out.push({ type: 'event', row });
    }
    if (state.cursor) {
      out.push({ type: 'more', kind });
    } else if (state.loaded && !state.events.length && !state.error && !state.hiddenBy) {
      out.push({ type: 'message', id: `empty:${kind}`, text: 'No events match these settings.', icon: 'pass' });
    }
    return out;
  }

  private fill(kind: string, state: ProductState): Promise<void> {
    if (state.pending) {
      return state.pending;
    }
    const gen = this.generation;
    state.pending = (async () => {
      try {
        const client = await this.source.client();
        if (!client) {
          return;
        }
        const cfg = this.config();
        const query: EventQuery = { view: kind, sort: cfg.sort, bucket: cfg.bucket };
        if (cfg.severity.length) {
          query.severity = cfg.severity;
        }
        const batch = await vscode.window.withProgress(
          { location: { viewId: 'eyalsec.events' } },
          () => loadBatch(client, query, state.cursor, cfg.pageSize),
        );
        if (gen !== this.generation) {
          return;
        }
        state.events.push(...batch.events);
        state.cursor = batch.cursor;
        state.hiddenBy = batch.hiddenBy;
        state.error = undefined;
      } catch (err) {
        state.error = errorText(err);
      } finally {
        state.loaded = true;
        state.pending = undefined;
      }
    })();
    return state.pending;
  }

  private async eventChildren(row: EventRow): Promise<Node[]> {
    let pending = this.details.get(row.id);
    if (!pending) {
      const client = await this.source.client();
      if (!client) {
        return [];
      }
      pending = client.event(row.id);
      this.details.set(row.id, pending);
      pending.catch(() => this.details.delete(row.id));
    }
    let detail: EventDetail;
    try {
      detail = await pending;
    } catch (err) {
      return [errorNode(`detail:${row.id}`, err)];
    }
    return this.resolveAll(row.id, 'd', buildDetailNodes(row, detail));
  }

  private async resolveAll(eventId: number, parentPath: string, nodes: DetailNode[]): Promise<Node[]> {
    return Promise.all(
      nodes.map(async (node, i) => {
        const uri = node.location ? await this.resolver.resolve(node.location.path) : undefined;
        return { type: 'detail' as const, eventId, path: `${parentPath}.${i}`, node, uri };
      }),
    );
  }

  private config() {
    const c = vscode.workspace.getConfiguration('eyalsec');
    const sort = c.get<string>('sort') === 'newest' ? 'newest' : 'severity';
    const bucketRaw = c.get<string>('bucket');
    const bucket = bucketRaw === 'suppressed' || bucketRaw === 'all' ? bucketRaw : 'live';
    const severity = (c.get<string[]>('severity') ?? []).filter((s) => severityRank(s) < 5);
    const pageSize = Math.min(500, Math.max(10, c.get<number>('pageSize') ?? 100));
    return { sort, bucket, severity, pageSize } as const;
  }
}

function orderOf(kind: string): number {
  const i = PRODUCT_ORDER.indexOf(kind);
  return i < 0 ? PRODUCT_ORDER.length : i;
}

const SEVERITY_ICONS: Record<string, [string, string]> = {
  critical: ['error', 'errorForeground'],
  high: ['warning', 'list.warningForeground'],
  medium: ['warning', 'editorWarning.foreground'],
  low: ['info', 'editorInfo.foreground'],
  info: ['circle-small', 'descriptionForeground'],
};

function eventItem(row: EventRow): vscode.TreeItem {
  const item = new vscode.TreeItem(row.where || '(unnamed sink)', vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `event:${row.id}`;
  const parts = [row.severity || 'unrated', row.machine];
  if (row.count > 1) {
    parts.push(`${row.count}×`);
  }
  if (row.suppressed) {
    parts.push('suppressed');
  }
  item.description = parts.filter(Boolean).join(' · ');
  const [icon, color] = SEVERITY_ICONS[row.severity] ?? ['circle-outline', 'descriptionForeground'];
  item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
  item.contextValue = 'event copyable';
  const lines = [
    `${row.where} (${row.severity || 'unrated'})`,
    `Value: ${row.value}`,
    `Machine: ${row.machine}`,
    `Product: ${productName(row.product)}`,
    `First seen: ${row.createdAt}`,
    `Count: ${row.count}`,
  ];
  if (row.impact.length) {
    lines.push(`Impact: ${row.impact.map((t) => t.label).join(', ')}`);
  }
  if (row.sanitizeReason) {
    lines.push('', row.sanitizeReason);
  }
  item.tooltip = lines.join('\n');
  return item;
}

const DETAIL_ICONS: Record<string, string> = {
  source: 'debug-start',
  sink: 'debug-breakpoint-function',
  value: 'symbol-string',
  created: 'symbol-string',
  impact: 'flame',
  context: 'file',
  trace: 'list-tree',
  frame: 'debug-stackframe',
  command: 'terminal',
  extension: 'extensions',
};

function detailItem(node: Extract<Node, { type: 'detail' }>): vscode.TreeItem {
  const d = node.node;
  const item = new vscode.TreeItem(
    d.label,
    d.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  );
  item.id = `event:${node.eventId}:${node.path}`;
  item.iconPath = new vscode.ThemeIcon(DETAIL_ICONS[d.kind] ?? 'circle-small');
  let description = d.description;
  if (d.location) {
    const where = `${baseName(d.location.path)}:${d.location.line}`;
    description = description ? `${description}  ${where}` : where;
    if (!node.uri) {
      description += ' (not in this workspace)';
    }
    item.command = {
      command: 'eyalsec.openLocation',
      title: 'Go to line',
      arguments: [node.uri, d.location],
    };
    const tip = [`${d.location.path}:${d.location.line}`, d.tooltip ?? ''].filter(Boolean).join('\n\n');
    item.tooltip = tip;
    if (node.uri) {
      item.resourceUri = node.uri;
    }
  } else {
    item.tooltip = d.tooltip ?? d.description;
  }
  item.description = description;
  item.contextValue = d.copy ? 'detail copyable' : 'detail';
  return item;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function errorNode(id: string, err: unknown): Node {
  const unauthorized = err instanceof ApiError && err.status === 401;
  return {
    type: 'message',
    id: `error:${id}`,
    text: errorText(err),
    icon: unauthorized ? 'key' : 'error',
    command: unauthorized ? { command: 'eyalsec.setApiKey', title: 'Set API key' } : undefined,
  };
}

/** Text for the Copy command, for any node that carries some. */
export function copyTextOf(node: Node | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === 'event') {
    return node.row.value;
  }
  if (node.type === 'detail') {
    return node.node.copy ?? (node.node.location ? `${node.node.location.path}:${node.node.location.line}` : undefined);
  }
  return undefined;
}

export type { CodeLocation };
