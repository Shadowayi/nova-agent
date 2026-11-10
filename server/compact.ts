// 上下文压缩：真实 summarization（LLM 总结旧消息）+ 自动触发策略
import { generateText } from 'ai'
import type { Agent, Message, Session } from './types.js'
import { createModel, resolveModel } from './models.js'

// 策略参数（可用环境变量覆盖）
export const COMPACT_MIN_MESSAGES = Number(process.env.NOVA_AGENT_COMPACT_MIN ?? 40) // 消息数兜底：超过该条数强制压缩（与 token 阈值双条件）
export const COMPACT_KEEP = Number(process.env.NOVA_AGENT_COMPACT_KEEP ?? 20) // 保留最近 N 条消息
// 保留预算比例：保留的近期消息，其文本估算 token 不超过 窗口 × 该比例（借鉴 DSH retainRatio，默认 0.16）
export const COMPACT_RETAIN_PCT = Math.min(100, Math.max(1, Number(process.env.NOVA_AGENT_COMPACT_RETAIN_PCT ?? 16)))
// 保留条数下限：预算再紧也要保住至少这么多条（保证模型有上下文可依）
export const COMPACT_MIN_KEEP = Number(process.env.NOVA_AGENT_COMPACT_MIN_KEEP ?? 5)
const SUMMARY_MAX_CHARS = 2000 // 摘要长度上限（字符）
const DEFAULT_CONTEXT_WINDOW = 1_000_000 // 模型上下文缺省值（主流模型普遍 1M）
// 自动压缩阈值：上下文用量的百分比（成熟项目做法：接近上限才压；Claude Code 默认 ~95%）
// 可用 NOVA_AGENT_COMPACT_PCT 覆盖（1-100）
export const COMPACT_PCT = Math.min(100, Math.max(1, Number(process.env.NOVA_AGENT_COMPACT_PCT ?? 90)))

// ---------- 工具结果修剪（借鉴 DSH dsh-compaction-tool-result-pruner） ----------
// 超大工具输出是撑爆上下文的主要来源之一。模型侧只喂修剪版（head + 标记 + tail），
// 完整输出保留在工具记录里供前端展示/轨迹回放。
// 阈值/头/尾按"Unicode 码点"计数（不拆代理对）；默认 8192 → 4096 + 1024，与 DSH 一致。
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
export const PRUNE_THRESHOLD_CHARS = Math.max(1, Number(process.env.NOVA_AGENT_PRUNE_THRESHOLD ?? 8192))
export const PRUNE_HEAD_CHARS = Math.max(0, Number(process.env.NOVA_AGENT_PRUNE_HEAD ?? 4096))
export const PRUNE_TAIL_CHARS = Math.max(0, Number(process.env.NOVA_AGENT_PRUNE_TAIL ?? 1024))

/** Unicode 码点长度（Array.from 不拆代理对，区别于 .length） */
function codePointLength(text: string): number {
  return Array.from(text).length
}

/** 修剪超长文本：head + 标记 + tail。未超阈值时原样返回 */
export function maybePruneToolOutput(text: string): string {
  const len = codePointLength(text)
  if (len <= PRUNE_THRESHOLD_CHARS) return text
  const pts = Array.from(text)
  const headEnd = Math.min(PRUNE_HEAD_CHARS, len)
  const tailStart = Math.max(headEnd, len - PRUNE_TAIL_CHARS)
  return pts.slice(0, headEnd).join('') + PRUNE_MARKER + pts.slice(tailStart).join('')
}

// ---------- 上下文溢出检测（借鉴 DSH dsh-llm 的 isContextWindowExceededError） ----------
// 各 provider 对"请求超过上下文窗口"的措辞五花八门，这里覆盖常见模式，
// 用于"溢出 → 自动压缩 → 重试一次"的恢复路径（区别于前端只翻译提示）。
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i,
  /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i,
  /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i,
  /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i,
  /\btoo\s+large\s+for\s+context\b/i,
]

/** 判断错误信息是否属于"上下文窗口被超出"（含 cause 链，走 1-2 层） */
export function isContextWindowExceededError(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 3 && current != null; depth++) {
    const text = current instanceof Error ? current.message : String(current)
    if (CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text))) return true
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined
  }
  return false
}

// 会话当前上下文占用（真实计数优先）：
// 最后一条带 tokens 的 assistant 消息的 input 是"那次请求的完整输入"（API 真实计数，含全部历史），
// 以其为基准 + 其后新增消息的估算
export function contextUsage(messages: Array<{ role: string; content: string; tokens?: { input?: number; output?: number } }>): number {
  let base = 0
  let baseIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.tokens && (m.tokens.input ?? 0) > 0) {
      base = m.tokens.input ?? 0
      baseIdx = i
    }
  }
  let used = base
  for (let i = baseIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.tokens) used += (m.tokens.output ?? 0)
    else used += estimateTokens(m.content)
  }
  return used
}

// 文本 token 估算：中文约 0.7 token/字，其他约 0.25 token/字符（user 消息无真实计数）
export function estimateTokens(text: string): number {
  let cn = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cn++
    else other++
  }
  return Math.ceil(cn * 0.7 + other / 4)
}

// 上下文窗口兜底：非法值（0/负数/非数字）回退缺省，防止进度条/压缩阈值异常
export function sanitizeContextWindow(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONTEXT_WINDOW
}

// 当前模型的上下文窗口（models.json 注册表内置；未配/非法 → 缺省 1M）
export function contextWindowFor(model: string): number {
  const resolved = resolveModel(model)
  const entry = resolved?.provider.models.find((m) => m.id === resolved.modelId)
  return sanitizeContextWindow(entry?.contextWindow)
}

export interface CompactResult {
  summary: string
  removed: number
  kept: number
}

/** 压缩选项：force = 忽略消息数门槛（溢出恢复用）；keep = 覆盖保留条数（溢出恢复用更少）；
 *  window = 覆盖模型窗口（压测/模拟小窗口用，缺省走 models.json 注册表） */
export interface CompactOptions {
  force?: boolean
  keep?: number
  window?: number
}

// 用 LLM 把一批消息总结成摘要（结构化提示词，输出纯文本）。
// priorSummary：上一版摘要（滚动摘要）。二次及以后的压缩必须把旧摘要与新压缩的消息
// 合并成一份新摘要——否则旧摘要被整体覆盖，其中只有旧摘要才知道的事实会永久丢失
// （压测实测：fact-recall 场景二次压缩后当场命中率 100% → 50%，见 scripts/bench/）。
export async function summarizeMessages(messages: Message[], model: string, priorSummary?: string): Promise<string> {
  // 构造对话文本：只保留角色与内容（工具调用细节省略，保留关键结果）
  const transcript = messages
    .map((m) => {
      const header = m.role === 'user' ? '用户' : '助手'
      let body = m.content || '(无文本)'
      if (m.toolCalls?.length) {
        const calls = m.toolCalls
          .map((c) => `  - 调用了工具 ${c.name}${c.status === 'error' ? '（失败）' : ''}`)
          .join('\n')
        body += `\n${calls}`
      }
      return `## ${header}\n${body}`
    })
    .join('\n\n')
    .slice(-30000) // 截断超长输入，防止超出模型上下文

  // 滚动摘要：旧摘要作为独立段落放在新增对话之前，要求合并继承
  const prompt = priorSummary
    ? `## 此前摘要（更早对话的压缩记录，其中所有关键事实必须保留）\n${priorSummary}\n\n## 新增对话\n${transcript}`
    : transcript

  const rules = [
    '1. 保留：用户的目标与需求、关键事实/决定、已完成的工作、未完成或待办事项、重要数据与结论',
    '2. 省略：寒暄、重复内容、工具调用的机械细节（但记录关键结果）',
  ]
  if (priorSummary) {
    rules.push('3. 输入包含「此前摘要」时：新摘要必须继承其中的全部关键事实（代号/数字/日期/人名/约定/决定等），再合并新增对话的关键信息——绝不允许只总结新增对话而丢弃此前摘要的内容')
  }
  rules.push(`${rules.length + 1}. 使用与对话相同的语言；以"对话摘要："开头`)
  rules.push(`${rules.length + 1}. 总长度不超过 ${SUMMARY_MAX_CHARS} 字符，直接输出摘要正文，不要解释`)

  const { text } = await generateText({
    model: createModel(model),
    system: '你是对话摘要引擎。请把用户提供的对话记录压缩成一份简洁的上下文摘要，供后续对话继续使用。要求：\n' + rules.join('\n'),
    prompt,
  })

  const summary = text.trim()
  return summary.length > SUMMARY_MAX_CHARS ? summary.slice(0, SUMMARY_MAX_CHARS) : summary
}

// 判断是否需要压缩：消息条数超限（保守兜底）或 当前上下文占用超过窗口 × COMPACT_PCT%
export function shouldCompact(session: Session, model?: string): boolean {
  if (session.messages.length > COMPACT_MIN_MESSAGES) return true
  if (!model || !session.messages.length) return false
  const window = contextWindowFor(model)
  return contextUsage(session.messages) > (window * COMPACT_PCT) / 100
}

// 纯函数：计算"保留起点"（从该下标起保留到末尾）。
// 输入：消息列表 + 目标保留条数 + 保留预算（token）。约束：
//  1) 最多保留最近 keepCount 条；
//  2) 若这些条估算 token 超 retainBudget，把最旧的保留消息并入压缩范围，但至少保留 COMPACT_MIN_KEEP 条。
// 返回 -1 表示没有可压缩的旧消息（全都要保留）。
export function computeKeepFrom(messages: Array<{ content: string }>, keepCount: number, retainBudget: number): number {
  if (messages.length <= 1) return -1
  let keepFrom = messages.length - Math.min(keepCount, messages.length - 1)
  if (keepFrom <= 0) return -1
  if (retainBudget > 0) {
    let keptTokens = 0
    for (let i = messages.length - 1; i >= keepFrom; i--) keptTokens += estimateTokens(messages[i].content)
    while (keptTokens > retainBudget && messages.length - keepFrom > COMPACT_MIN_KEEP) {
      keptTokens -= estimateTokens(messages[keepFrom].content)
      keepFrom += 1
    }
  }
  return keepFrom <= 0 ? -1 : keepFrom
}

// 执行压缩：总结最早的消息（保留最近 keep 条，且保留部分受 token 预算比例约束），
// 摘要存 session.summary（摘要不进消息列表，由 agentLoop 注入 system prompt；前端横幅读取 summary）。
// 滚动摘要：二次及以后的压缩会把上一版 session.summary 一起交给 LLM 合并继承，
// 避免重复压缩时旧摘要被覆盖导致信息丢失。
// force=true 时忽略消息数门槛（上下文溢出恢复用，即使历史不长也压出空间）。
// 返回 null 表示无需/无法压缩。
export async function compactSession(session: Session, agent: Agent, opts?: CompactOptions): Promise<CompactResult | null> {
  const messages = session.messages
  const force = opts?.force ?? false
  if (!force && messages.length <= COMPACT_MIN_MESSAGES) return null

  // 保留"最近 keepCount 条"；keep 参数覆盖默认（溢出恢复用更少）
  const keepCount = Math.max(1, Math.min(opts?.keep ?? COMPACT_KEEP, messages.length - 1))
  // 保留预算（对齐 DSH retainRatio）：保留部分的文本估算 token ≤ 窗口 × RETAIN_PCT
  // （window 覆盖供压测模拟小窗口；缺省走 models.json 注册表）
  const window = opts?.window ?? contextWindowFor(agent.model)
  const retainBudget = (window * COMPACT_RETAIN_PCT) / 100

  const keepFrom = computeKeepFrom(messages, keepCount, retainBudget)
  if (keepFrom < 0) return null // 没有可压缩的旧消息（全都要保留）

  const toSummarize = messages.slice(0, keepFrom)
  const kept = messages.slice(keepFrom)

  // 滚动摘要：把上一版摘要一并交给 LLM 继承合并（首次压缩时 session.summary 为空，行为不变）
  const summary = await summarizeMessages(toSummarize, agent.model, session.summary)

  session.messages = kept
  session.summary = summary

  return { summary, removed: toSummarize.length, kept: kept.length }
}
