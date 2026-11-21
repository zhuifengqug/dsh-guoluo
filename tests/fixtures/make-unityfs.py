"""Generate UnityFS fixtures and print the UnityPy-written snapshot used by Node tests.

Usage: python tests/fixtures/make-unityfs.py <scratch-dir>/unityfs-none.bundle
"""
import base64
import json
import struct
import sys
from collections import Counter
from importlib import import_module
from pathlib import Path
from unittest.mock import patch

from UnityPy.files import BundleFile
from UnityPy.streams import EndianBinaryReader, EndianBinaryWriter

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


def verify(data: bytes, version: int, flags: int) -> BundleFile:
    bundle = BundleFile(EndianBinaryReader(data), None)
    assert bundle.version == version, bundle.version
    assert int(bundle.dataflags) == flags, bundle.dataflags
    assert bundle.version_player == UNITY_VERSION, bundle.version_player
    assert bundle.version_engine == UNITY_REVISION, bundle.version_engine
    assert list(bundle.files) == [NODE_PATH], list(bundle.files)
    entry = bundle.files[NODE_PATH]
    assert entry.Length == len(NODE_DATA), entry.Length
    assert bytes(entry.bytes[: entry.Length]) == NODE_DATA
    return bundle


def independent_snapshot(bundle: BundleFile) -> dict:
    extra = EndianBinaryWriter(b"second UnityPy node")
    extra.flags = 0
    bundle.files["assets/demo/second.resS"] = extra
    data = bundle.save("none")

    implementation = import_module("UnityPy.files.BundleFile")
    block_type = implementation.BlockInfo
    blocks = []

    def record_block(*args):
        block = block_type(*args)
        blocks.append(block._asdict())
        return block

    class ObservedBundle(BundleFile):
        def read_fs(self, reader):
            nodes, payload = super().read_fs(reader)
            self.nodes = [node._asdict() for node in nodes]
            return nodes, payload

    # UnityPy consumes the block table inside read_fs without retaining the list.
    with patch.object(implementation, "BlockInfo", record_block):
        reread = ObservedBundle(EndianBinaryReader(data), None)
    assert int(reread.dataflags) == 0x40
    assert list(reread.files) == [NODE_PATH, "assets/demo/second.resS"]
    assert blocks and all(block["flags"] & 0x3F == 0 for block in blocks)
    return {
        "base64": base64.b64encode(data).decode("ascii"),
        "nodes": reread.nodes,
        "blocks": blocks,
        "codecCounts": dict(Counter(block["flags"] & 0x3F for block in blocks)),
    }


LZMA_PAYLOAD = bytes((i * 37) % 256 for i in range(4096))


def write_lzma(target: Path) -> None:
    """LZMA 版夹具：块信息段用 LZMA，第二份再让数据块本身也走 LZMA。"""
    data = build()
    bundle = verify(data, version=6, flags=0x40)
    bundle.version = 7
    bundle._uses_block_alignment = True
    info_only = bundle.save("lzma")
    verify(info_only, version=7, flags=0x41)
    target.write_bytes(info_only)
    print(f"written {target} {len(info_only)} bytes, UnityPy round-trip ok")
    extra = EndianBinaryWriter(LZMA_PAYLOAD)
    extra.flags = 4
    bundle.files["assets/demo/big.resS"] = extra
    data_blocks = bundle.save("lzma")
    reread = BundleFile(EndianBinaryReader(data_blocks), None)
    assert int(reread.dataflags) == 0x41, reread.dataflags
    assert list(reread.files) == [NODE_PATH, "assets/demo/big.resS"], list(reread.files)
    assert bytes(reread.files["assets/demo/big.resS"].bytes) == LZMA_PAYLOAD
    big = target.with_name("unityfs-lzma-data.bundle")
    big.write_bytes(data_blocks)
    print(f"written {big} {len(data_blocks)} bytes, UnityPy round-trip ok")


def main() -> int:
    target = Path(sys.argv[1])
    data = build()
    bundle = verify(data, version=6, flags=0x40)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print(f"written {target} {len(data)} bytes, verified by UnityPy: node {NODE_PATH} ({len(NODE_DATA)} bytes)")
    bundle.version = 7
    bundle._uses_block_alignment = True
    compressed = bundle.save("lz4")
    verify(compressed, version=7, flags=0xC2)
    compressed_target = target.with_name("unityfs-lz4-tail.bundle")
    compressed_target.write_bytes(compressed)
    print(f"written {compressed_target} {len(compressed)} bytes, verified by UnityPy")
    write_lzma(target.with_name('unityfs-lzma.bundle'))
    print(json.dumps(independent_snapshot(bundle)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())