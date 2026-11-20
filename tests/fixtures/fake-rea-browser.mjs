// Stand-in REA for default runs: analyze plus the three browser verbs, backed by
// whatever fake CDP state server the injected launch recorded at <endpoint>/__state.
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
const evidenceId = seed => 'ev_' + createHash('sha256').update(seed).digest('hex');

if (argv.includes('--version')) { console.log('9.9.9'); process.exit(0); }

// Minimal self-consistent PNG: signature + IHDR + IEND, width/height readable from bytes 16/20.
function png(width, height, seed) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6;
  const tail = Buffer.alloc(12);
  tail.write('IEND', 4, 'ascii');
  const content = Buffer.from(createHash('sha256').update(`${seed}:${width}x${height}`).digest('hex'));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr, content, tail]);
}

async function state(endpoint) {
  const response = await fetch(`${endpoint}/__state`);
  if (!response.ok) throw new Error(`fake browser 无状态：${response.status}`);
  return response.json();
}

async function analyze() {
  const target = argv[argv.indexOf('analyze-javascript-application') + 1];
  const output = option('--evidence_output');
  const walk = async (dir, base = '') => {
    const rows = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) rows.push(...await walk(join(dir, entry.name), rel));
      else rows.push(`${rel}:${(await stat(join(dir, entry.name))).size}`);
    }
    return rows.sort();
  };
  const root = createHash('sha256').update((await walk(target)).join('\n')).digest('hex');
  const statistics = { relevant_files: 2, text_bytes_read: 64, parsed_javascript_files: 0, skipped_javascript_files: 0, parse_failures: 0 };
  const parentId = evidenceId('parent:' + root);
  const text = JSON.stringify({ records: [{ operation: 'analyze_javascript_application', evidence_id: parentId, subject: { local_path: target, digest: { sha256: root } }, normalized_result: { root_artifact_sha256: root, statistics } }] });
  await writeFile(output, text);
  console.log(JSON.stringify({ rea_progress: { terminal: true } }));
  console.log(JSON.stringify({ summary: { evidence_id: evidenceId('view:' + root), normalized_result: { parent_evidence_id: parentId, artifact: { sha256: root }, summary: { root_artifact_sha256: root, statistics } } }, evidence_bundle: { path: output, bytes: Buffer.byteLength(text, 'utf8') } }));
}

if (argv.includes('analyze-javascript-application')) { await analyze(); process.exit(0); }

const verb = argv[0];
const endpoint = argv[1];
const normalized = verb === 'compare-web-screenshots' ? null : await state(endpoint);

if (verb === 'list-browser-targets') {
  console.log(JSON.stringify({ evidence_id: evidenceId(`list:${normalized.url}`), operation: 'list_browser_targets',
    normalized_result: { browser: 'fake', targets: [{ target_id: normalized.targetId, type: 'page', title: '', url: normalized.url, origin: normalized.origin, attached: true }],
      excluded: { disallowed_origin: 0, unsupported_url: 0, non_page: 0 }, limitations: [] } }));
} else if (verb === 'capture-web-screenshot') {
  const target = argv[2];
  if (target !== normalized.targetId) throw new Error('目标 id 与状态不符。');
  const bytes = png(normalized.width, normalized.height, normalized.url);
  console.log(JSON.stringify({ evidence_id: evidenceId(`shot:${normalized.url}:${normalized.width}`), operation: 'capture_web_screenshot',
    normalized_result: { browser: 'fake', target: { target_id: target, url: normalized.url, origin: normalized.origin }, captured_at: new Date(0).toISOString(),
      viewport: { width: normalized.width, height: normalized.height },
      artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, media_type: 'image/png', data_base64: bytes.toString('base64') },
      completeness: { status: 'complete_within_window' }, limitations: [] } }));
} else if (verb === 'compare-web-screenshots') {
  const jsonArgs = argv.slice(1).filter(value => value.endsWith('.json'));
  const before = JSON.parse(await readFile(jsonArgs[0], 'utf8'));
  const after = JSON.parse(await readFile(jsonArgs[1], 'utf8'));
  const threshold = Number(option('--channel-threshold') ?? 0);
  const beforePng = Buffer.from(before.data_base64, 'base64');
  const afterPng = Buffer.from(after.data_base64, 'base64');
  const width = beforePng.readUInt32BE(16);
  const height = beforePng.readUInt32BE(20);
  const pixels = width * height;
  const changed = before.data_base64 === after.data_base64 ? 0 : pixels;
  console.log(JSON.stringify({ evidence_id: evidenceId(`diff:${before.sha256}:${after.sha256}`), operation: 'compare_web_screenshots',
    parameters: { before_artifact_sha256: before.sha256, after_artifact_sha256: after.sha256, channel_threshold: threshold },
    normalized_result: { before: { width, height }, after: { width, height }, channel_threshold: threshold,
      status: changed ? 'different' : 'identical', compared_pixels: pixels, changed_pixels: changed, changed_ratio: changed / pixels,
      maximum_channel_delta: changed ? 255 : 0, mean_absolute_channel_delta: changed ? 255 : 0, limitations: [] } }));
} else {
  throw new Error(`unknown verb ${verb}`);
}
