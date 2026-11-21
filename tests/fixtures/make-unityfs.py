"""生成 UnityFS v6 无压缩和 v7 尾置 LZ4 夹具，并用 UnityPy 回读。

v6 用 struct 拼装，v7 用 UnityPy BundleFile.save() 写出。
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
    bundle = BundleFile(EndianBinaryReader(data), None)
    bundle.version = 7
    bundle._uses_block_alignment = True
    compressed = bundle.save("lz4")
    reloaded = BundleFile(EndianBinaryReader(compressed), None)
    assert reloaded.version == 7
    assert int(reloaded.dataflags) == 0xC2
    assert reloaded.files[NODE_PATH].bytes == NODE_DATA
    compressed_target = target.with_name("unityfs-lz4-tail.bundle")
    compressed_target.write_bytes(compressed)
    print(f"written {compressed_target} {len(compressed)} bytes, verified by UnityPy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())