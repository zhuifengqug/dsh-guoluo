# 测试夹具来源

- `apk-pagination.apk`：由 `aapt2 link -I D:\Android\sdk\platforms\android-35\android.jar --manifest <清单> -o apk-pagination.apk` 生成，清单内各有 70 条 `uses-permission` 与 `activity`，包名 `com.example.guoluo`。用来验证权限与活动的跨页读取，不是任何真实应用的副本。
- `godot-4.7.2.pck`、`godot-4.7.2-empty.pck`：由 Godot 4.7.2 自带的 `PCKPacker` 生成，`make-godot-empty-pck.gd` 可重建后者。
- `unityfs-none.bundle`、`unityfs-lz4-tail.bundle`：由 `make-unityfs.py` 用 UnityPy 1.25.4 写出并回读校验。
