import { describe, it, expect, vi } from 'vitest'
import {
  estimateTokens, shouldCompact, contextWindowFor, contextUsage, sanitizeContextWindow, COMPACT_PCT,
  maybePruneToolOutput, PRUNE_MARKER, PRUNE_THRESHOLD_CHARS, PRUNE_HEAD_CHARS, PRUNE_TAIL_CHARS,
  isContextWindowExceededError, computeKeepFrom, COMPACT_MIN_KEEP,
} from '../compact.js'
import type { Session, Agent } from '../types.js'

// —— 滚动摘要回归测试用 mock：捕获 summarize 的完整 prompt、喂固定回复 ——
// vi.mock 会提升到文件顶部；上方纯函数用例不经过 generateText，不受影响。
const captured = vi.hoisted(() => ({
  prompts: [] as string[],
  answers: [] as string[],
}))
vi.mock('ai', () => ({
  generateText: vi.fn(async ({ prompt }: { prompt: string }) => {
    captured.prompts.push(prompt)
    return { text: captured.answers.shift() ?? '（空摘要）' }
  }),
}))
vi.mock('../models.js', () => ({
  createModel: () => ({}),
  resolveModel: () => null,
}))

function mkSession(messages: Array<{ role: string; content: string; tokens?: { input: number; output: number } }>): Session {
  return {
    id: 's', agentId: 'a', title: 't', createdAt: 0, updatedAt: 0,
    messages: messages.map((m, i) => ({ id: `m${i}`, role: m.role as 'user' | 'assistant', content: m.content, tokens: m.tokens, createdAt: 0 })),
  }
}

describe('compact 估算', () => {
  it('estimateTokens：中文按 0.7/字、其他按 0.25/字符', () => {
    expect(estimateTokens('你好世界')).toBe(3) // 4 字 × 0.7 = 2.8 → 3
    expect(estimateTokens('hello world')).toBe(3) // 11 字符 × 0.25 = 2.75 → 3
  })

  it('shouldCompact：消息数超限触发（40 条兜底）', () => {
    const s = mkSession(Array.from({ length: 41 }, (_, i) => ({ role: 'user', content: '短' })))
    expect(shouldCompact(s, 'deepseek/deepseek-v4-flash')).toBe(true)
  })

  it(`shouldCompact：上下文占用超窗口 ${COMPACT_PCT}% 触发（真实计数优先）`, () => {
    // 最后一条 assistant 的 input = 完整上下文（真实计数）；模拟 90 万 tokens 输入 → 触发
    const s = mkSession([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'hi', tokens: { input: 950_000, output: 100 } },
    ])
    expect(shouldCompact(s, 'deepseek/deepseek-v4-flash')).toBe(true)
  })

  it('shouldCompact：占用低于阈值不触发', () => {
    const s = mkSession([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'hi', tokens: { input: 100_000, output: 100 } },
    ])
    expect(shouldCompact(s, 'deepseek/deepseek-v4-flash')).toBe(false)
  })

  it('contextUsage：以最新 input 为基准 + 其后消息估算', () => {
    const s = mkSession([
      { role: 'user', content: 'a'.repeat(400) },      // 估算 100
      { role: 'assistant', content: 'hi', tokens: { input: 50_000, output: 200 } },
      { role: 'user', content: '你好世界' },            // 估算 3
    ])
    // base = 50000（input 已含历史，不再累加前面的 user）+ 3(新增 user 估算) = 50003；
    // baseIdx 自身的 output 已含在下一次请求的 input 里，不重复计
    expect(contextUsage(s.messages)).toBe(50_003)
  })

  it('shouldCompact：少量消息不触发', () => {
    const s = mkSession([{ role: 'user', content: '你好' }])
    expect(shouldCompact(s, 'deepseek/deepseek-v4-flash')).toBe(false)
  })

  it('contextWindowFor：models.json 注册表内置（V4 = 1M），缺省 1M', () => {
    expect(contextWindowFor('deepseek/deepseek-v4-flash')).toBe(1_000_000)
    expect(contextWindowFor('unknown/model')).toBe(1_000_000)
  })

  it('sanitizeContextWindow：非法值（0/负数/非数字）兜底为 1M', () => {
    expect(sanitizeContextWindow(0)).toBe(1_000_000)
    expect(sanitizeContextWindow(-5)).toBe(1_000_000)
    expect(sanitizeContextWindow(Number.NaN)).toBe(1_000_000)
    expect(sanitizeContextWindow('abc')).toBe(1_000_000)
    expect(sanitizeContextWindow('200000')).toBe(200_000)
    expect(sanitizeContextWindow(200_000)).toBe(200_000)
  })
})

describe('工具结果修剪（DSH pruner 对齐：8192 → head 4096 + 标记 + tail 1024）', () => {
  it('未超阈值原样返回', () => {
    const short = 'a'.repeat(PRUNE_THRESHOLD_CHARS)
    expect(maybePruneToolOutput(short)).toBe(short) // 恰好等于阈值不修剪
    expect(maybePruneToolOutput('你好')).toBe('你好')
  })

  it('超阈值修剪为 head + 标记 + tail', () => {
    const long = 'x'.repeat(PRUNE_THRESHOLD_CHARS + 1000)
    const out = maybePruneToolOutput(long)
    expect(out).toContain(PRUNE_MARKER)
    const [head, tail] = out.split(PRUNE_MARKER)
    expect(head.length).toBe(PRUNE_HEAD_CHARS)
    expect(tail.length).toBe(PRUNE_TAIL_CHARS)
    // 头尾保留原文对应片段（不丢失关键信息）
    expect(head).toBe('x'.repeat(PRUNE_HEAD_CHARS))
    expect(tail).toBe('x'.repeat(PRUNE_TAIL_CHARS))
    expect(out.length).toBeLessThan(long.length)
  })

  it('按 Unicode 码点修剪：emoji（代理对）不被拆开', () => {
    const emoji = '😀'.repeat(PRUNE_THRESHOLD_CHARS + 500) // 每个 emoji 是 2 个 UTF-16 单元、1 个码点
    const out = maybePruneToolOutput(emoji)
    // 无半个代理对：每个码点都是完整 emoji，不含替换符
    expect(out).not.toContain('\uFFFD')
    const pts = Array.from(out)
    expect(pts.length).toBe(PRUNE_HEAD_CHARS + Array.from(PRUNE_MARKER).length + PRUNE_TAIL_CHARS)
    expect(pts.slice(0, 3).join('')).toBe('😀😀😀')
    expect(pts.slice(-3).join('')).toBe('😀😀😀')
  })
})

describe('上下文溢出检测（DSH isContextWindowExceededError 对齐）', () => {
  it('识别常见 provider 溢出措辞', () => {
    expect(isContextWindowExceededError(new Error("This model's maximum context length is 128000 tokens. However, you requested 130000 tokens."))).toBe(true)
    expect(isContextWindowExceededError(new Error('context window exceeded'))).toBe(true)
    expect(isContextWindowExceededError(new Error('The input is too long for this model'))).toBe(true)
    expect(isContextWindowExceededError(new Error('prompt exceeds model context window'))).toBe(true)
    expect(isContextWindowExceededError(new Error('Request too large for context'))).toBe(true)
    expect(isContextWindowExceededError('context_length_exceeded')).toBe(true)
  })

  it('不误伤其他错误（限流/鉴权/网络/余额）', () => {
    expect(isContextWindowExceededError(new Error('rate limit exceeded'))).toBe(false)
    expect(isContextWindowExceededError(new Error('invalid api key'))).toBe(false)
    expect(isContextWindowExceededError(new Error('fetch failed'))).toBe(false)
    expect(isContextWindowExceededError(new Error('insufficient balance'))).toBe(false)
    expect(isContextWindowExceededError(new Error('quota exceeded'))).toBe(false)
  })

  it('沿 cause 链识别（传输层包装的溢出错误）', () => {
    const inner = new Error("This model's maximum context length is 128000 tokens. However, you requested 200000 tokens.")
    const wrapped = new Error('fetch failed', { cause: inner })
    expect(isContextWindowExceededError(wrapped)).toBe(true)
  })
})

describe('computeKeepFrom：保留条数 + token 预算双约束', () => {
  it('默认：保留最近 20 条', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ content: `消息${i}` }))
    expect(computeKeepFrom(msgs, 20, 1_000_000)).toBe(10)
  })

  it('keep 覆盖：溢出恢复保留更少', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ content: `消息${i}` }))
    expect(computeKeepFrom(msgs, 6, 1_000_000)).toBe(24)
  })

  it('无可压缩旧消息（只有 1 条）返回 -1', () => {
    expect(computeKeepFrom([{ content: 'hi' }], 20, 1_000_000)).toBe(-1)
  })

  it('保留预算收紧：把最旧保留消息并入压缩，但至少保留 COMPACT_MIN_KEEP 条', () => {
    // 10 条 × 100 个中文字 ≈ 70 token/条；预算 160 token → 全保留超预算
    const msgs = Array.from({ length: 10 }, () => ({ content: '你'.repeat(100) }))
    // 8 条保留 → 560 token 超 160；逐条裁剪直到只剩 COMPACT_MIN_KEEP 条
    expect(computeKeepFrom(msgs, 8, 160)).toBe(10 - COMPACT_MIN_KEEP)
  })

  it('保留预算充足时不裁剪', () => {
    const msgs = Array.from({ length: 10 }, () => ({ content: 'x' })) // 每条 1 token
    expect(computeKeepFrom(msgs, 8, 160)).toBe(2) // 保留 8 条 × 1 token ≤ 160
  })
})

// ---------- 滚动摘要（回归）：二次压缩必须继承上一版摘要 ----------
// 场景：长对话压缩不止一次。session.summary 不在 messages 里——若第二次压缩只总结
// messages.slice(0, keepFrom)，第一次压缩的摘要就会被整体覆盖，其中的事实全部丢失。
function mkAgent(): Agent {
  return {
    id: 'a', name: 'a', persona: '测试助手', model: 'deepseek/deepseek-v4-flash',
    mcpServerIds: [], skillIds: [], color: '#000', createdAt: 0,
  }
}

describe('滚动摘要（回归）：二次压缩必须继承上一版摘要', () => {
  it('第二次压缩的 summarize 输入应同时包含新压缩消息和旧摘要中的事实', async () => {
    const { compactSession } = await import('../compact.js')
    const agent = mkAgent()
    captured.prompts.length = 0
    captured.answers.length = 0

    // —— 第一次压缩：旧历史里埋事实 A（玄武-47），凑 45 条越过消息数门槛 ——
    const msgs = [
      { role: 'user' as const, content: '我们项目的内部代号定为玄武-47，后续文档都用这个代号。' },
      { role: 'assistant' as const, content: '好的，已记录：本项目内部代号玄武-47。' },
    ]
    let n = 0
    while (msgs.length < 46) {
      msgs.push({ role: 'user' as const, content: `例行同步第 ${++n} 次：进展一切正常，无阻塞。` })
      msgs.push({ role: 'assistant' as const, content: '收到，继续按计划推进。' })
    }
    const session = mkSession(msgs.slice(0, 45))
    captured.answers.push('摘要一：项目内部代号是玄武-47。')
    const r1 = await compactSession(session, agent)
    expect(r1).not.toBeNull()
    expect(session.summary).toContain('玄武-47')
    expect(captured.prompts[0]).toContain('玄武-47')

    // —— 第二次压缩：新一段历史里埋事实 B；mock 固定回复不含任何事实，杜绝回显误判 ——
    const before = session.messages.length
    session.messages.push({ id: 'b1', role: 'user', content: '进入二期：预算上限确定为 3.2 万元。', createdAt: 0 })
    session.messages.push({ id: 'b2', role: 'assistant', content: '收到，二期预算上限 3.2 万元。', createdAt: 0 })
    let k = 0
    while (session.messages.length < before + 26) {
      session.messages.push({ id: `f${++k}u`, role: 'user', content: `二期例行同步第 ${k} 次：联调顺利，无阻塞。`, createdAt: 0 })
      if (session.messages.length < before + 26) {
        session.messages.push({ id: `f${k}a`, role: 'assistant', content: '收到，按计划推进二期。', createdAt: 0 })
      }
    }
    // mock 回复模拟"合规摘要员"（合并旧摘要与新消息）——本测试的断言重点是
    // summarize 的**输入**是否继承了旧摘要（captured.prompts[1]），而非 mock 回显。
    captured.answers.push('摘要二：项目内部代号玄武-47；二期预算上限 3.2 万元。')
    const r2 = await compactSession(session, agent)
    expect(r2).not.toBeNull()

    // 第二次 summarize 的输入必须包含：本次被压缩的消息（事实 B）+ 上一版摘要（事实 A）
    expect(captured.prompts[1]).toContain('3.2 万') // 新消息进来了（当前实现即满足）
    expect(captured.prompts[1]).toContain('玄武-47') // 旧摘要被继承 ← 当前实现会丢失（RED）
    expect(session.summary).toContain('玄武-47') // 摘要覆盖后事实 A 仍在最终摘要里
  })
})
