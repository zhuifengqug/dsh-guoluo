// 长度解码表要 514 个概率：choice + choice2 + 16×8(low) + 16×8(mid) + 256(high)。
// Unity 资产包里的 LZMA 块：1 字节属性（lc/lp/pb）+ 4 字节字典大小（LE）+ 原始 LZMA1 数据。
// 解压长度由块表给出，所以不依赖流内结束标记。实现取自 LZMA SDK 的公开算法（公有领域）。
const kNumStates = 12;
const kNumPosSlotBits = 6;
const kNumLenToPosStates = 4;
const kMatchMinLen = 2;
const kNumAlignBits = 4;
const kAlignTableSize = 1 << kNumAlignBits;
const kStartPosModelIndex = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >> 1);
const kNumPosStatesBitsMax = 4;
const kNumPosStatesMax = 1 << kNumPosStatesBitsMax;
const kNumLowLenBits = 3;
const kNumMidLenBits = 3;
const kNumHighLenBits = 8;
const kNumLowLenSymbols = 1 << kNumLowLenBits;
const kNumMidLenSymbols = 1 << kNumMidLenBits;
const kNumLenSymbols = kNumLowLenSymbols + kNumMidLenSymbols + (1 << kNumHighLenBits);
const kNumLitStates = 7;
const kLengthProbs = 2 + kNumPosStatesMax * kNumLowLenSymbols + kNumPosStatesMax * kNumMidLenSymbols + (1 << kNumHighLenBits);
const kNumPosModels = kNumFullDistances - kEndPosModelIndex;

const makeProbs = size => { const table = new Uint16Array(size); table.fill(1 << 10); return table; };
const stateAfterLiteral = state => (state < 4 ? 0 : state < 10 ? state - 3 : state - 6);
const stateAfterMatch = state => (state < kNumLitStates ? 7 : 10);
const stateAfterRep = state => (state < kNumLitStates ? 8 : 11);
const stateAfterShortRep = state => (state < kNumLitStates ? 9 : 11);

class RangeDecoder {
  constructor(source, position) { this.source = source; this.position = position; this.range = 0xffffffff; this.code = 0; }
  byte() {
    if (this.position >= this.source.length) throw new Error('LZMA 数据提前结束。');
    return this.source[this.position++];
  }
  init() {
    if (this.source.length - this.position < 5) throw new Error('LZMA 数据头部不完整。');
    this.code = 0;
    for (let index = 0; index < 5; index += 1) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }
  normalize() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }
  bit(table, index) {
    const probability = table[index];
    const bound = (this.range >>> 11) * probability;
    let value;
    if (this.code < bound) {
      this.range = bound >>> 0;
      table[index] = probability + ((2048 - probability) >>> 5);
      value = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      table[index] = probability - (probability >>> 5);
      value = 1;
    }
    this.normalize();
    return value;
  }
  directBits(count) {
    let result = 0;
    for (let index = 0; index < count; index += 1) {
      this.range = this.range >>> 1;
      let value = 0;
      if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; value = 1; }
      this.normalize();
      result = result * 2 + value;
    }
    return result;
  }
}

function bitTree(decoder, table, base, bits) {
  let symbol = 1;
  for (let index = 0; index < bits; index += 1) symbol = (symbol << 1) | decoder.bit(table, base + symbol);
  return symbol - (1 << bits);
}

function reverseBitTree(decoder, table, base, bits) {
  let symbol = 1;
  let value = 0;
  for (let index = 0; index < bits; index += 1) {
    const bit = decoder.bit(table, base + symbol);
    symbol = (symbol << 1) | bit;
    value |= bit << index;
  }
  return value;
}

function lengthOf(decoder, table, posState) {
  if (decoder.bit(table, 0) === 0) return bitTree(decoder, table, 2 + posState * kNumLowLenSymbols, kNumLowLenBits);
  if (decoder.bit(table, 1) === 0) return kNumLowLenSymbols + bitTree(decoder, table, 2 + kNumPosStatesMax * kNumLowLenSymbols + posState * kNumMidLenSymbols, kNumMidLenBits);
  return kNumLowLenSymbols + kNumMidLenSymbols + bitTree(decoder, table, 2 + kNumPosStatesMax * kNumLowLenSymbols + kNumPosStatesMax * kNumMidLenSymbols, kNumHighLenBits);
}

export function lzmaBlockDecompress(source, expectedSize, { maxOutput = Infinity, signal } = {}) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error('LZMA 声明的解压长度无效。');
  if (expectedSize > maxOutput) throw new Error(`LZMA 声明的解压长度 ${expectedSize} 字节超出 ${maxOutput} 字节上限。`);
  if (expectedSize === 0) return Buffer.alloc(0);
  if (source.length < 6) throw new Error('LZMA 数据头部不完整。');
  const properties = source[0];
  if (properties >= 9 * 5 * 5) throw new Error(`LZMA 属性字节 ${properties} 无效。`);
  const lc = properties % 9;
  const rest = (properties - lc) / 9;
  const lp = rest % 5;
  const pb = (rest - lp) / 5;
  if (lc > 8 || lp > 4 || lc + lp > 4) throw new Error('LZMA 属性 lc/lp 超出支持范围。');
  const dictionary = source.readUInt32LE(1);
  if (dictionary < 4096) throw new Error('LZMA 字典大小无效。');
  const out = Buffer.alloc(expectedSize);
  const decoder = new RangeDecoder(source, 5);
  decoder.init();
  const isMatch = makeProbs(kNumStates * kNumPosStatesMax);
  const isRep = makeProbs(kNumStates);
  const isRepG0 = makeProbs(kNumStates);
  const isRepG1 = makeProbs(kNumStates);
  const isRepG2 = makeProbs(kNumStates);
  const isRep0Long = makeProbs(kNumStates * kNumPosStatesMax);
  const posSlot = makeProbs(kNumLenToPosStates * (1 << kNumPosSlotBits));
  const posDecoders = makeProbs(kNumPosModels);
  const align = makeProbs(kAlignTableSize);
  // LZMA 用两套独立的长度解码概率表：新匹配用 lengthTable，重复匹配用 repLengthTable。
  const lengthTable = makeProbs(kLengthProbs);
  const repLengthTable = makeProbs(kLengthProbs);
  const literals = makeProbs(0x300 << (lc + lp));
  const posStateMask = (1 << pb) - 1;
  const literalPosMask = (1 << lp) - 1;
  let state = 0;
  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  let position = 0;
  while (position < expectedSize) {
    if ((position & 0x3fff) === 0) signal?.throwIfAborted();
    const posState = position & posStateMask;
    if (decoder.bit(isMatch, (state << kNumPosStatesBitsMax) | posState) === 0) {
      const previous = position > 0 ? out[position - 1] : 0;
      const base = 0x300 * (((position & literalPosMask) << lc) + (previous >> (8 - lc)));
      let symbol = 1;
      if (state >= kNumLitStates) {
        if (position - rep0 - 1 < 0) throw new Error('LZMA 匹配距离越出已解压区间。');
        let matchByte = out[position - rep0 - 1];
        do {
          const matchBit = (matchByte >> 7) & 1;
          matchByte = (matchByte << 1) & 0xff;
          const bit = decoder.bit(literals, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | decoder.bit(literals, base + symbol);
      out[position] = symbol & 0xff;
      position += 1;
      state = stateAfterLiteral(state);
      continue;
    }
    let length;
    if (decoder.bit(isRep, state) === 1) {
      if (position === 0) throw new Error('LZMA 重复匹配出现在数据开头。');
      const repG0 = decoder.bit(isRepG0, state);
      if (repG0 === 0) {
        const long = decoder.bit(isRep0Long, (state << kNumPosStatesBitsMax) | posState);
        if (long === 0) {
          if (position - rep0 - 1 < 0) throw new Error('LZMA 匹配距离越出已解压区间。');
          out[position] = out[position - rep0 - 1];
          position += 1;
          state = stateAfterShortRep(state);
          continue;
        }
      } else {
        let distance;
        if (decoder.bit(isRepG1, state) === 0) distance = rep1;
        else {
          if (decoder.bit(isRepG2, state) === 0) distance = rep2;
          else { distance = rep3; rep3 = rep2; }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      length = lengthOf(decoder, repLengthTable, posState) + kMatchMinLen;
      state = stateAfterRep(state);
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      length = lengthOf(decoder, lengthTable, posState) + kMatchMinLen;
      state = stateAfterMatch(state);
      const lenState = Math.min(length - kMatchMinLen, kNumLenToPosStates - 1);
      const slot = bitTree(decoder, posSlot, lenState * (1 << kNumPosSlotBits), kNumPosSlotBits);
      let distance;
      if (slot < kStartPosModelIndex) distance = slot;
      else {
        const directBits = (slot >> 1) - 1;
        distance = (2 | (slot & 1)) * 2 ** directBits;
        if (slot < kEndPosModelIndex) distance += reverseBitTree(decoder, posDecoders, distance - slot - 1, directBits);
        else {
          distance += decoder.directBits(directBits - kNumAlignBits) * kAlignTableSize;
          distance += reverseBitTree(decoder, align, 0, kNumAlignBits);
        }
      }
      rep0 = distance;
    }
    if (position - rep0 - 1 < 0) throw new Error('LZMA 匹配距离越出已解压区间。');
    if (position + length > expectedSize) throw new Error(`LZMA 匹配长度 ${length} 超出声明大小。`);
    for (let offset = 0; offset < length; offset += 1) {
      out[position] = out[position - rep0 - 1];
      position += 1;
      if ((position & 0x3fff) === 0) signal?.throwIfAborted();
    }
  }
  return out;
}
