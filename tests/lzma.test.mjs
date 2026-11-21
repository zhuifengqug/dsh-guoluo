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
  // 匹配之后紧跟字面量：只有 state >= 7 才会走到的 matched literal 分支。
  ['匹配后接字面量 1960 字节', '5d0000800000000052500a84f99bb28021a969d627e03e065a5f048d53d404ba39570509c15524de9db871593160a19ff96f49741bbd28b1274e27486d08eb2ce10973ce44289de242c42422861f996c6c23239d79e6722b6ae0ea8ec184ea55ce5a33c5c1ff288eae781a05b76a7ef6f7c5b1df7a4b47f22087c85648d91df3f47c370286ffffcdc10000', 1960, 'c0c8025ab11c53518fc7d62ae2f7cf5e241b05ab8af40d9ce715a4d63c25cacf'],
  // 单字节短匹配（shortRep）：验证 isRep0Long 与短匹配后的状态回退。
  ['单字节重复 400 字节', '5d000080000030effbbafc5ff7fffffdf08000', 400, 'abd5e54be3f59d8ee4943b2380def17f546e604cc51da8b9c93f591f205e75db'],
  // 多个最近距离轮转（rep1 / rep2 / rep3）：验证重复距离队列的移位顺序。
  ['最近距离轮转 72 字节', '5d000080000020908476ba8a75cfb40db2e8a8c5f2928e1e4597ade931c37fd7fffff0380000', 72, 'b2c43f5652ede0f6ddf0ecec7b90ee811b9c58aaa834a180cb78d0c20b2d1f69'],
  // 距离 1200 的大位移匹配：posSlot >= 14，走 directBits 与 align 反序位树。
  ['大位移匹配 2400 字节', '5d000080000073bb9898a2d5009c2e00597e534e357694d74401cd058bc317b392dbad2e6ae7710b63164f32255baf994ffd878ac6d09ea6cf5c0abe4590d207fbb585d03798d1d5fcfc2d4b295e347f5b63bedcae74d1d8cc0560b49ecad945e69df3207d3b4c0f710be4f029ccd68f486860d178ec176c187c5bb0ca3afc97084481c24393eda8243560abc011bb64d0d64c82cf35c61cde3ccb160d826f8e970763d5fe3b9e5beceaf210121b59e281310fbb8a2edd56017629ca9ee6fe83205f006d60102fe928fae9b308cf3ad392d0fe36709f0bb052e6e2bdb40d0598bc87bd25f2801892fff32603a0d8bc99ba8b47fbc0e04f29be8e5f94a26ec0076dc9a00f15053415437c2cafc23625808eba8f737cf7aed5065e8453aacde7d0ec51adf706760e2e5303e069390a9a9230f37b9a4dc7b1c12d9c0b831562d9a48dec91a8f2c3b5893cc29b7529991462c64034525eccce6fa3a62601515bef23b6c133d82c5ec1fd7d903f0f46c760a38e039cb814dec56bf96d12b62020d310bacb400c339cc23b1f1865979bcb847c9061db928f1dc7a06a4956fd030fbb1fc220623d514a18b5b9a0eefe16022af92287d02858986cb0be4205c6ad22a04663edb2a76f7d72f471b0d1756d68245fa7d75d1b52b2c6b87b822af91a33798d24804af56e3c273dc9479afc09b5d7442f597140e7ae2ea20e324560a5fcb63a778756f06eb793539c9e9a36d06d96235614cf80a981d5bd941b5a3059c5196beb5875fb9463854f2b89fddf583cfbed1b7f54c19019efb0d035764d87131119a2a6d5865ff2599ea03f8eadaac56fd1d0769170ff0952715a319c12c20e7dbdb81f7d801694e53850600ee514bd0b6a61f1a64edb4bf4d1c1a623c4eff46f33bbab38573fd083544eabd55bb526c9aa347aa79509ce595944f61c5374342aa3e687cbd27523e422c2e1b9e438afcd5270defc5efc382a1f94534489fd6dc2df796dea629dda23cc58b783b3a86b7349576acafa9a362f2e02c891e28a67af7c4579d618b20553b8d49851c052fdbe5e283e4801a6ce46a6b64b16745de2a3c757aa6824677fbb020644cfe859fcd97c0a35a150d52f97f8e0c2fdb3c84454e8dc1ae6a585798d965aef15e24e68927726fdc79fe016390a647c6e578212f252396c375c4ad6823cb1b23a37f5b127f6a5e207307997ec1e61c75bd055969273f3685ba5ee260051bfebaef7171ea98b1b123057f012e6250a747ff43ec008b5bdacf6e3f892f93ad17e833cbd459c777a455d79eae6b9bb7cb1da0a4e1b321e8c3391ff39ed459aa6f49a4401d4252ac07b623de02a15365bca8af09a9c8e580061cac36b30644c0789db4e3c2bfa0d332fbc9414b51d47f537da35bd91343f2cac0304f98198ecd640180247667074c3769b2d51a817784fe3e109b3376ca02f754e804da4a6443fc6ffd700c773b9ca93efd43391b35af461ccead36dc3cef330fc7c1c660211ea08f65ad1b079db5ecbe5a4688937c59ed1705fa0f8a2dcca63f37c518c706a01ba2c4160decde9bf198f696c6bb47ca0d952b742a8590b14fb15a3f42755454c67b86fe9d04484f69048b45479c5f3257bee15ef367e007d103457453f6927ac7023825f74e239a8ec130266d3299a8615189305b8ae5044f08369a2979bfe657d072ebfbf0d86a5779b606246cc81392597ab95675ec39464f069ca47ce19f59ebecca786df2927013d0493d2e9066ba3ffff91bd5580', 2400, '64595d18860592190deef6a1e5dcde768cb52dbcaae30dd397abd439ae9e4ae1'],
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
