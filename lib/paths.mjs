import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function relativeInput(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[:\x00-\x1f]/u.test(value)) throw new Error('请输入素材根内的相对路径。');
  const parts = value.split(/[\\/]/u);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) throw new Error('路径包含空段、保留名或上级跳转。');
  return parts;
}

export function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function rootDir(input, label) {
  if (typeof input !== 'string' || !isAbsolute(input)) throw new Error(`请在蜾蠃设置中指定${label}的绝对路径。`);
  const path = await realpath(resolve(input));
  if (!(await lstat(path)).isDirectory()) throw new Error(`${label}不是目录。`);
  return path;
}

export async function localPath(root, parts) {
  let path = root;
  let stat;
  for (const part of parts) {
    path = resolve(path, part);
    if (!within(root, path)) throw new Error('路径越过配置的目录。');
    stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('跳过符号链接或目录联接。');
  }
  if (!within(root, await realpath(path))) throw new Error('路径越过配置的目录。');
  return { path, stat };
}

export async function readBounded(path, maxBytes, signal) {
  signal?.throwIfAborted();
  const fd = await open(path, 'r');
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`跳过大于 ${maxBytes} 字节的文件或非普通文件。`);
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await fd.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size) throw new Error('读取时文件长度改变，请重新运行。');
    return bytes.subarray(0, count);
  } finally { await fd.close(); }
}
