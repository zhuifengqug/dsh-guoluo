// Stand-in for the REA CLI, used by tests only. Emits the same newline-delimited
// progress stream and summary view shape as `rea analyze-javascript-application`.
import { createHash } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('9.9.9');
  process.exit(0);
}
const at = name => args.indexOf(name);
const target = args[at('analyze-javascript-application') + 1];
const output = args[at('--evidence_output') + 1];
if (!target || !output) {
  console.error('fake-rea: 需要 analyze-javascript-application 与 --evidence_output');
  process.exit(2);
}

async function walk(dir, prefix = '') {
  const rows = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...await walk(join(dir, entry.name), rel));
    else if (entry.isFile()) rows.push(`${rel}:${(await stat(join(dir, entry.name))).size}`);
  }
  return rows;
}

const root = createHash('sha256').update((await walk(target)).sort().join('\n')).digest('hex');
const parentId = `ev_${createHash('sha256').update(`parent:${root}`).digest('hex')}`;
const viewId = `ev_${createHash('sha256').update(`view:${root}`).digest('hex')}`;
const statistics = { relevant_files: 2, text_bytes_read: 128, parsed_javascript_files: 1, skipped_javascript_files: 0, parse_failures: 0 };
const text = JSON.stringify({
  artifacts: [],
  records: [{
    operation: 'analyze_javascript_application',
    evidence_id: parentId,
    subject: { local_path: target, digest: { sha256: root } },
    normalized_result: { root_artifact_sha256: root, statistics },
  }],
});
await writeFile(output, text, 'utf8');
console.log(JSON.stringify({ rea_progress: { phase: 'analyze_javascript_application', completed: 1, total: 1, terminal: true } }));
console.log(JSON.stringify({
  summary: {
    evidence_id: viewId,
    normalized_result: {
      parent_evidence_id: parentId,
      artifact: { sha256: root },
      summary: { root_artifact_sha256: root, statistics },
    },
  },
  evidence_bundle: { path: output, bytes: Buffer.byteLength(text, 'utf8') },
}));
