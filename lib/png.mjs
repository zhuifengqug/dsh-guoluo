// 独立 PNG 解码与逐通道差异复算：只吃 8 位非隔行 RGB/RGBA，其它一律明确拒绝。
// 不依赖 REA，也不相信 REA 报出的数字——用它交叉验证 compare-web-screenshots。
import { inflateSync } from 'node:zlib';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxDimension = 16384;
const maxDecodedBytes = 64 * 1024 * 1024;
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function unsupported(message) {
  return Object.assign(new Error(message), { code: 'unsupported-png' });
}

function readChunks(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) throw new Error('PNG 签名不符。');
  const chunks = [];
  let offset = 8;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG 数据块被截断。');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error('PNG 数据块长度越界。');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error('PNG 数据块类型不合法。');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw new Error(`PNG ${type} 数据块 CRC 校验失败。`);
    }
    if (/^[A-Z]/u.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) throw unsupported(`PNG 关键块 ${type} 不受支持。`);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) throw new Error('PNG 的 IEND 必须为空且位于文件末尾。');
      ended = true;
      break;
    }
    if (type === 'IHDR' && chunks.length > 1) throw new Error('PNG 的 IHDR 必须是第一个数据块。');
  }
  if (!ended) throw new Error('PNG 缺少 IEND 数据块。');
  return chunks;
}

const paeth = (left, up, upLeft) => {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
};

function unfilter(raw, { width, height, channels }) {
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prior = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= channels ? prior[x - channels] : 0;
      let value;
      switch (filterType) {
        case 0: value = source[x]; break;
        case 1: value = source[x] + left; break;
        case 2: value = source[x] + up; break;
        case 3: value = source[x] + ((left + up) >> 1); break;
        case 4: value = source[x] + paeth(left, up, upLeft); break;
        default: throw unsupported(`PNG 第 ${y} 行滤波类型 ${filterType} 不受支持。`);
      }
      row[x] = value & 0xff;
    }
  }
  return out;
}

// 解出 { width, height, channels, colorType, pixels }；pixels 为逐行去滤波后的原始样点。
export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('PNG 输入须为字节缓冲。');
  const chunks = readChunks(bytes);
  const header = chunks[0];
  if (header?.type !== 'IHDR' || header.data.length !== 13) throw new Error('PNG 以非法的 IHDR 开头。');
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const depth = header.data[8];
  const colorType = header.data[9];
  const compression = header.data[10];
  const filterMethod = header.data[11];
  const interlace = header.data[12];
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) throw unsupported(`PNG 尺寸 ${width}×${height} 不受支持。`);
  if (depth !== 8) throw unsupported(`只接受 8 位 PNG，实际位深 ${depth}。`);
  if (colorType !== 2 && colorType !== 6) throw unsupported(`只接受 RGB 或 RGBA PNG，实际颜色类型 ${colorType}。`);
  if (compression !== 0 || filterMethod !== 0) throw unsupported('PNG 压缩或滤波方法不受支持。');
  if (interlace !== 0) throw unsupported('不接受隔行（Adam7）PNG。');
  const channels = colorType === 6 ? 4 : 3;
  const expected = height * (width * channels + 1);
  if (expected > maxDecodedBytes) throw unsupported(`PNG 解码后 ${expected} 字节超出预算。`);
  const transparencyIndex = chunks.findIndex(chunk => chunk.type === 'tRNS');
  let transparentRgb = null;
  if (transparencyIndex !== -1) {
    const { data } = chunks[transparencyIndex];
    if (colorType !== 2 || data.length !== 6 || transparencyIndex > chunks.findIndex(chunk => chunk.type === 'IDAT') ||
        chunks.slice(transparencyIndex + 1).some(chunk => chunk.type === 'tRNS' || chunk.type === 'PLTE')) {
      throw new Error('PNG 的 tRNS 数据块长度、位置或颜色类型无效。');
    }
    const [r, g, b] = [0, 2, 4].map(offset => data.readUInt16BE(offset));
    if (r > 255 || g > 255 || b > 255) throw new Error('PNG 的 tRNS 透明键超出 8 位样点范围。');
    transparentRgb = (r << 16) | (g << 8) | b;
  }
  const compressed = Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data));
  if (!compressed.length) throw new Error('PNG 缺少 IDAT 数据。');
  let raw;
  try { raw = inflateSync(compressed, { maxOutputLength: expected }); }
  catch (error) { throw new Error(`PNG 解压失败：${error.message}`); }
  if (raw.length !== expected) throw new Error(`PNG 解压得到 ${raw.length} 字节，按 ${width}×${height}×${channels} 应为 ${expected} 字节。`);
  return { width, height, channels, colorType, pixels: unfilter(raw, { width, height, channels }), transparentRgb };
}

function alphaAt({ pixels, channels, transparentRgb }, offset) {
  if (channels === 4) return pixels[offset + 3];
  if (transparentRgb === null) return 255;
  const rgb = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
  return rgb === transparentRgb ? 0 : 255;
}

// 与 before 相比逐通道差值 > 阈值的像素数；RGB 透明键按 alpha=0 展开，其余按 255。
export function comparePng(beforeBytes, afterBytes, { channelThreshold = 0 } = {}) {
  if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) throw new Error('逐通道阈值须为 0–255 的整数。');
  const before = decodePng(beforeBytes);
  const after = decodePng(afterBytes);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`两张 PNG 尺寸不同：${before.width}×${before.height} 与 ${after.width}×${after.height}。`);
  }
  const { width, height } = before;
  const pixels = width * height;
  const samples = pixels * 4;
  const a = before.pixels;
  const b = after.pixels;
  const ac = before.channels;
  const bc = after.channels;
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  let total = 0;
  for (let index = 0; index < pixels; index += 1) {
    const ai = index * ac;
    const bi = index * bc;
    const dr = Math.abs(a[ai] - b[bi]);
    const dg = Math.abs(a[ai + 1] - b[bi + 1]);
    const db = Math.abs(a[ai + 2] - b[bi + 2]);
    const da = Math.abs(alphaAt(before, ai) - alphaAt(after, bi));
    let peak = dr;
    if (dg > peak) peak = dg;
    if (db > peak) peak = db;
    if (da > peak) peak = da;
    total += dr + dg + db + da;
    if (peak > maximumChannelDelta) maximumChannelDelta = peak;
    if (peak > channelThreshold) changedPixels += 1;
  }
  return {
    width, height, changedPixels, changedRatio: changedPixels / pixels,
    maximumChannelDelta, meanAbsoluteChannelDelta: total / samples, channelThreshold,
  };
}