// 上下文压缩压测 · 主脚本
// 用法：
//   npm run bench:context                # 离线模式：生成素材 + 模拟压缩调度（零 API 成本，校验实验设计）
//   npm run bench:context -- --online    # 在线模式：开/关压缩两臂真实对照（需要可用的模型 API key）
//   可选参数：--seed N --exchanges N --window N --pct N --keep N --every N --model id
//
// 实验设计：
//   - 素材：scripts/bench/fixtures.ts 确定性生成长对话（事实标记随机，模型无法靠先验猜中）
//   - 两臂：ON = 每轮回放后按"模拟窗口 × pct"触发 compactSession（复用 server/compact.ts 真实实现）；
//           OFF = 从不压缩，上下文自然增长
//   - 检查点：每 every 轮回收一次已埋事实（真实 API 调用），判分 = 字符串命中（见 score.ts）
//   - 溢出语义：模拟小窗口（--window），上下文超过窗口的请求判"溢出失败"不再真实调用
//     （ON 臂镜像 agentLoop 的溢出恢复：强制压缩 keep=6 后重试一次）
//   - 指标：事实命中率（随检查点衰减曲线）、检查点真实 input tokens、压缩次数、溢出次数
//
// 输出：scripts/bench/out/run-<时间戳>/results.json + report.md

import { generateText } from 'ai'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  compactSession, contextUsage, estimateTokens, computeKeepFrom, COMPACT_RETAIN_PCT,
} from '../../server/compact.js'
import { createModel } from '../../server/models.js'
import type { Agent, Session, Message } from '../../server/types.js'
import { buildFixtures, type Fixture, type BenchMessage } from './fixtures.js'
import { scoreConstraints, mdTable, pct, factHit } from './score.js'

// ---------- 配置 ----------
interface BenchConfig {
  online: boolean
  seed: number
  exchanges: number
  window: number // 模拟窗口（tokens）：ON 臂压缩触发线 + OFF 臂溢出判定线
  pct: number // 压缩阈值（窗口百分比），对齐 NOVA_AGENT_COMPACT_PCT
  keep: number // 压缩保留条数，对齐 NOVA_AGENT_COMPACT_KEEP
  min: number // 消息数兜底门槛（0 = 不启用，隔离 token 阈值机制；生产默认 40）
  every: number // 检查点间隔（exchange 数）
  model: string
}

function parseArgs(argv: string[]): BenchConfig {
  const cfg: BenchConfig = {
    online: argv.includes('--online'),
    seed: 20260101,
    exchanges: 70,
    window: 1536,
    pct: 90,
    keep: 12,
    min: 0,
    every: 25,
    model: 'deepseek/deepseek-v4-flash',
  }
  const num = (name: string, cur: number) => {
    const i = argv.indexOf(name)
    return i >= 0 ? Number(argv[i + 1]) || cur : cur
  }
  cfg.seed = num('--seed', cfg.seed)
  cfg.exchanges = num('--exchanges', cfg.exchanges)
  cfg.window = num('--window', cfg.window)
  cfg.pct = num('--pct', cfg.pct)
  cfg.keep = num('--keep', cfg.keep)
  cfg.min = num('--min', cfg.min)
  cfg.every = num('--every', cfg.every)
  const mi = argv.indexOf('--model')
  if (mi >= 0 && argv[mi + 1]) cfg.model = argv[mi + 1]
  return cfg
}

// ---------- 结果结构 ----------
export interface CheckpointResult {
  exchange: number // 检查点位置（已回放轮数）
  askedFacts: number // 本次回收的事实数
  hitFacts: number
  hitPct: string
  contextTokens: number // 检查点时的上下文估算 tokens
  inputTokens: number // 本次检查点请求的真实 input tokens（0 = 溢出未调用）
  compactionsSoFar: number
  overflowed: boolean // 模拟窗口判定溢出（OFF 臂死因 / ON 臂触发恢复）
  recovered: boolean // ON 臂溢出恢复成功
  answer: string
}

export interface ArmResult {
  arm: 'on' | 'off'
  scenario: string
  checkpoints: CheckpointResult[]
  compactions: number
  summarizeEstTokens: number // 压缩总结的估算 token 成本（真实 API 未返回 usage，按素材估算）
  totalCheckpointInput: number // 全部检查点请求的真实 input tokens 合计
  overflowCount: number
  finalHitPct: string // 最后一个检查点的命中率
  constraintHits: Array<{ kind: string; payload: string; hit: boolean }>
  error?: string
}

export interface RunResult {
  config: BenchConfig
  date: string
  arms: ArmResult[]
}

// ---------- 工具 ----------
const PERSONA = '你是严谨的测试助手，只依据对话历史回答问题，不编造。'

function mkSession(fixture: Fixture): Session {
  return { id: 'bench', agentId: 'bench', title: fixture.title, messages: [], createdAt: 0, updatedAt: 0 }
}

function mkAgent(model: string): Agent {
  return { id: 'bench', name: 'bench', persona: PERSONA, model, mcpServerIds: [], skillIds: [], color: '#000', createdAt: 0 }
}

/** 把消息数组按"一轮 = 一对 user/assistant"切成 exchanges */
function toExchanges(messages: BenchMessage[]): BenchMessage[][] {
  const pairs: BenchMessage[][] = []
  for (let i = 0; i + 1 < messages.length; i += 2) pairs.push([messages[i], messages[i + 1]])
  return pairs
}

/** 模拟窗口下的压缩触发判断（镜像 agentLoop：token 阈值为主；--min N 可启用消息数兜底） */
function shouldCompactSim(messages: Message[], cfg: BenchConfig): boolean {
  if (cfg.min > 0 && messages.length > cfg.min) return true
  if (!messages.length) return false
  return contextUsage(messages) > (cfg.window * cfg.pct) / 100
}

/** 一次"带摘要注入"的模型请求（system 组装方式与 agentLoop.ts 保持一致） */
async function askWithSession(session: Session, agent: Agent, question: string, model: string) {
  const summaryBlock = session.summary
    ? `\n\n---\n\n# 历史对话摘要\n以下是对较早对话的压缩摘要，请基于它继续，不要重复已确认的内容：\n${session.summary}`
    : ''
  const system = `${agent.persona}${summaryBlock}`
  return generateText({
    model: createModel(model),
    system,
    messages: [
      ...session.messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: question },
    ],
  })
}

/** 检查点提问：OFF 臂超窗直接判溢出（省 API 费）；ON 臂镜像溢出恢复（强制压缩 keep=6 重试一次） */
async function askCheckpoint(
  session: Session, agent: Agent, question: string, arm: 'on' | 'off', cfg: BenchConfig,
): Promise<{ answer: string; inputTokens: number; overflowed: boolean; recovered: boolean; summarizeEst: number; compacted: number }> {
  const probe: Message = { id: 'probe', role: 'user', content: question, createdAt: 0 }
  const used = contextUsage([...session.messages, probe])
  if (used > cfg.window) {
    if (arm === 'off') return { answer: '', inputTokens: 0, overflowed: true, recovered: false, summarizeEst: 0, compacted: 0 }
    // ON 臂溢出恢复：强制压缩腾空间再重试（对齐 agentLoop OVERFLOW_COMPACT_KEEP=6）
    const cres = await compactSession(session, agent, { force: true, keep: 6, window: cfg.window })
    const summarizeEst = cres ? cres.removed : 0
    const r = await askWithSession(session, agent, question, cfg.model)
    const usage = await r.usage
    return { answer: r.text, inputTokens: usage.inputTokens ?? 0, overflowed: true, recovered: true, summarizeEst, compacted: cres ? 1 : 0 }
  }
  const r = await askWithSession(session, agent, question, cfg.model)
  const usage = await r.usage
  return { answer: r.text, inputTokens: usage.inputTokens ?? 0, overflowed: false, recovered: false, summarizeEst: 0, compacted: 0 }
}

// ---------- 单臂运行 ----------
async function runArm(fixture: Fixture, arm: 'on' | 'off', cfg: BenchConfig): Promise<ArmResult> {
  const session = mkSession(fixture)
  const agent = mkAgent(cfg.model)
  const pairs = toExchanges(fixture.messages)
  const result: ArmResult = {
    arm, scenario: fixture.scenario, checkpoints: [],
    compactions: 0, summarizeEstTokens: 0, totalCheckpointInput: 0, overflowCount: 0,
    finalHitPct: '—', constraintHits: [],
  }
  const answers: string[] = []

  try {
    for (let e = 0; e < pairs.length; e++) {
      session.messages.push(...pairs[e].map((m, i) => ({
        id: `x${e}-${i}`, role: m.role, content: m.content, createdAt: 0,
      })))

      // ON 臂：每轮回放后按模拟窗口检查自动压缩（镜像 agentLoop turn 开始前检查）。
      // force=true 绕过 compactSession 内置的 40 条门槛——bench 自己决定何时压缩，
      // 以隔离"token 阈值"这一个变量（生产里该门槛由 shouldCompact 与 token 阈值取或）。
      if (arm === 'on' && shouldCompactSim(session.messages, cfg)) {
        const r = await compactSession(session, agent, { force: true, window: cfg.window, keep: cfg.keep })
        if (r) {
          result.compactions += 1
          result.summarizeEstTokens += r.removed // 粗略估算：被压缩消息数 ≈ 被总结 tokens 量级（详见报告说明）
        }
      }

      // 检查点：每 every 轮 + 最后一轮
      const isCheckpoint = (e + 1) % cfg.every === 0 || e === pairs.length - 1
      if (!isCheckpoint) continue

      // 组检查点提问
      let question: string
      let askedFacts: typeof fixture.facts = []
      if (fixture.scenario === 'constraint') {
        const isFinal = e === pairs.length - 1
        question = isFinal
          ? '请先逐条复述之前约定的编码规范（原样引用函数前缀和库名），然后完成下面的任务并遵守规范：\n' + fixture.finalTask
          : '请逐条复述之前约定的编码规范，原样写出其中的函数命名前缀和日期库名。'
      } else {
        askedFacts = fixture.facts.filter((f) => f.turnIndex <= e)
        question =
          '请仅依据上面的对话内容回答下面的问题，逐条作答，不知道就写"对话中未提及"：\n' +
          askedFacts.map((f, k) => `${k + 1}) ${f.question}`).join('\n')
      }

      const cp = await askCheckpoint(session, agent, question, arm, cfg)
      result.compactions += cp.compacted
      result.summarizeEstTokens += cp.summarizeEst
      result.overflowCount += cp.overflowed && !cp.recovered ? 1 : 0
      if (!cp.overflowed || cp.recovered) {
        result.totalCheckpointInput += cp.inputTokens
        answers.push(cp.answer)
      }

      const hit = askedFacts.filter((f) => factHit(cp.answer, f.marker)).length
      result.checkpoints.push({
        exchange: e + 1,
        askedFacts: askedFacts.length,
        hitFacts: hit,
        hitPct: pct(hit, askedFacts.length),
        contextTokens: contextUsage(session.messages),
        inputTokens: cp.inputTokens,
        compactionsSoFar: result.compactions,
        overflowed: cp.overflowed,
        recovered: cp.recovered,
        answer: cp.answer.slice(0, 400),
      })
    }
  } catch (err) {
    result.error = (err as Error).message
  }

  // 约束场景：对全部回答统一判分
  if (fixture.scenario === 'constraint') {
    result.constraintHits = scoreConstraints(answers, fixture.constraints)
  }
  const lastCp = result.checkpoints[result.checkpoints.length - 1]
  if (lastCp && fixture.facts.length) {
    // "最后检查点当场命中率"：只看最后一个检查点在该时刻上下文下的表现。
    // 不做跨检查点并集——并集会把早期（未压缩时）答对的事实算进来，掩盖压缩衰减。
    if (lastCp.overflowed && !lastCp.recovered) result.finalHitPct = '溢出'
    else {
      const asked = fixture.facts.filter((f) => f.turnIndex <= lastCp.exchange - 1)
      const hits = asked.filter((f) => factHit(lastCp.answer, f.marker)).length
      result.finalHitPct = pct(hits, asked.length)
    }
  }
  return result
}

// ---------- 离线模式：素材校验 + 压缩调度模拟（零 API 成本） ----------
function offlineSim(fixture: Fixture, cfg: BenchConfig) {
  const messages: Message[] = [] // 从空开始逐轮回放（与在线臂一致）
  const events: Array<{ exchange: number; action: string; contextTokens: number; dropped: number }> = []
  let compactions = 0
  let droppedTotal = 0
  const pairs = toExchanges(fixture.messages)
  for (let e = 0; e < pairs.length; e++) {
    for (const m of pairs[e]) messages.push({ id: `${e}-${m.role}`, role: m.role, content: m.content, createdAt: 0 })
    if (shouldCompactSim(messages, cfg)) {
      const keepCount = Math.min(cfg.keep, messages.length - 1)
      const retainBudget = (cfg.window * COMPACT_RETAIN_PCT) / 100
      const keepFrom = computeKeepFrom(messages, keepCount, retainBudget)
      const dropped = keepFrom > 0 ? keepFrom : 0
      if (dropped > 0) {
        compactions += 1
        droppedTotal += dropped
        events.push({ exchange: e + 1, action: 'compact', contextTokens: contextUsage(messages), dropped })
        messages.splice(0, dropped)
      }
    }
    if ((e + 1) % cfg.every === 0 || e === pairs.length - 1) {
      events.push({ exchange: e + 1, action: 'checkpoint', contextTokens: contextUsage(messages), dropped: 0 })
    }
  }
  return { events, compactions, droppedTotal, finalTokens: contextUsage(messages), totalTokens: estimateTokens(fixture.messages.map((m) => m.content).join('')) }
}

// ---------- 报告 ----------
export function buildReport(results: RunResult, fixtures: Fixture[]): string {
  const c = results.config
  const lines: string[] = []
  lines.push('# 上下文压缩压测报告')
  lines.push('')
  lines.push(`- 日期：${results.date}`)
  lines.push(`- 模型：${c.model}　模式：${c.online ? '在线（真实 API 两臂对照）' : '离线（素材与调度模拟，零 API 成本）'}`)
  lines.push(`- 模拟窗口：${c.window} tokens　压缩阈值：${c.pct}%　保留条数：${c.keep}　检查点间隔：${c.every} 轮　种子：${c.seed}`)
  lines.push(`- 溢出语义：上下文超过模拟窗口的检查点请求判溢出（OFF 臂记失败；ON 臂强制压缩 keep=6 后重试一次）`)
  lines.push(`- 压缩成本说明：compactSession 的总结调用真实发生（在线模式），其 token 成本按被压缩消息数估算记录`)
  lines.push('')
  lines.push('## 素材')
  lines.push('')
  lines.push(mdTable(
    ['场景', '消息数', '事实数', '约束数'],
    fixtures.map((f) => [f.scenario, f.messages.length, f.facts.length, f.constraints.length]),
  ))
  lines.push('')
  for (const f of fixtures) {
    lines.push(`### ${f.scenario} — ${f.title}`)
    lines.push('')
    const armRows = results.arms.filter((a) => a.scenario === f.scenario)
    if (armRows.every((a) => a.checkpoints.length === 0)) continue
    lines.push(mdTable(
      ['臂', '检查点@轮', '已问事实', '命中', '命中率', '上下文 tokens(估)', '请求 input tokens(真)', '压缩累计', '溢出'],
      armRows.flatMap((a) => a.checkpoints.map((cp) => [
        a.arm, cp.exchange, cp.askedFacts, cp.hitFacts, cp.hitPct, cp.contextTokens, cp.inputTokens, cp.compactionsSoFar,
        cp.overflowed ? (cp.recovered ? '溢出→已恢复' : '溢出失败') : '—',
      ])),
    ))
    lines.push('')
    const on = armRows.find((a) => a.arm === 'on')
    const off = armRows.find((a) => a.arm === 'off')
    lines.push(mdTable(
      ['指标', 'ON（开压缩）', 'OFF（关压缩）'],
      [
        ['最后检查点当场命中率', on?.finalHitPct ?? '—', off?.finalHitPct ?? '—'],
        ['检查点真实 input tokens 合计', on?.totalCheckpointInput ?? '—', off?.totalCheckpointInput ?? '—'],
        ['压缩次数', on?.compactions ?? '—', off?.compactions ?? '—'],
        ['溢出次数', on?.overflowCount ?? '—', off?.overflowCount ?? '—'],
        ...(f.scenario === 'constraint' ? [[
          '约束命中',
          on?.constraintHits.map((h) => `${h.kind}:${h.hit ? '✔' : '✘'}`).join(' ') || '—',
          off?.constraintHits.map((h) => `${h.kind}:${h.hit ? '✔' : '✘'}`).join(' ') || '—',
        ]] : []),
        ['错误', on?.error ?? '—', off?.error ?? '—'],
      ],
    ))
    lines.push('')
  }
  return lines.join('\n')
}

// ---------- 主流程 ----------
async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  const fixtures = buildFixtures({ seed: cfg.seed, exchanges: cfg.exchanges })
  const results: RunResult = { config: cfg, date: new Date().toISOString(), arms: [] }

  if (!cfg.online) {
    console.log('== 离线模式：素材校验 + 压缩调度模拟（零 API 成本）==\n')
    for (const f of fixtures) {
      const sim = offlineSim(f, cfg)
      console.log(`[${f.scenario}] ${f.title}`)
      console.log(`  消息 ${f.messages.length} 条 / 全文估算 ${sim.totalTokens} tokens`)
      console.log(`  模拟窗口 ${cfg.window}×${cfg.pct}%：压缩 ${sim.compactions} 次，累计移除 ${sim.droppedTotal} 条，终态 ${sim.finalTokens} tokens`)
      for (const ev of sim.events) console.log(`  - @轮${ev.exchange} ${ev.action} ctx=${ev.contextTokens}${ev.dropped ? ` dropped=${ev.dropped}` : ''}`)
      console.log()
    }
    console.log('素材校验通过后，加 --online 跑真实两臂对照（会产生少量 API 费用）。')
    return
  }

  console.log(`== 在线模式：两臂对照（模型 ${cfg.model}，窗口 ${cfg.window}）==`)
  for (const f of fixtures) {
    console.log(`\n[${f.scenario}] 运行中...`)
    const armOn = await runArm(f, 'on', cfg)
    const armOff = await runArm(f, 'off', cfg)
    results.arms.push(armOn, armOff)
    console.log(`  ON : 命中 ${armOn.finalHitPct} / 压缩 ${armOn.compactions} 次 / 溢出 ${armOn.overflowCount} / input ${armOn.totalCheckpointInput}`)
    console.log(`  OFF: 命中 ${armOff.finalHitPct} / 压缩 ${armOff.compactions} 次 / 溢出 ${armOff.overflowCount} / input ${armOff.totalCheckpointInput}`)
  }

  const outDir = join(process.cwd(), 'scripts', 'bench', 'out', `run-${Date.now()}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
  writeFileSync(join(outDir, 'report.md'), buildReport(results, fixtures), 'utf8')
  console.log(`\n结果已写入 ${outDir}`)
}

// 仅直接运行时执行（rescore.ts 会 import 本文件复用 buildReport，不能触发压测）
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/bench/run.ts')) {
  main().catch((err) => {
    console.error('[bench] 失败:', err.message)
    process.exit(1)
  })
}
