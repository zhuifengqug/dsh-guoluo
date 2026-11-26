// 集中提问：把证据里「必须由人拍板」的事挑出来，一次问清。
//
// 只问两类问题：证据无法决定的选择（栈、素材处置、命名），以及静态解析明确
// 够不到的地方（原生二进制、缺失文件、令牌冲突）。能靠证据自己定的不进来——
// 问得越多，用户越不想答。
//
// 问题 key 稳定（按规则固定，不随证据条数变化），所以重新生成时旧答案能对上。

export const questionsSchemaVersion = 1;

const listedEvidence = 6;

function slug(value, fallback) {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return text.length >= 2 ? text.slice(0, 48) : fallback;
}

function question(key, topic, ask, why, suggested, options, evidence = []) {
  return { key, topic, question: ask, why, suggested, options, evidence: evidence.slice(0, listedEvidence) };
}

// 技术栈只能从静态证据判断到「有没有页面/样式/打包产物」这一层；
// 判断依据一并写进问题，免得用户以为这是猜的。
export function inferStack(counts, totals, run = {}) {
  const pages = Number(counts.asset ?? 0) > 0 ? countPages(run) : 0;
  const styles = Number(counts['style-token'] ?? 0);
  if (run?.unity) return { kind: 'unity', label: 'Unity 打包应用', basis: '批次里带 UnityFS 块表与节点证据。' };
  if (run?.pck) return { kind: 'godot', label: 'Godot PCK 打包应用', basis: '批次里带 PCK 包头与文件表。' };
  if (run?.apk) return { kind: 'apk', label: 'Android 安装包', basis: '批次里带 APK 清单证据。' };
  if (run?.pe) return { kind: 'pe', label: '原生可执行程序', basis: '批次里带 PE 头、节表与导入导出表。' };
  if (styles > 0 && pages > 0) return { kind: 'web', label: '网页（HTML + 样式表）', basis: `证据里有 ${pages} 个页面与 ${styles} 个样式令牌。` };
  if (pages > 0) return { kind: 'html', label: '网页（HTML，无独立样式表）', basis: `证据里有 ${pages} 个页面，但没有 CSS 令牌。` };
  const libraries = Number(totals?.byType?.library ?? 0);
  if (libraries > 0) return { kind: 'bundle', label: '打包型应用（库 + 资源清单）', basis: `证据里有 ${libraries} 个库文件，没有可解析的 HTML/CSS。` };
  return { kind: 'unknown', label: '无法从静态证据判断', basis: '证据里既没有页面，也没有可识别的库或打包结构。' };
}

function countPages(run) {
  const rows = Array.isArray(run?.rows) ? run.rows : [];
  return rows.filter(row => row?.kind === 'asset' && (row.type === 'page' || row.type === 'style')).length;
}

export function buildQuestions({ id, runId, spec, run, answers = {}, generatedAt }) {
  const counts = spec?.counts ?? {};
  const totals = spec?.evidence?.totals ?? run?.totals ?? {};
  const coverage = spec?.evidence?.coverage ?? run?.coverage ?? {};
  const stack = inferStack(counts, totals, run);
  const list = [];

  list.push(question(
    'stack',
    'stack',
    `首版把「${spec?.label ?? id}」复刻成哪套技术栈？`,
    `静态证据只能判断到「${stack.label}」这一层（${stack.basis}），用哪种实现属于你的选择，证据不决定。`,
    stack.kind === 'web' || stack.kind === 'html' ? '静态 HTML + CSS，一页一页重建' : '先只做静态骨架，跑通结构再决定框架',
    ['静态 HTML + CSS', 'React + Vite', 'Vue + Vite', '沿用原栈自行搭'],
    [stack.label],
  ));

  const missing = Number(coverage.missing ?? 0);
  if (missing > 0) {
    const paths = (Array.isArray(run?.rows) ? run.rows : [])
      .filter(row => row?.kind === 'asset' && row.missing)
      .map(row => row.path);
    list.push(question(
      'missing',
      'missing',
      `有 ${missing} 个文件属于静态解析够不到的类型，怎么处理？`,
      '这些文件只登记了路径、字节与指纹，没有被复制进骨架，也没有被解析；它们要么留成缺口，要么由你补等价物。',
      '先留缺口，等复刻到那一步再单独处理',
      ['留缺口并写进验收说明', '我手工补等价文件', '换成我能合法使用的资源'],
      paths,
    ));
  }

  const tokenCount = Number(counts['style-token'] ?? 0);
  const conflicts = Array.isArray(spec?.conflicts) ? spec.conflicts : [];
  if (conflicts.length > 0) {
    list.push(question(
      'tokens-conflict',
      'tokens',
      `主题令牌有 ${conflicts.length} 处同名不同值，以哪一份为准？`,
      '同名令牌取到多个值，说明样式里有条件覆盖或按页面的主题；挑一份当基准，另一份要写进差异说明。',
      '以出现次数最多的那份为准',
      ['以出现次数最多的为准', '按页面分别保留', '我指定一份基准'],
      conflicts.map(conflict => typeof conflict === 'string' ? conflict : `${conflict.name ?? '?'} = ${JSON.stringify(conflict.values ?? conflict.value ?? null)}`),
    ));
  } else if (tokenCount === 0) {
    list.push(question(
      'tokens-source',
      'tokens',
      '没解析到样式令牌，主题色与字体从哪来？',
      '证据里没有 CSS 自定义属性，颜色和字体没有可继承的基准，只能由你定或从素材里取。',
      '先从品牌图里取主色，其余留空',
      ['我指定主色与字体', '从素材里取色', '先留空，样式后面再调'],
    ));
  }

  const assets = Number(totals?.asset ?? 0);
  if (assets >= 200) {
    const images = Number(totals?.byType?.image ?? 0);
    list.push(question(
      'assets',
      'assets',
      `证据里有 ${assets} 个资产（其中 ${images} 个图片），复刻工程怎么用它们？`,
      '逐字节沿用最忠实，但会把原项目的素材整包搬进你的工程；重画更干净，但要另算工作量。',
      '关键界面用原素材，其余重画',
      ['原样沿用全部素材', '只沿用界面相关素材', '全部重画'],
    ));
  }

  const natives = Number(totals?.byType?.executable ?? 0) + Number(totals?.byType?.library ?? 0) + Number(totals?.byType?.other ?? 0);
  if (natives > 0) {
    list.push(question(
      'native',
      'native',
      `有 ${natives} 个原生或二进制文件不在静态解析范围内，首版要不要覆盖它们？`,
      '这些文件没有函数级证据：调用关系、配置读取与运行时行为都没观测到，照抄文件不等于复刻行为。',
      '首版只覆盖界面与静态资源，原生部分写进后续范围',
      ['首版只做界面与静态资源', '原生部分也要覆盖，另开一轮分析'],
    ));
  }

  list.push(question(
    'name',
    'naming',
    '复刻工程叫什么名字？',
    '生成目录、包名与页面标题都用这个名字，先定下来省得后面改名。',
    slug(spec?.label ?? id, 'rebuild'),
    [],
    [id],
  ));

  const answerMap = {};
  for (const entry of list) {
    const recorded = answers?.[entry.key];
    if (recorded && typeof recorded.answer === 'string') {
      answerMap[entry.key] = { answer: recorded.answer, at: recorded.at ?? null };
    }
  }
  return {
    schemaVersion: questionsSchemaVersion,
    id,
    runId,
    generatedAt,
    stack,
    questions: list.map(entry => ({ ...entry, answer: answerMap[entry.key]?.answer ?? null, answeredAt: answerMap[entry.key]?.at ?? null })),
    answers: answerMap,
    open: list.filter(entry => !answerMap[entry.key]).map(entry => entry.key),
  };
}

export function applyAnswer(state, { key, answer, at }) {
  if (typeof key !== 'string' || !state.questions.some(entry => entry.key === key)) {
    throw Object.assign(new Error(`没有这个问题：${key ?? '（空）'}。可答的有：${state.questions.map(entry => entry.key).join('、')}。`), { kind: 'invalid-input' });
  }
  if (typeof answer !== 'string' || !answer.trim().length) {
    throw Object.assign(new Error('答案不能是空的。'), { kind: 'invalid-input' });
  }
  if (answer.length > 2000) throw Object.assign(new Error('答案超过 2000 字，请分条说明。'), { kind: 'invalid-input' });
  const answers = { ...state.answers, [key]: { answer: answer.trim(), at } };
  return {
    ...state,
    answers,
    questions: state.questions.map(entry => entry.key === key ? { ...entry, answer: answers[key].answer, answeredAt: at } : entry),
    open: state.questions.filter(entry => !answers[entry.key]).map(entry => entry.key),
  };
}