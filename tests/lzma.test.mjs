// LZMA 解码器的回归向量由 Python 3.12 的 lzma（liblzma，FORMAT_RAW + FILTER_LZMA1）独立压缩生成。
// 每个向量都断言解压结果的 SHA-256，避免「能跑通但字节不对」被当成通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lzmaBlockDecompress } from '../lib/lzma.mjs';

const vectors = [
  // 连续短匹配 + 长匹配：当初漏掉「重复匹配用独立长度概率表」时，这一档会解错。
  ['abab… 重复 200 字节', '5d00008000003098aad0183dfffffffc200000', 200, '80f5495226473b1b53657205e8fa14ab41bd12161cb002140ce2f4b7ad8cd80f'],
  // 不同 lc/lp/pb 组合（lc=0 lp=2 pb=1）：验证属性字节解析与字面量上下文索引。
  ['lc0 lp2 pb1 周期数据 400 字节', '3f00008000000003434f877ccba78a8034e4f4c25a65e46d4134995da9bd0ede9e1ad84355625faee607f4a0ec254c0dcbad8a5e4f3cd25d57ffffe97a8000', 400, 'f4b18da98d86c739577de668341270e82bd22b05354c0bc5baf49f51604ee6a9'],
  // 随机数据（绝大多数是字面量）+ 长重复 900 字节（高长度区间）。
  ['随机 300 字节', '5d000080000031add9e1839ba1abda29dcd5ceaec9e8648141e7204e7a7ba702fa268df7b4457deb1f57f64b260471c9e082624ebaceb8f454b51794679d8ea1c93669249e884f97a15244f0884c1479e0c2b23a431169ae61a62516f557d4cb1e12919992b27ffd161d3ec51f25e6678e3b11cc5455d4318588100b115d037195405d2e19d58b5dcf803aed93c22973956c3efd97f7e276a0aeef2c7a7a76c0000c003e7bc1f96f6f4386afcf74fc5dfb8e1ed0fa3536841926c2957cc64f80482c4bd04c1ed492e31bd89752531aa7b4eb49799358732ab190134ab18dad222779add1bf5adabd09e2dedf1fbdbc6faf55541cdb1625cc858796d5eaeccfa399178aedc88594f4a4109195bfd4308de673821f4bf48212fac0c29447b8f39c81ab3752869b7a5e9149de6aad56c7ab4af294b405f53e2f8c94cb0f4264abdf825783ffffc7fd0000', 300, '19dad82c7668d5831150283dd0bb385fc994c587e406abbaf875c65b7584ad12'],
  ['单字节重复 900 字节', '5d00008000002d6ffbbffea3b027c64b3bffffa7ec0000', 900, '055a3605208cc1d3d12011d5eab0e38b431427c6fc2da8e752a59315591ab904'],
];

for (const [label, hex, size, sha256] of vectors) {
  test(`LZMA 解压 ${label} 与压缩器结果逐字节一致`, () => {
    const out = lzmaBlockDecompress(Buffer.from(hex, 'hex'), size);
    assert.equal(out.length, size);
    assert.equal(createHash('sha256').update(out).digest('hex'), sha256);
  });
}

test('LZMA 空流与上限、属性、头部三类拒绝', () => {
  assert.equal(lzmaBlockDecompress(Buffer.from(vectors[0][1], 'hex'), 0).length, 0);
  assert.throws(() => lzmaBlockDecompress(Buffer.from(vectors[0][1], 'hex'), 200, { maxOutput: 199 }), /超出 199 字节上限/u);
  assert.throws(() => lzmaBlockDecompress(Buffer.from('5d0000', 'hex'), 10), /头部不完整/u);
  assert.throws(() => lzmaBlockDecompress(Buffer.from('ff0000800000', 'hex'), 10), /属性字节 255 无效/u);
  // lc=9 的组合不合法（225 起已先被属性字节上限拦下，这里用 lc+lp>4 的 0x3f 之外再构造一个越界组合）
  assert.throws(() => lzmaBlockDecompress(Buffer.from('5d0000000000', 'hex'), 10), /字典大小无效/u);
});

test('LZMA 声明长度与实际流不符时报错而不是返回半截数据', () => {
  const blob = Buffer.from(vectors[3][1], 'hex');
  assert.throws(() => lzmaBlockDecompress(blob, 901), /超出声明大小|提前结束|越出已解压区间/u);
});

test('LZMA 解压可被取消信号中断', () => {
  const blob = Buffer.from(vectors[3][1], 'hex');
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => lzmaBlockDecompress(blob, 900, { signal: controller.signal }), /abort|AbortError/u);
});
