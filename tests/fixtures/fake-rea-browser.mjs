// Stand-in REA for default runs: analyze plus the three browser verbs, backed by
// whatever fake CDP state server the injected launch recorded at <endpoint>/__state.
// Screenshots are real decodable PNGs (8-bit RGBA, filter 0, uniform color per URL) so
// the plugin's own decoder can recompute the diff independently of this fake.
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
const evidenceId = seed => 'ev_' + createHash('sha256').update(seed).digest('hex');

if (argv.includes('--version')) { console.log('9.9.9'); process.exit(0); }

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, tail]);
}

// Uniform-color RGBA image. The color is a function of the URL, so the two local
// servers differ per pixel when their ports differ; GUOLUO_FAKE_SAME_IMAGE pins the
// color so both sides are byte-identical.
function png({ width, height, seed }) {
  const bitDepth = Number(process.env.GUOLUO_FAKE_PNG_DEPTH ?? 8);
  const same = process.env.GUOLUO_FAKE_SAME_IMAGE === '1';
  const hash = createHash('sha256').update(seed).digest();
  const color = same ? [16, 32, 48, 255] : [hash[0], hash[1], hash[2], 255];
  const sample = bitDepth === 16 ? 2 : 1;
  const channels = 4;
  const row = 1 + width * channels * sample;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    const base = y * row;
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        const at = base + 1 + (x * channels + c) * sample;
        raw[at] = color[c];
        if (sample === 2) raw[at + 1] = color[c] ^ 0x5a;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
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
  const bytes = png({ width: normalized.width, height: normalized.height, seed: normalized.url });
  console.log(JSON.stringify({ evidence_id: evidenceId(`shot:${normalized.url}:${normalized.width}`), operation: 'capture_web_screenshot',
    normalized_result: { browser: 'fake', target: { target_id: target, url: normalized.url, origin: normalized.origin }, captured_at: new Date(0).toISOString(),
      viewport: { width: normalized.width, height: normalized.height },
      artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, media_type: 'image/png', data_base64: bytes.toString('base64') },
      completeness: { status: 'complete_within_window' }, limitations: [] } }));
} else if (verb === 'compare-web-screenshots') {
  const files = argv.slice(1).filter(value => value.endsWith('.json'));
  if (files.length < 2 || files.length % 2 !== 0) throw new Error('compare-web-screenshots 需要成对的 before/after 证据文件。');
  const threshold = Number(option('--channel-threshold') ?? 0);
  const forced = process.env.GUOLUO_FAKE_FORCE_CHANGED === undefined ? null : Number(process.env.GUOLUO_FAKE_FORCE_CHANGED);
  for (let at = 0; at < files.length; at += 2) {
    const before = JSON.parse(await readFile(files[at], 'utf8'));
    const after = JSON.parse(await readFile(files[at + 1], 'utf8'));
    const beforePng = Buffer.from(before.data_base64, 'base64');
    const afterPng = Buffer.from(after.data_base64, 'base64');
    const width = beforePng.readUInt32BE(16);
    const height = beforePng.readUInt32BE(20);
    const pixels = width * height;
    // Uniform-color images differ in every pixel or in none, so all-or-none matches the
    // plugin's per-pixel recompute; GUOLUO_FAKE_FORCE_CHANGED overrides it to provoke a conflict.
    const changed = forced === null ? (before.data_base64 === after.data_base64 ? 0 : pixels) : Math.max(0, Math.min(pixels, forced));
    console.log(JSON.stringify({ evidence_id: evidenceId(`diff:${before.sha256}:${after.sha256}`), operation: 'compare_web_screenshots',
      parameters: { before_artifact_sha256: before.sha256, after_artifact_sha256: after.sha256, channel_threshold: threshold },
      normalized_result: { before: { width, height }, after: { width, height }, channel_threshold: threshold,
        status: changed ? 'different' : 'identical', compared_pixels: pixels, changed_pixels: changed, changed_ratio: changed / pixels,
        maximum_channel_delta: changed ? 255 : 0, mean_absolute_channel_delta: changed ? 255 : 0, limitations: [] } }));
  }
} else {
  throw new Error(`unknown verb ${verb}`);
}