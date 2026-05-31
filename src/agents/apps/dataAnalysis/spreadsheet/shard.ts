/**
 * Sheet sharding — split a sheet's rows into contiguous CSV shards each within
 * `maxShardBytes` (the storage cap, e.g. 5MB). The mirror writes one file per
 * shard; the manifest records each shard's row range for reassembly.
 *
 * A single row that alone exceeds the budget gets its own (oversize) shard
 * rather than looping forever — a row cannot be split across files.
 */

import type { CellValue } from './types';
import { serializeRow, utf8Bytes } from './csv';

export interface RowShard {
  csv: string;
  /** 0-based inclusive first source row. */
  startRow: number;
  /** 0-based exclusive last source row. */
  endRow: number;
  bytes: number;
}

/**
 * Greedily pack rows into shards. An empty sheet yields a single empty shard so
 * the sheet is always represented and reassembly is well-defined.
 */
export function shardSheet(rows: CellValue[][], maxShardBytes: number): RowShard[] {
  if (rows.length === 0) {
    return [{ csv: '', startRow: 0, endRow: 0, bytes: 0 }];
  }

  const budget = Math.max(1, maxShardBytes);
  const shards: RowShard[] = [];

  let lines: string[] = [];
  let bytes = 0;
  let startRow = 0;

  const flush = (endRow: number) => {
    const csv = lines.length > 0 ? lines.join('\n') + '\n' : '';
    shards.push({ csv, startRow, endRow, bytes: utf8Bytes(csv) });
    lines = [];
    bytes = 0;
    startRow = endRow;
  };

  for (let i = 0; i < rows.length; i++) {
    const line = serializeRow(rows[i]);
    const lineBytes = utf8Bytes(line) + 1; // +1 for the LF terminator

    // Close the current shard before adding a row that would overflow it — but
    // never flush an empty buffer (a lone oversize row still goes in its own shard).
    if (lines.length > 0 && bytes + lineBytes > budget) {
      flush(i);
    }

    lines.push(line);
    bytes += lineBytes;
  }

  flush(rows.length);
  return shards;
}
