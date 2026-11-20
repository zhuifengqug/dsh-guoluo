"""用 UnityPy（独立实现）写出一份 UnityFS 样例并回读校验。

产物：tests/fixtures/unityfs-none.bundle
目的：让 JS 解析器面对一份由第三方实现生成、并由第三方实现证明可读的 UnityFS 头，
而不是只面对自己写的合成夹具。
"""
import struct
import sys
from pathlib import Path

from UnityPy.files import BundleFile
from UnityPy.streams import EndianBinaryReader

UNITY_VERSION = "2021.3.16f1"
UNITY_REVISION = "2021.3.16f1 (0e1a5c4a6b2f)"
NODE_PATH = "assets/demo/data"
NODE_DATA = b"guoluo-fixture"


def header(signature: bytes, version: int, player: str, revision: str,
           size: int, compressed: int, uncompressed: int, flags: int) -> bytes:
    out = bytearray()
    out += signature
    out += struct.pack(">I", version)
    out += player.encode() + b"\0"
    out += revision.encode() + b"\0"
    out += struct.pack(">q", size)
    out += struct.pack(">I", compressed)
    out += struct.pack(">I", uncompressed)
    out += struct.pack(">I", flags)
    return bytes(out)


def build() -> bytes:
    # blocksInfo：16 字节内容哈希 + 块表 + 节点表（全部未压缩）
    node = NODE_DATA
    blocks_info = bytearray()
    blocks_info += b"\0" * 16
    blocks_info += struct.pack(">i", 1)              # 1 个块
    blocks_info += struct.pack(">IIH", len(node), len(node), 0)  # 未压缩/压缩/标志
    blocks_info += struct.pack(">i", 1)              # 1 个节点
    blocks_info += struct.pack(">qqI", 0, len(node), 4)  # offset/size/flags
    blocks_info += NODE_PATH.encode() + b"\0"

    head = header(b"UnityFS\0", 6, UNITY_VERSION, UNITY_REVISION,
                  size=0,                       # 稍后回填
                  compressed=len(blocks_info),
                  uncompressed=len(blocks_info),
                  flags=0x40)                   # BlocksAndDirectoryInfoCombined | 无压缩
    body = head + bytes(blocks_info) + node
    size = len(body)
    head = header(b"UnityFS\0", 6, UNITY_VERSION, UNITY_REVISION,
                  size=size,
                  compressed=len(blocks_info),
                  uncompressed=len(blocks_info),
                  flags=0x40)
    return head + bytes(blocks_info) + node


def verify(data: bytes) -> None:
    reader = EndianBinaryReader(data)
    bundle = BundleFile(reader, None)
    assert bundle.version >= 6, bundle.version
    assert bundle.dataflags & 0x3F == 0, bundle.dataflags
    assert bundle.version_player == UNITY_VERSION, bundle.version_player
    assert bundle.version_engine == UNITY_REVISION, bundle.version_engine
    # 目录节点名就是文件内容流的键；UnityPy 至此已经把块解压进内存
    entry = bundle.files[NODE_PATH]
    assert entry.Length == len(NODE_DATA), entry.Length
    assert bytes(entry.bytes[: entry.Length]) == NODE_DATA


def main() -> int:
    target = Path(sys.argv[1])
    data = build()
    verify(data)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print(f"written {target} {len(data)} bytes, verified by UnityPy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())