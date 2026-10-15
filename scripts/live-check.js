#!/usr/bin/env node
// One read-only pass against a real EyalSec account, through the same client
// and parsing code the extension uses. It prints what the tree would show and
// which file:line references resolve under a local folder.
//
//   EYALSEC_API_KEY=es2_... [EYALSEC_URL=https://eyalsec.com] node scripts/live-check.js [folder]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EyalSecClient } = require('../out/core/api');
const { loadBatch } = require('../out/core/pager');
const { buildDetailNodes } = require('../out/core/model');
const { candidateSuffixes } = require('../out/core/locations');
const { productName } = require('../out/core/rows');

function resolve(folder, remote) {
  if (path.isAbsolute(remote) && fs.existsSync(remote)) return remote;
  for (const s of candidateSuffixes(remote)) {
    const p = path.join(folder, s);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return undefined;
}

async function main() {
  const key = process.env.EYALSEC_API_KEY;
  if (!key) {
    console.error('Set EYALSEC_API_KEY.');
    process.exit(2);
  }
  const folder = path.resolve(process.argv[2] || '.');
  const client = new EyalSecClient(process.env.EYALSEC_URL || 'https://eyalsec.com', key);
  const account = await client.account();
  console.log(`account: ${account.username} at ${client.baseUrl}`);
  const counts = await client.viewCounts('live');
  let resolved = 0;
  let seen = 0;
  for (const kind of Object.keys(counts)) {
    const batch = await loadBatch(client, { view: kind, sort: 'severity', bucket: 'live' }, '', 20);
    console.log(`\n${productName(kind)}: ${batch.events.length} event(s) loaded${batch.cursor ? ', more available' : ''}`);
    for (const row of batch.events.slice(0, 10)) {
      const detail = await client.event(row.id);
      console.log(`  [${row.severity}] ${row.where}  (${row.machine}, id ${row.id})`);
      for (const n of buildDetailNodes(row, detail)) {
        const locs = n.location ? [n.location] : (n.children || []).map((c) => c.location).filter(Boolean);
        for (const loc of locs) {
          seen++;
          const hit = resolve(folder, loc.path);
          if (hit) resolved++;
          console.log(`    ${n.label.padEnd(10)} ${loc.path}:${loc.line} -> ${hit ? path.relative(folder, hit) + ':' + loc.line : 'not in folder'}`);
        }
        if (!n.location && !n.children) console.log(`    ${n.label.padEnd(10)} ${n.description}`);
      }
    }
  }
  console.log(`\n${resolved} of ${seen} file:line references resolved under ${folder}`);
}

main().catch((err) => {
  console.error(`live check failed: ${err.message}`);
  process.exit(1);
});
