import { open } from 'node:fs/promises';

const machines = new Map([[0x14c, 'x86'], [0x8664, 'x64'], [0xaa64, 'arm64'], [0x1c4, 'arm']]);
const subsystems = new Map([[1, 'native'], [2, 'windows-gui'], [3, 'windows-cui'], [10, 'efi-application']]);
const maxNames = 128;
const maxString = 256;

export async function parsePe(path, signal) {
  const fd = await open(path, 'r');
  try {
    const initial = await fd.stat();
    const { size } = initial;
    if (!initial.isFile() || !Number.isSafeInteger(size)) throw new Error('PE 输入不是普通文件。');
    async function read(offset, length) {
      signal?.throwIfAborted();
      if (offset < 0 || length < 0 || offset + length > size) throw new Error('PE 文件范围越界。');
      const out = Buffer.alloc(length);
      for (let cursor = 0; cursor < length;) {
        signal?.throwIfAborted();
        const { bytesRead } = await fd.read(out, cursor, length - cursor, offset + cursor);
        if (!bytesRead) throw new Error('PE 文件读取不完整。');
        cursor += bytesRead;
      }
      return out;
    }
    const dos = await read(0, 64);
    const nt = dos.readUInt32LE(60);
    if (dos.readUInt16LE(0) !== 0x5a4d || nt < 64) throw new Error('PE DOS 头无效。');
    const coff = await read(nt, 24);
    if (coff.readUInt32LE(0) !== 0x4550) throw new Error('PE 签名无效。');
    const machineCode = coff.readUInt16LE(4);
    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    if (sectionCount > 96 || optionalSize < 96 || optionalSize > 4096) throw new Error('PE 节数或可选头长度无效。');
    const optional = await read(nt + 24, optionalSize);
    const magic = optional.readUInt16LE(0);
    const wide = magic === 0x20b;
    if (!wide && magic !== 0x10b) throw new Error('PE 可选头格式不支持。');
    const directoryStart = wide ? 112 : 96;
    if (optionalSize < directoryStart) throw new Error('PE 可选头不完整。');
    const directoryCount = optional.readUInt32LE(directoryStart - 4);
    if (directoryCount > Math.floor((optionalSize - directoryStart) / 8)) throw new Error('PE 数据目录数量越界。');
    const headersSize = optional.readUInt32LE(60);
    const sectionTable = nt + 24 + optionalSize;
    if (headersSize < sectionTable + sectionCount * 40 || headersSize > size) throw new Error('PE 头部大小无效。');
    const table = await read(sectionTable, sectionCount * 40);
    const sections = [];
    for (let i = 0; i < sectionCount; i++) {
      const at = i * 40;
      const rawSize = table.readUInt32LE(at + 16);
      const rawOffset = table.readUInt32LE(at + 20);
      const virtualSize = table.readUInt32LE(at + 8);
      const rva = table.readUInt32LE(at + 12);
      if ((rawSize && (rawOffset < headersSize || rawOffset + rawSize > size)) || rva + Math.max(rawSize, virtualSize) > 0x100000000) {
        throw new Error('PE 节范围越界。');
      }
      const label = table.subarray(at, at + 8);
      const end = label.indexOf(0);
      const name = label.subarray(0, end === -1 ? 8 : end).toString('latin1').replace(/[^ -~]/gu, '?');
      sections.push({ name, rva, virtualSize, rawOffset, rawSize });
    }
    // 一段数据的可读窗口：止于本节 raw 末尾、下一个节的 raw 起点、文件末尾三者的最近者。
    // 起始字节若已被另一节的 raw 数据占用，字节归属不唯一，直接报错而不是照读。
    function trim(section, start, end) {
      let limit = Math.min(size, end);
      for (const other of sections) {
        if (other === section || !other.rawSize) continue;
        const otherEnd = Math.min(size, other.rawOffset + other.rawSize);
        if (other.rawOffset <= start && start < otherEnd) throw new Error('PE 节数据在文件中重叠，无法确定唯一字节范围。');
        if (other.rawOffset > start && other.rawOffset < limit) limit = other.rawOffset;
      }
      return limit - start;
    }
    function range(rva) {
      if (!rva || rva > 0xffffffff) throw new Error('PE 目录引用无效。');
      const choices = [];
      if (rva < headersSize) {
        const length = trim(null, rva, headersSize);
        if (length > 0) choices.push({ offset: rva, length });
      }
      for (const section of sections) {
        const delta = rva - section.rva;
        if (delta < 0 || delta >= Math.max(section.virtualSize, section.rawSize)) continue;
        if (delta >= section.rawSize) continue;
        const start = section.rawOffset + delta;
        if (start >= size) continue;
        const length = trim(section, start, section.rawOffset + section.rawSize);
        if (length > 0) choices.push({ offset: start, length });
      }
      if (choices.length !== 1) throw new Error('PE 目录引用没有唯一的文件字节范围。');
      return choices[0];
    }
    function requireRange(rva, length) {
      const mapped = range(rva);
      if (length > mapped.length || rva + length > 0x100000000) throw new Error('PE 目录范围越界。');
      for (const section of sections) {
        if (section.rva > rva && section.rva < rva + length) throw new Error('PE 目录范围跨越多个节，映射不唯一。');
      }
      return mapped;
    }
    async function readRva(rva, length) {
      return read(requireRange(rva, length).offset, length);
    }
    async function nameAt(rva, skip = 0) {
      const mapped = requireRange(rva, skip + 1);
      const available = mapped.length - skip;
      const data = await read(mapped.offset + skip, Math.min(maxString + 1, available));
      const end = data.indexOf(0);
      if (end === -1) throw new Error('PE 名称未在唯一节范围内终止。');
      if (end < 1 || data.subarray(0, end).some(byte => byte < 32 || byte > 126)) throw new Error('PE 名称编码不受支持。');
      return data.toString('ascii', 0, end);
    }
    function directory(index) {
      if (index >= directoryCount) return null;
      const at = directoryStart + index * 8;
      const rva = optional.readUInt32LE(at);
      const bytes = optional.readUInt32LE(at + 4);
      return rva || bytes ? { rva, bytes } : null;
    }
    const width = wide ? 8 : 4;
    const ordinalFlag = wide ? 0x8000000000000000n : 0x80000000n;
    async function importsOf(dir) {
      if (dir.bytes < 20) throw new Error('PE 导入目录不完整。');
      requireRange(dir.rva, dir.bytes);
      const limit = 64;
      const descriptors = await readRva(dir.rva, Math.min(dir.bytes, (limit + 1) * 20));
      const items = [];
      let remaining = maxNames;
      let clipped = false;
      for (let at = 0; at + 20 <= descriptors.length; at += 20) {
        if (descriptors.subarray(at, at + 20).every(byte => byte === 0)) return { status: clipped ? 'partial' : 'parsed', items };
        if (items.length === limit) return { status: 'partial', items };
        const lookup = descriptors.readUInt32LE(at);
        const dll = await nameAt(descriptors.readUInt32LE(at + 12));
        const first = descriptors.readUInt32LE(at + 16);
        const mapped = range(lookup || first);
        const count = Math.min(remaining + 1, Math.floor(mapped.length / width));
        const thunk = await read(mapped.offset, count * width);
        const symbols = [];
        let terminated = false;
        for (let i = 0; i < count; i++) {
          const value = wide ? thunk.readBigUInt64LE(i * width) : BigInt(thunk.readUInt32LE(i * width));
          if (!value) { terminated = true; break; }
          if (!remaining) break;
          if ((value & ordinalFlag) !== 0n) symbols.push({ ordinal: Number(value & 0xffffn) });
          else symbols.push({ name: await nameAt(Number(value), 2) });
          remaining--;
        }
        if (!terminated) {
          if (remaining) throw new Error('PE 导入名称表缺少终止项。');
          clipped = true;
        }
        items.push({ dll, symbols });
      }
      throw new Error('PE 导入描述符缺少终止项。');
    }
    async function exportsOf(dir) {
      if (dir.bytes < 40) throw new Error('PE 导出目录不完整。');
      requireRange(dir.rva, dir.bytes);
      const bytes = await readRva(dir.rva, 40);
      const ordinalBase = bytes.readUInt32LE(16);
      const functions = bytes.readUInt32LE(20);
      const count = bytes.readUInt32LE(24);
      const addressRva = bytes.readUInt32LE(28);
      const items = [];
      // 函数地址表必须整表落在唯一节内；否则 ordinal → 槽位映射无法核对。
      if (functions) requireRange(addressRva, functions * 4);
      else if (count) throw new Error('PE 导出没有函数地址槽位。');
      if (count) {
        const length = Math.min(count, maxNames);
        const namesRva = bytes.readUInt32LE(32);
        const ordinalsRva = bytes.readUInt32LE(36);
        requireRange(namesRva, count * 4);
        requireRange(ordinalsRva, count * 2);
        const names = await readRva(namesRva, length * 4);
        const ordinals = await readRva(ordinalsRva, length * 2);
        const seen = new Set();
        for (let i = 0; i < length; i++) {
          const ordinal = ordinals.readUInt16LE(i * 2);
          if (ordinal >= functions || ordinalBase + ordinal > 0xffffffff) throw new Error('PE 导出序号越界。');
          if (seen.has(ordinal)) throw new Error('PE 导出序号到函数地址槽位的映射重复。');
          seen.add(ordinal);
          items.push({ name: await nameAt(names.readUInt32LE(i * 4)), ordinal: ordinalBase + ordinal });
        }
      }
      return { status: count > maxNames ? 'partial' : 'parsed', namedCount: count, functionSlots: functions, items };
    }
    async function inspect(index, parse) {
      const dir = directory(index);
      if (!dir) return { status: 'absent', items: [] };
      try { return await parse(dir); }
      catch (error) {
        signal?.throwIfAborted();
        return { status: 'unreadable', items: [], reason: error.message };
      }
    }
    const imports = await inspect(1, importsOf);
    const exports = await inspect(0, exportsOf);
    const clr = directory(14);
    const final = await fd.stat();
    signal?.throwIfAborted();
    if (final.size !== size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw new Error('PE 文件在读取期间发生变化。');
    const subsystemCode = optional.readUInt16LE(68);
    return {
      format: wide ? 'pe32+' : 'pe32', machine: machines.get(machineCode) ?? 'unknown', machineCode,
      subsystem: subsystems.get(subsystemCode) ?? 'unknown', subsystemCode, bytes: size,
      imageBase: `0x${(wide ? optional.readBigUInt64LE(24) : optional.readUInt32LE(28)).toString(16)}`,
      timestamp: coff.readUInt32LE(8), entryPointRva: optional.readUInt32LE(16), sections, imports, exports,
      clr: { declared: Boolean(clr?.rva && clr?.bytes), directory: clr },
      delayImport: directory(13),
    };
  } finally { await fd.close(); }
}
