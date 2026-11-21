// 用 aapt2 这个独立解析器交叉核对插件自己的二进制清单解析结果。
// 只在本机能找到 aapt2 与 android.jar 时运行；找不到就跳过，不把「没装 SDK」当成失败。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

const run = promisify(execFile);

const AAPT2_CANDIDATES = [
  process.env.GUOLUO_TEST_AAPT2,
  'D:/Android/sdk/build-tools/35.0.0/aapt2.exe',
].filter(Boolean);
const ANDROID_JAR_CANDIDATES = [
  process.env.GUOLUO_TEST_ANDROID_JAR,
  'D:/Android/sdk/platforms/android-35/android.jar',
].filter(Boolean);

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // 继续试下一个候选
    }
  }
  return null;
}

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.cross" android:versionCode="7" android:versionName="1.2.3">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34" />
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-permission android:name="com.example.cross.permission.CUSTOM" />
  <application android:label="Cross Check">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
    <activity android:name=".OtherActivity" android:exported="false" />
  </application>
</manifest>
`;

function stripPackage(name, pkg) {
  if (typeof name !== 'string') return name;
  if (name === pkg) return name;
  if (name.startsWith(`${pkg}.`)) return name.slice(pkg.length + 1);
  if (name.startsWith('.')) return name.slice(1);
  return name;
}

test('插件解析的清单事实与 aapt2 独立解析一致', async t => {
  const aapt2 = await firstExisting(AAPT2_CANDIDATES);
  const androidJar = await firstExisting(ANDROID_JAR_CANDIDATES);
  if (!aapt2 || !androidJar) {
    t.skip('本机没有 aapt2 或 android.jar，跳过交叉核对');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'guoluo-apk-cross-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  await writeFile(join(root, 'AndroidManifest.xml'), MANIFEST, 'utf8');
  const apk = join(sourceRoot, 'cross.apk');
  await run(aapt2, ['link', '-o', apk, '-I', androidJar, '--manifest', join(root, 'AndroidManifest.xml')]);
  const { stdout } = await run(aapt2, ['dump', 'badging', apk]);

  const factsLine = /^package: name='([^']*)' versionCode='([^']*)' versionName='([^']*)'/mu.exec(stdout);
  assert.ok(factsLine, 'aapt2 badging 应给出 package 行');
  const [, pkg, versionCode, versionName] = factsLine;
  const declared = {
    package: pkg,
    versionCode: Number(versionCode),
    versionName,
    minSdk: Number(/^minSdkVersion:'(\d+)'/mu.exec(stdout)?.[1]),
    targetSdk: Number(/^targetSdkVersion:'(\d+)'/mu.exec(stdout)?.[1]),
    label: /^application: label='([^']*)'/mu.exec(stdout)?.[1] ?? null,
    permissions: [...stdout.matchAll(/^uses-permission: name='([^']*)'/gmu)].map(match => match[1]).sort(),
    launcher: /^launchable-activity: name='([^']*)'/mu.exec(stdout)?.[1] ?? null,
  };

  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  const { id } = await service.add({ kind: 'local', location: 'cross.apk' });
  const dissected = await service.dissect({ id, rea: false });
  const data = await service.dossier({ id, runId: dissected.runId, kind: 'asset', limit: 1 });
  assert.equal(data.apk.manifestStatus, 'parsed');
  const manifest = data.apk.manifest;

  assert.equal(manifest.package, declared.package);
  assert.equal(manifest.versionCode, declared.versionCode);
  assert.equal(manifest.versionName, declared.versionName);
  assert.equal(manifest.minSdk, declared.minSdk);
  assert.equal(manifest.targetSdk, declared.targetSdk);
  assert.equal(manifest.label, declared.label);
  assert.equal(manifest.permissions.total, declared.permissions.length);
  assert.equal(manifest.activities.total, 2);
  assert.equal(manifest.activityAliases, 0);
  assert.equal(stripPackage(manifest.launcherActivity, declared.package), stripPackage(declared.launcher, declared.package));

  // 清单事实在档案里按页读；权限与活动的完整名字必须与 aapt2 一致。
  const permissionPage = await service.dossier({ id, runId: dissected.runId, kind: 'apk-permission', limit: 50 });
  assert.deepEqual(permissionPage.rows.map(row => row.name).sort(), declared.permissions);
  const activityPage = await service.dossier({ id, runId: dissected.runId, kind: 'apk-activity', limit: 50 });
  assert.deepEqual(activityPage.rows.map(row => row.name).sort(), ['.MainActivity', '.OtherActivity'].sort());
});
