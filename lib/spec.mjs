import { peNameLimit } from './pe.mjs';
import { tokenRows } from './tokens.mjs';

const escape = value => String(value).replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
const evidence = row => (row.line === undefined ? { path: row.path } : { path: row.path, line: row.line });
const pad = (prefix, index) => `${prefix}-${String(index).padStart(2, '0')}`;
const gaps = [
  'CSS 选择器作用域未记录：令牌与规则只按文件与行号定位，无法确定其适用面。',
  '未运行目标应用、未抓取网络请求：交互行为、接口契约与运行时状态不在本批证据内。',
  'ASAR 只盘点头部资产目录：归档成员未解包，成员内容与内部依赖图未读。',
];

function obligationsOf(rows) {
  const list = [];
  const pages = new Map();
  const tokens = tokenRows(rows);
  const routes = new Map();
  const references = new Map();
  let structure = 0;
  let route = 0;
  let reference = 0;
  let asset = 0;
  let file = 0;
  for (const row of rows) {
    if (row.kind === 'page') {
      if (!pages.has(row.path)) {
        structure += 1;
        pages.set(row.path, pad('S', structure));
        list.push({ id: pages.get(row.path), kind: 'structure', target: row.path, requires: '复刻页面的结构层级与元素顺序', status: 'declared', evidence: [evidence(row)] });
      }
    } else if (row.kind === 'navigation') {
      const key = `${row.path}\u0000${row.value}`;
      if (!routes.has(key)) {
        route += 1;
        routes.set(key, true);
        list.push({ id: pad('R', route), kind: 'route', target: row.value, requires: '复刻可导航目标与入口位置', status: 'declared', evidence: [evidence(row)] });
      }
    } else if (row.kind === 'reference') {
      if (!references.has(row.value)) {
        reference += 1;
        references.set(row.value, pad('F', reference));
        list.push({ id: references.get(row.value), kind: 'reference', target: row.value, requires: '落地该外部或相对资源引用', status: 'declared', evidence: [evidence(row)] });
      } else {
        list.find(entry => entry.id === references.get(row.value))?.evidence.push(evidence(row));
      }
    } else if (row.kind === 'asset') {
      asset += 1;
      list.push({ id: pad('A', asset), kind: 'asset', target: row.path, ...(row.sha256 ? { sha256: row.sha256 } : {}), ...(row.archive ? { archive: row.archive } : {}), requires: '取得或重新制作该素材文件', status: 'declared', evidence: [evidence(row)] });
    } else if (row.kind !== 'token') {
      file += 1;
    }
  }
  for (const name of [...tokens.keys()].sort()) {
    const uses = tokens.get(name);
    list.push({
      id: name.replace(/^--/u, 'T-'),
      kind: 'style-token',
      target: name,
      value: uses.at(-1).value,
      requires: '以同名变量复刻该样式值',
      status: 'declared',
      evidence: uses.map(use => (use.line === undefined ? { path: use.path } : { path: use.path, line: use.line })),
    });
  }
  return { list, counts: { structure, 'style-token': tokens.size, route, reference, asset, other: file } };
}

export function buildSpec({ id, runId, run, label, createdAt }) {
  const { list, counts } = obligationsOf(run.rows ?? []);
  const conflicts = [];
  const seen = new Map();
  for (const row of run.rows ?? []) {
    if (row.kind !== 'token') continue;
    const values = seen.get(row.name) ?? new Set();
    values.add(row.value);
    seen.set(row.name, values);
  }
  for (const [name, values] of seen) if (values.size > 1) conflicts.push({ name, values: [...values].slice(0, 8) });
  const unknowns = [...gaps];
  if (run.apk) unknowns.push('APK 只做静态清单解析：未解压资源内容、未校验签名、未运行应用；权限声明与实际行为未验证。');
  if (run.pck) unknowns.push('PCK 只读包头与文件表：未解压条目内容、未解密加密条目、未解析场景与脚本结构、未运行游戏；条目清单不等于运行时资源依赖。');
  if (run.unity) unknowns.push('Unity 读取块信息段（未压缩或 LZ4/LZ4HC）、节点表与可解压的数据区。LZMA/LZHAM 压缩的块、IL2CPP 元数据字段表、资源内部结构与运行时依赖未观测；节点只记录大小、SHA-256、类型魔数与 24 字节前缀，不保存内容。');
  if (run.unity?.some(file => file.headerLayout === 'unverified')) {
    unknowns.push('部分 IL2CPP 文件仅记录声明头长：声明值与已知布局不一致，未核对字段表。');
  }
  if (run.pe) unknowns.push('PE 只解析头部、节表、导入与导出表及 CLR 目录标记：未反编译、未解析资源与证书、未运行二进制；导入函数只登记名称与序号，签名与调用关系未验证。');
  const rea = run.rea ?? null;
  if (!rea || ['off', 'skipped', 'unavailable'].includes(rea.status)) {
    unknowns.push(`未取得 REA 静态分析证据${rea?.reason ? `（${rea.reason}）` : ''}：函数级行为、模块依赖与配置读取不在本批证据内。`);
  } else if (rea.status !== 'analyzed' || rea.binding?.status !== 'verified') {
    unknowns.push(`REA 分析未给出可采信的行为侧证据（状态 ${rea.status}${rea.reason ? `：${rea.reason}` : ''}），相关结论缺失。`);
  }
  const evidenceRea = rea === null ? null : {
    status: rea.status,
    version: rea.version ?? null,
    binding: rea.binding?.status ?? null,
    artifactSha256: rea.artifactSha256 ?? null,
    evidenceId: rea.evidenceId ?? null,
    stats: rea.stats ?? null,
    evidence: rea.evidence ?? null,
    reason: rea.reason ?? null,
  };
  // 规格只回显清单摘要：逐条权限与活动留在本批证据里，由 guoluo_dossier kind=apk-permission / apk-activity 续页读取。
  const apkList = (manifest, field) => {
    if (!manifest) return null;
    const items = Array.isArray(manifest[field]) ? manifest[field] : null;
    const page = manifest[`${field}Page`];
    return {
      total: Number.isSafeInteger(manifest[`${field}Total`]) ? manifest[`${field}Total`] : Number.isSafeInteger(page?.total) ? page.total : items ? items.length : null,
      retained: Number.isSafeInteger(manifest[`${field}Retained`]) ? manifest[`${field}Retained`] : items ? items.length : null,
      truncated: typeof manifest[`${field}Truncated`] === 'boolean' ? manifest[`${field}Truncated`] : typeof page?.truncated === 'boolean' ? page.truncated : null,
      note: manifest[`${field}Note`] ?? null,
    };
  };
  const evidenceApk = run.apk ? {
    package: run.apk.manifest?.package ?? null,
    versionCode: run.apk.manifest?.versionCode ?? null,
    versionName: run.apk.manifest?.versionName ?? null,
    minSdk: run.apk.manifest?.minSdk ?? null,
    targetSdk: run.apk.manifest?.targetSdk ?? null,
    label: run.apk.manifest?.label ?? null,
    launcherActivity: run.apk.manifest?.launcherActivity ?? null,
    manifestStatus: run.apk.manifestStatus ?? null,
    activityAliases: run.apk.manifest?.activityAliases ?? null,
    permissions: apkList(run.apk.manifest, 'permissions'),
    activities: apkList(run.apk.manifest, 'activities'),
    abis: run.apk.abis ?? [],
    counts: run.apk.counts ?? null,
    scanned: run.apk.scanned ?? null,
    scanTruncated: run.apk.scanTruncated ?? null,
  } : null;
  const evidencePe = run.pe ? {
    aliasSlotsNamedLimit: peNameLimit,
    files: run.pe.map(file => file.status === 'unreadable' ? {
      path: file.path,
      status: 'unreadable',
      reason: file.reason ?? null,
      aliasSlots: null,
    } : {
      path: file.path,
      status: 'parsed',
      format: file.format ?? null,
      machine: file.machine ?? null,
      subsystem: file.subsystem ?? null,
      bytes: file.bytes ?? null,
      sectionCount: file.sectionCount ?? null,
      imports: file.imports?.status ?? null,
      dlls: (file.imports?.items ?? []).map(item => item.dll).filter(Boolean),
      namedExports: file.exports?.status === 'unreadable' ? null : file.exports?.namedCount ?? null,
      aliasSlots: file.exports?.status === 'unreadable' ? null : file.exports?.aliasSlots ?? null,
      clr: file.clr === true,
    }),
  } : null;
  const evidencePck = run.pck ? {
    engine: run.pck.engine ?? null,
    packFormat: run.pck.packFormat ?? null,
    counts: run.pck.counts ?? null,
    directoryStatus: run.pck.directoryStatus ?? 'legacy-unverified',
    declaredBytes: run.pck.declaredBytes ?? null,
  } : null;
  return {
    spec: {
      schemaVersion: 2,
      id,
      runId,
      generatedAt: createdAt,
      source: run.source,
      label,
      evidence: { totals: run.totals, coverage: run.coverage, meter: run.meter ?? null, rea: evidenceRea, apk: evidenceApk, pck: evidencePck, pe: evidencePe, unity: run.unity ?? null },
      obligations: list,
      counts,
      conflicts,
      unknowns,
    },
    counts,
    conflicts,
  };
}

export function renderSpecMarkdown({ spec, notes }) {
  const lines = [
    `# 复刻规格 · ${escape(spec.label)}`,
    '',
    `- 档案：\`${spec.id}\``,
    `- 批次：\`${spec.runId}\``,
    `- 素材：\`${escape(spec.source)}\``,
    `- 生成时间：${spec.generatedAt}`,
    `- 复刻义务：${spec.obligations.length} 项`,
    '',
    '## 1 证据范围',
    '',
    '| 项目 | 数值 |',
    '| --- | --- |',
  ];
  const totals = spec.evidence.totals ?? {};
  for (const key of Object.keys(totals).sort()) lines.push(`| ${key} | ${totals[key]} |`);
  const coverage = spec.evidence.coverage ?? {};
  for (const key of Object.keys(coverage).sort()) {
    const value = coverage[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) lines.push(`| coverage.${key} | ${value} |`);
  }
  const meter = spec.evidence.meter;
  if (meter) lines.push(`| 盘点耗时 | ${meter.durationMs} ms |`);
  if (spec.evidence.rea) {
    const rea = spec.evidence.rea;
    lines.push(`| REA 状态 | ${rea.status}${rea.version ? `（${rea.version}）` : ''} |`);
    lines.push(`| REA 绑定 | ${rea.binding ?? '无'} |`);
    if (rea.artifactSha256) lines.push(`| REA 根哈希 | ${rea.artifactSha256} |`);
    if (rea.stats?.parsed_javascript_files !== undefined) lines.push(`| REA 已解析 JS 文件 | ${rea.stats.parsed_javascript_files} |`);
  }
  if (spec.evidence.apk) {
    const apk = spec.evidence.apk;
    lines.push(`| APK 清单状态 | ${escape(apk.manifestStatus ?? '未知')} |`);
    lines.push(`| APK 包名 | ${escape(apk.package ?? '未知')} |`);
    lines.push(`| APK 版本 | ${escape(apk.versionName ?? '未知')}（${escape(String(apk.versionCode ?? '未知'))}） |`);
    lines.push(`| APK SDK | min ${escape(String(apk.minSdk ?? '未知'))} / target ${escape(String(apk.targetSdk ?? '未知'))} |`);
    lines.push(`| APK 启动入口 | ${escape(apk.launcherActivity ?? '未声明')} |`);
    if (apk.abis.length) lines.push(`| APK 原生 ABI | ${escape(apk.abis.join(', '))} |`);
    if (apk.scanned !== null) lines.push(`| APK 扫描条目 | ${apk.scanned}${apk.scanTruncated ? '（受预算截断）' : ''} |`);
    if (apk.counts) lines.push(`| APK 条目 / dex / so / 签名 | ${apk.counts.entries} / ${apk.counts.dex} / ${apk.counts.libs} / ${apk.counts.signatures} |`);
    if (apk.permissions && apk.permissions.retained !== null) lines.push(`| APK 权限 | 共 ${escape(String(apk.permissions.total ?? '未知'))} 条，已保留 ${apk.permissions.retained} 条${apk.permissions.truncated ? '（其余需重新盘点）' : ''} |`);
    if (apk.activities && apk.activities.retained !== null) lines.push(`| APK 活动 | 共 ${escape(String(apk.activities.total ?? '未知'))} 条，已保留 ${apk.activities.retained} 条${apk.activities.truncated ? '（其余需重新盘点）' : ''} |`);
  }
  if (spec.evidence.pck) {
    const pck = spec.evidence.pck;
    lines.push(`| PCK 引擎 | ${escape(pck.engine ?? '未知')} |`);
    if (pck.packFormat) lines.push(`| PCK 包格式 | ${pck.packFormat} |`);
    lines.push(`| PCK 文件目录 | ${pck.directoryStatus} |`);
    if (pck.counts) lines.push(`| PCK 条目 / 加密 / 场景 / 脚本 / 资源 | ${pck.counts.entries} / ${pck.counts.encrypted ?? '未知'} / ${pck.counts.scenes ?? '未知'} / ${pck.counts.scripts ?? '未知'} / ${pck.counts.resources ?? '未知'} |`);
  }
  for (const file of spec.evidence.unity ?? []) {
    let detail = file.reason;
    if (file.status === 'header-read') {
      if (file.format === 'unityfs') {
        const header = `UnityFS ${file.formatVersion} / ${file.unityRevision}`;
        detail = file.nodes && file.blocks
          ? `${header} / UnityFS 节点 ${file.nodes.count} / 块 ${file.blocks.count}`
          : `${header} / ${file.reason ?? `块信息 ${file.blocksInfo.compression}，块表与节点表未观测。`}`;
        if (file.nodes?.truncated || file.blocks?.truncated) detail += `（明细列出 ${file.nodes.returned} 个节点、${file.blocks.returned} 个块）`;
        const payload = file.payload;
        if (payload?.status === 'parsed') {
          detail += ` / 载荷 ${payload.nodes.length} 个节点 ${payload.bytes} 字节${payload.truncated ? `（节点明细仅列前 ${payload.nodeLimit} 个）` : ''}`;
        } else if (payload?.status === 'failed') detail += ` / 载荷解析失败：${payload.reason ?? '原因未知'}`;
        else detail += ` / 载荷跳过：${payload?.reason ?? '原因未知'}`;
      } else {
        detail = `IL2CPP 声明版本 ${file.metadataVersion}${file.headerBytes ? ` / 声明头长 ${file.headerBytes} 字节` : ''}`;
        if (file.headerLayout === 'unverified') detail += ` / ${file.reason}`;
      }
    }
    lines.push(`| Unity ${escape(file.path)} | ${escape(detail)} |`);
  }
  lines.push('');

  const sections = [
    ['structure', '结构（页面）', '页面文件', 'target'],
    ['style-token', '样式令牌', '令牌', 'target'],
    ['route', '路由与导航', '目标', 'target'],
    ['reference', '资源引用', '引用值', 'target'],
    ['asset', '静态素材', '文件', 'target'],
  ];
  let index = 2;
  for (const [kind, title, column, field] of sections) {
    const subset = spec.obligations.filter(entry => entry.kind === kind);
    lines.push(`## ${index} ${title}（${subset.length}）`, '');
    index += 1;
    if (!subset.length) { lines.push('本类无证据。', ''); continue; }
    lines.push(`| 编号 | ${column} | 值 | 证据 |`, '| --- | --- | --- | --- |');
    for (const entry of subset) {
      const where = entry.evidence.map(item => item.line === undefined ? item.path : `${item.path}:${item.line}`).slice(0, 4).join('<br>');
      lines.push(`| ${entry.id} | ${escape(entry[field])} | ${escape(entry.value ?? '')} | ${escape(where)} |`);
    }
    lines.push('');
  }

  if (spec.evidence.pe?.files?.length) {
    lines.push(`## ${index} 原生二进制（PE，${spec.evidence.pe.files.length}）`, '');
    lines.push(`别名槽位按前 ${spec.evidence.pe.aliasSlotsNamedLimit} 个命名导出统计。至少两个不同槽位记录同一非零 RVA 时计为一组。`, '');
    lines.push('| 文件 | 格式 | 架构 | 子系统 | 节数 | 导入 DLL | 命名导出 | 别名槽位 | CLR |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const file of spec.evidence.pe.files) {
      if (file.status === 'unreadable') {
        lines.push(`| ${escape(file.path)} | 不可读 | — | — | — | — | — | — | — |`);
        continue;
      }
      lines.push(`| ${escape(file.path)} | ${escape(file.format ?? '未知')} | ${escape(file.machine ?? '未知')} | ${escape(file.subsystem ?? '未知')} | ${escape(String(file.sectionCount ?? '未知'))} | ${escape(file.dlls.length ? file.dlls.join(', ') : '未登记')} | ${escape(file.namedExports === null ? '不可读' : String(file.namedExports))} | ${escape(file.aliasSlots ?? '未观测')} | ${file.clr ? '声明' : '无'} |`);
    }
    lines.push('');
    index += 1;
  }

  if (spec.conflicts.length) {
    lines.push(`## ${index} 令牌冲突（${spec.conflicts.length}）`, '', '| 令牌 | 出现过的值 |', '| --- | --- |');
    for (const entry of spec.conflicts) lines.push(`| ${escape(entry.name)} | ${escape(entry.values.join(' / '))} |`);
    lines.push('');
    index += 1;
  }

  lines.push(`## ${index} 缺口与未知（${spec.unknowns.length}）`, '');
  for (const gap of spec.unknowns) lines.push(`- ${gap}`);
  lines.push('');
  index += 1;

  if (notes?.length) {
    lines.push(`## ${index} 盘点说明`, '');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}
