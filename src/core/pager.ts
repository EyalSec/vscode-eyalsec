// Follows the events query's cursor the way the API reference asks: a short or
// empty page is not the last page, only an empty next_cursor is.

import type { EventQuery, EyalSecClient } from './api';
import { EventRow, parseRow } from './rows';

export interface Batch {
  events: EventRow[];
  /** Pass back as `cursor` to continue; empty when everything has been read. */
  cursor: string;
  /** Set when one of the account's Hide rules matches every event in the view. */
  hiddenBy?: { id: number; label: string };
}

/**
 * Reads pages until `want` events are collected, the cursor runs out, or
 * `maxRequests` calls have been made (so one click never runs away with the
 * rate limit). The caller offers "load more" while `cursor` is non-empty.
 */
export async function loadBatch(
  client: Pick<EyalSecClient, 'events'>,
  query: EventQuery,
  cursor: string,
  want: number,
  maxRequests = 10,
): Promise<Batch> {
  const events: EventRow[] = [];
  let next = cursor;
  for (let i = 0; i < maxRequests; i++) {
    const body: EventQuery = { ...query };
    if (next) {
      body.cursor = next;
    }
    const page = await client.events(body);
    for (const raw of page.events ?? []) {
      const row = parseRow(raw);
      if (row) {
        events.push(row);
      }
    }
    next = typeof page.next_cursor === 'string' ? page.next_cursor : '';
    if (page.hidden_by) {
      return { events, cursor: '', hiddenBy: page.hidden_by };
    }
    if (!next || events.length >= want) {
      break;
    }
  }
  return { events, cursor: next };
}
