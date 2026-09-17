// Human-in-the-loop：ask_user 的"等待 / 回答 / 取消"注册表（纯状态机，零外部依赖）。
//
// 设计（对齐开源实现，见 guide/10-ask-user.md）：
//   - DSH（@deepseek-ai/dsh-user-questions）：无限等待 + abort 信号取消，不设强制超时；
//     一次可问多个问题（questions[]，id 回显），答案结构化（selected[] + custom）。
//   - Codex（elicitation.rs）：暂停计数 + RAII 释放（异常/中断不泄漏挂起）。
//   - 本模块刻意"什么都不知道"：不 import HTTP / SSE / agentLoop / toolRegistry，
//     不 emit 事件——谁调用、谁广播，由调用方（工具 execute / answer 路由）决定。
//     这样注册表可独立单测，路由与工具互不 import（解耦，无上帝模块）。
//
// 一致性约束（由调用方保证）：
//   - 同一会话同一时刻只允许一个挂起提问（工具 execute 串行 await 天然保证；
//     若未来出现并发场景，本模块按 requestId 索引天然支持多个，只需调用方排队）。
//   - 取消路径：用户点"取消"（answer 路由带 cancelled）/ 会话中断（abortRun 调
//     cancelAllForSession）。取消不是 error——工具返回"用户取消了提问"让模型换路。
import { newId } from './store.js'

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestion {
  /** 稳定问题 id，答案中回显（对齐 DSH：answers[].id === questions[].id） */
  id: string
  question: string
  /** 可选短标题（如"确认" / "选择模式"） */
  header?: string
  /** 可选选项：推荐项放第一并标"(Recommended)" */
  options?: AskUserOption[]
  /** 是否允许多选（默认单选） */
  multi_select?: boolean
}

export interface AskUserAnswer {
  id: string
  selected: string[]
  custom?: string
}

export type AskUserOutcome =
  | { status: 'answered'; answers: AskUserAnswer[] }
  | { status: 'cancelled'; reason: string }

interface Pending {
  sessionId: string
  requestId: string
  questions: AskUserQuestion[]
  resolve: (outcome: AskUserOutcome) => void
}

export class AskUserService {
  // requestId → pending（随机 id，跨会话不可猜）
  private readonly pending = new Map<string, Pending>()
  // sessionId → requestIds（中断清理 / 前端查询走会话索引）
  private readonly bySession = new Map<string, Set<string>>()

  /**
   * 注册一个提问请求，返回 requestId 与等待结果的 Promise。
   * 调用方拿到 requestId 后负责把问题广播给用户（emit ask_user 事件），
   * 然后 await wait——用户回答（answer）或取消（cancel）时 resolve。
   */
  createRequest(sessionId: string, questions: AskUserQuestion[]): { requestId: string; wait: Promise<AskUserOutcome> } {
    const requestId = newId('ask')
    let resolvePending!: (outcome: AskUserOutcome) => void
    const wait = new Promise<AskUserOutcome>((resolve) => {
      resolvePending = resolve
    })
    this.pending.set(requestId, { sessionId, requestId, questions, resolve: resolvePending })
    const ids = this.bySession.get(sessionId) ?? new Set<string>()
    ids.add(requestId)
    this.bySession.set(sessionId, ids)
    return { requestId, wait }
  }

  /**
   * 用户提交答案。校验：requestId 存在 + sessionId 匹配 + 答案与问题一一对应。
   * 成功返回 true（pending 已消费）；失败返回 false（调用方原样返回给前端）。
   */
  answer(requestId: string, sessionId: string, answers: AskUserAnswer[]): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.sessionId !== sessionId) return false
    if (!this.validateAnswers(p.questions, answers)) return false
    this.settle(p, { status: 'answered', answers })
    return true
  }

  /** 用户主动取消（弹窗"取消"按钮）。取消不是错误，工具端会让模型换路推进。 */
  cancel(requestId: string, sessionId: string, reason: string): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.sessionId !== sessionId) return false
    this.settle(p, { status: 'cancelled', reason })
    return true
  }

  /** 会话中断/结束时清掉该会话所有挂起提问（对齐 Codex RAII：不留泄漏）。返回清理数。 */
  cancelAllForSession(sessionId: string, reason: string): number {
    const ids = this.bySession.get(sessionId)
    if (!ids || ids.size === 0) return 0
    let n = 0
    for (const requestId of [...ids]) {
      const p = this.pending.get(requestId)
      if (p) {
        this.settle(p, { status: 'cancelled', reason })
        n++
      }
    }
    this.bySession.delete(sessionId)
    return n
  }

  /** 查询某会话当前挂起提问（前端切回会话/测试用）。 */
  peek(sessionId: string): { requestId: string; questions: AskUserQuestion[] } | null {
    const ids = this.bySession.get(sessionId)
    if (!ids || ids.size === 0) return null
    const requestId = [...ids][0]
    const p = this.pending.get(requestId)
    return p ? { requestId, questions: p.questions } : null
  }

  /** 活跃挂起总数（测试/监控用）。 */
  get activeCount(): number {
    return this.pending.size
  }

  private settle(p: Pending, outcome: AskUserOutcome) {
    this.pending.delete(p.requestId)
    const ids = this.bySession.get(p.sessionId)
    if (ids) {
      ids.delete(p.requestId)
      if (ids.size === 0) this.bySession.delete(p.sessionId)
    }
    p.resolve(outcome)
  }

  private validateAnswers(questions: AskUserQuestion[], answers: AskUserAnswer[]): boolean {
    if (!Array.isArray(answers) || answers.length !== questions.length) return false
    const qids = new Set(questions.map((q) => q.id))
    for (const a of answers) {
      if (!a || typeof a.id !== 'string' || !qids.has(a.id)) return false
      if (!Array.isArray(a.selected)) return false
      // 单选问题只允许一个选项；多选可多个（空数组 = 用户没选，靠 custom 兜底）
      const q = questions.find((x) => x.id === a.id)
      if (q && !q.multi_select && a.selected.length > 1) return false
    }
    return true
  }
}

// 进程级单例：answer 路由与 agentLoop（abortRun 清理）共用，互不 import。
export const askUserService = new AskUserService()
