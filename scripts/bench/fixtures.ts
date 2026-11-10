// 上下文压缩压测 · 确定性素材生成器
// 设计要点：
// 1. 种子固定 → 同参数永远生成同一对话（实验可复现、可回归）
// 2. 事实"标记"由种子随机生成（如"玄武-47"）→ 模型无法凭先验知识猜中，
//    只能从上下文里记住——回答中出现标记即判定命中，判分完全确定（字符串匹配，不用 LLM 当裁判）
// 3. 三种场景：
//    - fact-recall：对话中埋 K 个关键事实，检查点回收 → 测"压缩后还记得多少"
//    - constraint：早期立编码约定，收尾任务验证是否遵守 → 测"约束在压缩后是否存活"
//    - overflow：超长对话（配合小窗口模拟）→ 测"关压缩何时溢出、开压缩是否恢复"
// 4. 对话主题固定为虚构项目"星图数据平台"（填充对话有实际内容，避免摘要引擎轻易丢弃）

export type Role = 'user' | 'assistant'
export interface BenchMessage {
  role: Role
  content: string
}

/** 埋入对话的关键事实（marker 是判分依据，也是标准答案） */
export interface PlantedFact {
  id: string
  kind: 'codename' | 'budget' | 'deadline' | 'owner' | 'port' | 'version'
  marker: string // 唯一标记，如 "玄武-47" / "3.2 万元" / "6月18日"
  sentence: string // 埋入对话的原句
  question: string // 检查点的回收提问
  turnIndex: number // 埋在第几个 exchange（0 起；越大越"深"= 越早被压缩掉）
}

export type Scenario = 'fact-recall' | 'constraint' | 'overflow'

/** 可确定性判分的编码约定（constraint 场景） */
export interface Constraint {
  kind: 'fn-prefix' | 'lib-must'
  text: string // 约定的自然语言（对话中出现）
  payload: string // 判分依据：函数名前缀 / 必须提到的库名
}

export interface Fixture {
  scenario: Scenario
  title: string
  messages: BenchMessage[] // 主体对话（不含检查点提问）
  facts: PlantedFact[]
  constraints: Constraint[]
  finalTask: string // constraint 场景的收尾任务
  recallQuestions: string // fact/overflow 场景的全量回收提问
}

// ---------- 种子随机（mulberry32：小、快、分布够用，零依赖） ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

// ---------- 事实标记生成（随机代号/金额/日期…，防模型靠先验猜中） ----------
const CODE_NAMES = ['玄武', '朱雀', '青龙', '白虎', '麒麟', '勾陈', '腾蛇', '凤凰', '天璇', '摇光', '开阳', '玉衡', '紫微', '文曲'] as const
const OWNERS = ['林晚舟', '沈星河', '顾清野', '陆知遥', '江叙白', '周砚秋'] as const
const LIBS = ['zod', 'dayjs', 'nanoid', 'mitt', 'ky'] as const
const FN_PREFIXES = ['nova', 'astro', 'stellar', 'orbit', 'quasar'] as const

function mkFact(rng: () => number, kind: PlantedFact['kind'], turnIndex: number): PlantedFact {
  const id = `f${turnIndex}`
  switch (kind) {
    case 'codename': {
      const marker = `${pick(rng, CODE_NAMES)}-${10 + Math.floor(rng() * 90)}`
      return {
        id, kind, marker, turnIndex,
        sentence: `对了，项目内部代号定为「${marker}」，后续所有文档、分支名都用这个代号。`,
        question: '本项目的内部代号是什么？',
      }
    }
    case 'budget': {
      const marker = `${(1 + Math.floor(rng() * 90) / 10).toFixed(1)} 万元`
      return {
        id, kind, marker, turnIndex,
        sentence: `另外预算批下来了：整个二期投入上限 ${marker}，超了要重新审批。`,
        question: '二期的预算上限是多少？',
      }
    }
    case 'deadline': {
      const month = 1 + Math.floor(rng() * 12)
      const day = 1 + Math.floor(rng() * 28)
      const marker = `${month}月${day}日`
      return {
        id, kind, marker, turnIndex,
        sentence: `和客户对过了，一期验收时间定在 ${marker}，之前所有功能要冻结。`,
        question: '一期验收的时间定在哪天？',
      }
    }
    case 'owner': {
      const marker = pick(rng, OWNERS)
      return {
        id, kind, marker, turnIndex,
        sentence: `数据接入这块以后由 ${marker} 负责，有问题直接找他，不用过项目经理。`,
        question: '数据接入模块的负责人是谁？',
      }
    }
    case 'port': {
      const marker = String(2000 + Math.floor(rng() * 8000))
      return {
        id, kind, marker, turnIndex,
        sentence: `内部网关端口固定用 ${marker}，别用默认的 8080，会跟测试环境冲突。`,
        question: '内部网关的端口号是多少？',
      }
    }
    case 'version': {
      const marker = `v${1 + Math.floor(rng() * 3)}.${Math.floor(rng() * 10)}`
      return {
        id, kind, marker, turnIndex,
        sentence: `协议版本就锁 ${marker} 了，客户端和服务端都按这个版本来，不再往上追新。`,
        question: '锁定的协议版本是哪个？',
      }
    }
  }
}

// ---------- 填充对话（虚构项目"星图数据平台"的例行讨论） ----------
const FILLER_PAIRS: Array<[string, string]> = [
  ['数据接入的批处理昨天跑完了，全量大概两千万条，有没有遇到脏数据？', '跑完了。脏数据大概千分之三，主要是字段缺失和编码问题，已进隔离表，清洗任务今天补跑。'],
  ['可视化那边产品想要下钻到省一级，现在的聚合粒度够吗？', '够。预聚合表已经到区县粒度了，下钻只是前端交互改动，后端不用动。'],
  ['登录态最近老掉，用户反馈半小时就要重新登一次。', '查了下是网关的会话超时配置没同步，改完应该就好，今天发版。'],
  ['缓存命中率最近掉到 70% 了，什么原因？', '新增了几个长尾查询把热点挤掉了，准备给长尾查询单独加一层本地缓存。'],
  ['部署脚本能不能加个回滚？上次发版出问题手动回滚太慢。', '可以，保留上一版本的镜像，脚本加一个 rollback 子命令，一条命令切回去。'],
  ['监控大盘上错误率那条线怎么断断续续的？', '采集端有个实例重启过，时间序列有空洞，补了采集间隔的兜底逻辑，以后不会断。'],
  ['新来的实习生问代码规范文档在哪，发他一份？', '在仓库 docs/ 目录下，另外让他先看贡献指南，环境搭建那节有常见问题。'],
  ['压测报告出来了，P99 在 180ms 左右，达标了吗？', '达标。SLA 定的是 250ms，还有余量；瓶颈现在在数据库连接池，后续可以再优化。'],
  ['权限系统要不要支持临时授权？运营那边经常要短期开个账号。', '支持，加一个过期时间的授权类型，到期自动回收，不用手动清理。'],
  ['日志体积涨得太快，磁盘快满了。', '把 debug 级别改成采样写入，再加一个 7 天滚动清理，体积能降一半以上。'],
]

function fillerExchange(rng: () => number, i: number): BenchMessage[] {
  const [u, a] = FILLER_PAIRS[i % FILLER_PAIRS.length]
  // 少量补充句增加长度方差（摘要引擎面对的长度更真实）
  const extras = [
    '补充一句，相关的变更记录都写在周报里了。',
    '细节我整理成了 checklist，回头发到群里。',
    '这块的取舍讨论过两次，结论都在会议纪要里。',
    '如果后面要改，提前一天在群里说一声。',
    '相关数据我拉了个表，随时可以复查。',
  ]
  const extra = rng() < 0.5 ? ` ${pick(rng, extras)}` : ''
  return [
    { role: 'user', content: u },
    { role: 'assistant', content: a + extra },
  ]
}

// ---------- 场景生成器 ----------
export interface FixtureOptions {
  seed?: number
  exchanges?: number // 主体对话的轮数（一轮 = 一对 user/assistant）
  facts?: number // 埋入的事实数
}

const DEFAULTS = { seed: 20260101, exchanges: 70, facts: 6 }
const FACT_KINDS: PlantedFact['kind'][] = ['codename', 'budget', 'deadline', 'owner', 'port', 'version']

/** 事实保持场景：K 个事实散布在前 60% 对话里，结尾全量回收 */
export function generateFactRecall(opts?: FixtureOptions): Fixture {
  const { seed, exchanges, facts } = { ...DEFAULTS, ...opts }
  const rng = mulberry32(seed)
  const messages: BenchMessage[] = [
    { role: 'user', content: '我们开始做"星图数据平台"二期，先同步一些关键信息，你记一下。' },
    { role: 'assistant', content: '好的，我在听，关键信息我会逐条确认。' },
  ]

  // 事实散布在第 1 ~ exchanges*0.6 轮（越早越深，越晚被压缩波及）
  const factsToPlant = Math.min(facts, FACT_KINDS.length)
  const deepEnd = Math.max(factsToPlant + 2, Math.floor(exchanges * 0.6))
  const factTurns = new Set<number>()
  for (let k = 0; k < factsToPlant; k++) {
    const idx = 1 + Math.round((k * (deepEnd - 2)) / (factsToPlant - 1))
    factTurns.add(idx)
  }

  const factsOut: PlantedFact[] = []
  for (let i = 0; i < exchanges; i++) {
    if (factTurns.has(i) && factsOut.length < factsToPlant) {
      const f = mkFact(rng, FACT_KINDS[factsOut.length], i)
      factsOut.push(f)
      messages.push({ role: 'user', content: f.sentence })
      messages.push({ role: 'assistant', content: `已记录：${f.sentence.replace(/^对了，/, '').replace(/^另外/, '')}` })
    } else {
      messages.push(...fillerExchange(rng, i))
    }
  }

  const recallLines = factsOut.map((f, k) => `${k + 1}) ${f.question}`).join('\n')
  const recallQuestions =
    '请仅依据上面的对话内容回答下面的问题，逐条作答，不知道就写"对话中未提及"：\n' + recallLines

  return {
    scenario: 'fact-recall',
    title: `事实保持（${factsToPlant} 个事实 × ${exchanges} 轮）`,
    messages, facts: factsOut, constraints: [], finalTask: '', recallQuestions,
  }
}

/** 约束遵守场景：早期立两条可确定性判分的编码约定，收尾任务验证 */
export function generateConstraint(opts?: FixtureOptions): Fixture {
  const { seed, exchanges } = { ...DEFAULTS, ...opts }
  const rng = mulberry32(seed)
  const prefix = pick(rng, FN_PREFIXES)
  const lib = pick(rng, LIBS)
  const constraints: Constraint[] = [
    { kind: 'fn-prefix', text: `第一，所有新增函数的命名必须以 "${prefix}_" 作为前缀，比如 "${prefix}_parseRow"。`, payload: `${prefix}_` },
    { kind: 'lib-must', text: `第二，日期处理统一用 ${lib} 这个库，不要再引入别的日期库。`, payload: lib },
  ]

  const messages: BenchMessage[] = [
    { role: 'user', content: '接下来我们一起开发"星图数据平台"的调度模块。开工前先约定两条编码规范，后面所有代码都要遵守。' },
    { role: 'assistant', content: '好的，两条规范我记下了，后面写代码会严格遵守。' },
    { role: 'user', content: constraints[0].text },
    { role: 'assistant', content: `明确：函数命名一律带 "${prefix}_" 前缀。` },
    { role: 'user', content: constraints[1].text },
    { role: 'assistant', content: `明确：日期处理统一用 ${lib}。` },
  ]
  for (let i = 0; i < exchanges; i++) messages.push(...fillerExchange(rng, i))

  const finalTask =
    `请根据之前约定的编码规范，实现一个工具函数 ${prefix}_formatUptime(seconds: number)，` +
    `把秒数格式化成 "X 天 X 小时 X 分" 的字符串（用之前约定的日期库处理换算），并给出简要实现说明。`

  return {
    scenario: 'constraint',
    title: `约束遵守（前缀 ${prefix}_ · 库 ${lib}）`,
    messages, facts: [], constraints, finalTask, recallQuestions: '',
  }
}

/** 超窗场景：超长对话（配合压测的小窗口模拟），用于溢出/恢复对照 */
export function generateOverflow(opts?: FixtureOptions): Fixture {
  const base = generateFactRecall({ ...opts, exchanges: Math.max(opts?.exchanges ?? 200, 200), facts: 3 })
  return { ...base, scenario: 'overflow', title: `超窗溢出（${base.messages.length} 条消息）` }
}

/** 一次实验的全部素材（固定组合，方便报告引用统一配置） */
export function buildFixtures(opts?: { seed?: number; exchanges?: number }): Fixture[] {
  return [
    generateFactRecall(opts),
    generateConstraint(opts),
    generateOverflow(opts),
  ]
}

// 直接运行时打印素材统计（npm run bench:fixtures）——零 API 成本校验素材
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/bench/fixtures.ts')) {
  for (const f of buildFixtures()) {
    const chars = f.messages.reduce((s, m) => s + m.content.length, 0)
    console.log(`[${f.scenario}] ${f.title}: ${f.messages.length} 条消息 / ${chars} 字符 / 事实 ${f.facts.length} 个`)
    for (const fact of f.facts) console.log(`  - ${fact.id} @轮${fact.turnIndex}: ${fact.marker}`)
    for (const c of f.constraints) console.log(`  - 约束 ${c.kind}: ${c.payload}`)
  }
}
