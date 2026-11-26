/**
 * client.js —— 复刻工作台的浏览器半端。
 *
 * 不是 ESM：DSH 的 client bundle 是自注册脚本，模块图由宿主的 __ModuleLoader__ 管。
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 注册两处，缺一处就没有入口：
 *   · sidebar.panellist（id guoluo）—— 侧栏那个按钮
 *   · main（keyed guoluo）        —— 主区整页，key 与侧栏 id 对齐
 *
 * 数据全走 GET /api/guoluo/*，与 guoluo_workbench 工具同一份只读投影。
 * 这里不写档案、不碰素材根、不执行素材脚本：面板只显示已经落盘的证据。
 */
window.__ModuleLoader__.load({
  id: '@zhuifengqug/dsh-guoluo',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo } = React;

    const API = '/api/guoluo';
    const KINDS = ['asset', 'token', 'navigation', 'reference'];

    /* 必须看 res.ok：把 500 的 {ok:false} 当成功渲染，故障会被绿色提示盖掉。 */
    const asJson = async (res) => {
      if (res.ok) return res.json();
      const why = res.status === 403 ? '（被宿主拦了）' : res.status === 404 ? '（宿主还没起这个口子）' : '';
      throw new Error(`HTTP ${res.status}${why}`);
    };
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }));

    const CSS = `
[data-gl-shell]{display:flex;flex-direction:column;gap:14px;padding:18px 20px 28px;max-width:1180px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
[data-gl-head]{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
[data-gl-title]{font-size:15px;font-weight:600}
[data-gl-sub]{color:var(--dsw-alias-label-secondary);font-size:12px}
[data-gl-spacer]{flex:1}
[data-gl-btn]{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer}
[data-gl-btn]:hover{border-color:var(--dsw-alias-brand-primary)}
[data-gl-btn][disabled]{opacity:.55;cursor:default}
[data-gl-btn][data-on]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
[data-gl-body]{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:16px;align-items:start}
[data-gl-list]{display:flex;flex-direction:column;gap:4px;border-right:1px solid var(--dsw-alias-border-l1);padding-right:12px;min-height:80px}
[data-gl-item]{text-align:left;appearance:none;border:1px solid transparent;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);padding:7px 9px;border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:2px}
[data-gl-item]:hover{background:var(--dsw-alias-bg-layer-1)}
[data-gl-item][data-on]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
[data-gl-item-name]{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-gl-item-meta]{color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;gap:6px}
[data-gl-stage]{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font-size:10px;color:var(--dsw-alias-label-secondary)}
[data-gl-stage="packed"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
[data-gl-stage="checked"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
[data-gl-stage="scaffolded"]{color:var(--dsw-alias-brand-primary);border-color:currentColor}
[data-gl-stage="specified"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
[data-gl-stage="registered"]{color:var(--dsw-alias-state-idle-primary);border-color:currentColor}
[data-gl-detail]{display:flex;flex-direction:column;gap:12px;min-width:0}
[data-gl-h]{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
[data-gl-kv]{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;font-size:12px}
[data-gl-kv] dt{color:var(--dsw-alias-label-secondary)}
[data-gl-kv] dd{margin:0;overflow-wrap:anywhere}
[data-gl-table]{width:100%;border-collapse:collapse;font-size:12px}
[data-gl-table] th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);padding:3px 8px 3px 0}
[data-gl-table] td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:3px 8px 3px 0;vertical-align:top}
[data-gl-table] td[data-gl-num]{text-align:right;font-variant-numeric:tabular-nums}
[data-gl-rows]{max-height:340px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px}
[data-gl-row]{display:grid;grid-template-columns:1fr max-content;gap:10px;padding:3px 8px;font-size:11.5px;border-bottom:1px solid var(--dsw-alias-border-l1)}
[data-gl-row]:last-child{border-bottom:0}
[data-gl-row] span:first-child{overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
[data-gl-row] span:last-child{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
[data-gl-note]{font-size:12px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px}
[data-gl-warn]{color:var(--dsw-alias-state-warn-primary)}
[data-gl-error]{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
[data-gl-empty]{color:var(--dsw-alias-label-secondary);font-size:12px;padding:14px 0}
[data-gl-toolbar]{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
[data-gl-icon]{display:block;width:16px;height:16px}
@media (max-width:820px){[data-gl-body]{grid-template-columns:1fr}[data-gl-list]{border-right:0;padding-right:0;flex-direction:row;flex-wrap:wrap}}
`;

    function StyleTag() {
      return h('style', null, CSS);
    }

    function StageBadge({ stage }) {
      return h('span', { 'data-gl-stage': stage ?? 'registered' }, stage ?? 'registered');
    }

    function Row({ label, value }) {
      if (value === null || value === undefined || value === '') return null;
      return h(React.Fragment, null,
        h('dt', null, label),
        h('dd', null, String(value)));
    }

    function ArtifactTable({ artifacts }) {
      const names = Object.keys(artifacts ?? {});
      if (!names.length) return h('div', { 'data-gl-empty': '' }, '这个档案还没有任何产物目录。');
      return h('table', { 'data-gl-table': '' },
        h('thead', null, h('tr', null,
          h('th', null, '目录'), h('th', { 'data-gl-num': '' }, '条数'), h('th', null, '最新一条'))),
        h('tbody', null, names.map((name) => h('tr', { key: name },
          h('td', null, name),
          h('td', { 'data-gl-num': '' }, String(artifacts[name]?.entries ?? 0)),
          h('td', null, artifacts[name]?.newest ?? '—')))));
    }

    function TotalsTable({ totals, coverage }) {
      const rows = Object.entries(totals ?? {});
      if (!rows.length) return null;
      return h('table', { 'data-gl-table': '' },
        h('thead', null, h('tr', null, h('th', null, '证据种类'), h('th', { 'data-gl-num': '' }, '条数'))),
        h('tbody', null, rows.map(([key, value]) => h('tr', { key },
          h('td', null, key), h('td', { 'data-gl-num': '' }, String(value))))),
        coverage ? h('tbody', null, h('tr', null,
          h('td', null, 'coverage.assets'),
          h('td', { 'data-gl-num': '' },
            `${coverage.assets?.present ?? 0}/${coverage.assets?.total ?? 0}，缺 ${coverage.assets?.missing ?? 0}`))) : null);
    }

    function EvidenceBrowser({ project, runId }) {
      const [kind, setKind] = useState('asset');
      const [offset, setOffset] = useState(0);
      const [page, setPage] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);

      const load = useCallback(async (nextKind, nextOffset) => {
        if (!project?.id) return;
        setBusy(true); setError('');
        try {
          const query = new URLSearchParams({ id: project.id, kind: nextKind, offset: String(nextOffset), limit: '20' });
          if (runId) query.set('runId', runId);
          setPage(await jget(`/evidence?${query}`));
          setKind(nextKind);
          setOffset(nextOffset);
        } catch (e) { setError(String(e?.message ?? e)); setPage(null); }
        finally { setBusy(false); }
      }, [project?.id, runId]);

      useEffect(() => { setPage(null); setOffset(0); load('asset', 0); }, [load]);

      const rows = page?.rows ?? [];
      return h('div', null,
        h('div', { 'data-gl-h': '' }, '证据浏览'),
        h('div', { 'data-gl-toolbar': '' },
          KINDS.map((name) => h('button', {
            key: name, type: 'button', 'data-gl-btn': '', 'data-on': kind === name ? '' : undefined,
            onClick: () => load(name, 0), disabled: busy,
          }, name)),
          h('span', { 'data-gl-sub': '' },
            page ? `${page.returned ?? rows.length} / ${page.total ?? '?'} 条${page.nextOffset !== null && page.nextOffset !== undefined ? '（还有下一页）' : ''}` : '')),
        error ? h('div', { 'data-gl-error': '' }, error) : null,
        rows.length
          ? h('div', { 'data-gl-rows': '' }, rows.map((row, index) => h('div', { key: index, 'data-gl-row': '' },
            h('span', null, row.path ?? row.name ?? row.id ?? JSON.stringify(row).slice(0, 160)),
            h('span', null, row.type ?? row.kind ?? row.bytes ?? ''))))
          : h('div', { 'data-gl-empty': '' }, busy ? '读证据…' : '这一类没有证据行。'),
        page && (page.nextOffset !== null && page.nextOffset !== undefined)
          ? h('div', { 'data-gl-toolbar': '' },
            h('button', { type: 'button', 'data-gl-btn': '', disabled: busy || offset === 0, onClick: () => load(kind, Math.max(0, offset - 20)) }, '上一页'),
            h('button', { type: 'button', 'data-gl-btn': '', disabled: busy, onClick: () => load(kind, page.nextOffset) }, '下一页'))
          : null,
        page?.note ? h('div', { 'data-gl-note': '' }, page.note) : null);
    }

    function ProjectDetail({ id, onError }) {
      const [detail, setDetail] = useState(null);
      const [error, setError] = useState('');

      useEffect(() => {
        let live = true;
        setDetail(null); setError('');
        jget(`/project?id=${encodeURIComponent(id)}`)
          .then((data) => { if (live) setDetail(data); })
          .catch((e) => { if (live) { setError(String(e?.message ?? e)); onError?.(String(e?.message ?? e)); } });
        return () => { live = false; };
      }, [id, onError]);

      if (error) return h('div', { 'data-gl-error': '' }, error);
      if (!detail) return h('div', { 'data-gl-empty': '' }, '读档案…');
      const project = detail.project ?? {};
      const latest = detail.latestRun ?? null;
      return h('div', { 'data-gl-detail': '' },
        h('div', { 'data-gl-toolbar': '' },
          h('span', { 'data-gl-title': '' }, project.label ?? project.id),
          h(StageBadge, { stage: project.stage })),
        h('div', null,
          h('div', { 'data-gl-h': '' }, '档案'),
          h('dl', { 'data-gl-kv': '' },
            h(Row, { label: 'ID', value: project.id }),
            h(Row, { label: '类型', value: project.kind }),
            h(Row, { label: '素材', value: project.location }),
            h(Row, { label: '登记', value: project.createdAt }),
            h(Row, { label: '批次', value: `${project.runCount ?? 0} 批${project.running ? '（有盘点在跑）' : ''}` }),
            h(Row, { label: '最近批次', value: project.latest }))),
        h('div', null,
          h('div', { 'data-gl-h': '' }, '产物'),
          h(ArtifactTable, { artifacts: project.artifacts })),
        latest
          ? h('div', null,
            h('div', { 'data-gl-h': '' }, '最近一批证据'),
            h('dl', { 'data-gl-kv': '' },
              h(Row, { label: '生成', value: latest.createdAt }),
              h(Row, { label: 'REA', value: latest.rea?.status ? `${latest.rea.status}${latest.rea.version ? ` ${latest.rea.version}` : ''}` : null }),
              h(Row, { label: '耗时', value: latest.meter?.durationMs ? `${latest.meter.durationMs} ms` : null }),
              h(Row, { label: '行数', value: latest.meter?.rows ?? null })),
            h(TotalsTable, { totals: latest.totals, coverage: latest.coverage }),
            latest.notes?.length
              ? h('ul', { 'data-gl-note': '' }, latest.notes.map((note, index) => h('li', { key: index }, note)))
              : null)
          : null,
        project.latest ? h(EvidenceBrowser, { project, runId: project.latest }) : null,
        detail.next?.length
          ? h('div', null,
            h('div', { 'data-gl-h': '' }, '下一步'),
            h('ul', { 'data-gl-note': '' }, detail.next.map((line, index) => h('li', { key: index }, line))))
          : null);
    }

    function WorkbenchPanel() {
      const [overview, setOverview] = useState(null);
      const [error, setError] = useState('');
      const [selected, setSelected] = useState(null);
      const [busy, setBusy] = useState(false);

      const refresh = useCallback(async () => {
        setBusy(true); setError('');
        try {
          const data = await jget('/overview');
          setOverview(data);
          const first = data.projects?.[0]?.id ?? null;
          setSelected((current) => (current && data.projects?.some((p) => p.id === current) ? current : first));
        } catch (e) { setError(String(e?.message ?? e)); }
        finally { setBusy(false); }
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      const projects = overview?.projects ?? [];
      const counts = overview?.counts ?? null;
      const summaryLine = useMemo(() => {
        if (!counts) return '';
        return Object.entries(counts).filter(([, n]) => n > 0).map(([stage, n]) => `${stage} ${n}`).join(' · ');
      }, [counts]);

      return h('div', { 'data-gl-shell': '' },
        h(StyleTag, null),
        h('div', { 'data-gl-head': '' },
          h('span', { 'data-gl-title': '' }, '复刻工作台'),
          h('span', { 'data-gl-sub': '' }, overview?.version ? `v${overview.version}` : ''),
          h('span', { 'data-gl-spacer': '' }),
          summaryLine ? h('span', { 'data-gl-sub': '' }, summaryLine) : null,
          h('button', { type: 'button', 'data-gl-btn': '', onClick: refresh, disabled: busy }, busy ? '读…' : '刷新')),
        error ? h('div', { 'data-gl-error': '' }, error) : null,
        overview?.status === 'unconfigured'
          ? h('div', { 'data-gl-note': '', 'data-gl-warn': '' },
            `${overview.reason ?? '素材根或档案根不可用。'}${overview.note ? ` ${overview.note}` : ''}`)
          : null,
        overview?.status === 'ready' && !projects.length
          ? h('div', { 'data-gl-empty': '' },
            '还没有档案。先在对话里登记素材：guoluo_target_add（本地目录用素材根内的相对路径），再 guoluo_run 出包；回来点「刷新」。')
          : null,
        projects.length
          ? h('div', { 'data-gl-body': '' },
            h('div', { 'data-gl-list': '' }, projects.map((project) => h('button', {
              key: project.id, type: 'button', 'data-gl-item': '',
              'data-on': selected === project.id ? '' : undefined,
              onClick: () => setSelected(project.id),
            },
              h('span', { 'data-gl-item-name': '' }, project.label ?? project.id),
              h('span', { 'data-gl-item-meta': '' },
                h('span', { 'data-gl-stage': project.stage ?? 'registered' }, project.stage ?? 'registered'),
                h('span', null, `${project.runCount ?? 0} 批`))))),
            selected
              ? h(ProjectDetail, { id: selected, onError: setError })
              : h('div', { 'data-gl-empty': '' }, '从左边挑一个档案。'))
          : null,
        h('div', { 'data-gl-sub': '' },
          '只读投影：数据与 guoluo_* 工具同源。工作台不写档案、不执行素材脚本。'));
    }

    // 侧栏图标：描边 currentColor，跟宿主那几个图标同一套语言。
    function SidebarEntry() {
      return h('span', { title: '复刻工作台', 'aria-label': '复刻工作台', role: 'img', 'data-gl-icon': '' },
        h('svg', {
          viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true',
        },
        h('path', { d: 'M2.2 12.6V6.1l4.2-2.4 3.6 2.1' }),
        h('path', { d: 'M9.9 12.6V8.3l3.9-2.2v6.5' }),
        h('path', { d: 'M2.2 12.6h11.6' }),
        h('circle', { cx: 6.4, cy: 9.2, r: 1.5 })));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        const cleanups = [];
        const reg = (key, make) => {
          try {
            slots.inject(key, () => {
              const dispose = make();
              cleanups.push(dispose);
              return dispose;
            });
          } catch { /* 这个宿主没有这个槽位：少一处入口，不要把整页带崩 */ }
        };
        reg('main', () => slots.register({ name: 'main', key: 'guoluo', label: '复刻工作台' }, WorkbenchPanel));
        reg('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: 'guoluo', order: 90, label: '复刻工作台',
        }, SidebarEntry));
        ctx.effect?.(() => () => {
          for (const fn of [...cleanups].reverse()) { try { fn?.(); } catch { /* 已经没了 */ } }
        }, 'guoluo: slots');
      },
    };
  },
});