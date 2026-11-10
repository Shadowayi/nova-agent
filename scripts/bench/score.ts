// 上下文压缩压测 · 确定性判分
// 原则：不用 LLM 当裁判（引入第二重不确定性），判分只做字符串匹配——
// 事实标记（"玄武-47" 这类随机代号）模型不可能靠先验猜中，回答里出现即命中。

import type { PlantedFact, Constraint } from './fixtures.js'

export interface FactScore {
  id: string
  kind: PlantedFact['kind']
  marker: string
  hit: boolean
  turnIndex: number
}

/** 规范化：去掉全部空白——模型可能写 "5 月 26 日" 也可能写 "5月26日"、"1.9 万元" 或 "1.9万元" */
function norm(s: string): string {
  return s.replace(/\s+/g, '')
}

/** 事实命中判定：规范化后做包含匹配（标记含唯一代号/数字，空白规范化不会引入误命中） */
export function factHit(answer: string, marker: string): boolean {
  return norm(answer).includes(norm(marker))
}

/** 对一批回答判分：任一回答包含标记即命中（检查点可能分多次提问） */
export function scoreFacts(answers: string[], facts: PlantedFact[]): FactScore[] {
  return facts.map((f) => ({
    id: f.id,
    kind: f.kind,
    marker: f.marker,
    hit: answers.some((a) => factHit(a, f.marker)),
    turnIndex: f.turnIndex,
  }))
}

/** 约束检查：fn-prefix = 回答的代码/文本含约定前缀；lib-must = 提到了约定库名 */
export function checkConstraint(answer: string, c: Constraint): boolean {
  return answer.includes(c.payload)
}

export function scoreConstraints(answers: string[], constraints: Constraint[]): Array<{ kind: string; payload: string; hit: boolean }> {
  return constraints.map((c) => ({
    kind: c.kind,
    payload: c.payload,
    hit: answers.some((a) => checkConstraint(a, c)),
  }))
}

export function pct(hits: number, total: number): string {
  return total === 0 ? '—' : `${((hits / total) * 100).toFixed(0)}%`
}

/** 简易 markdown 表格（报告用） */
export function mdTable(headers: string[], rows: Array<Array<string | number>>): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n')
  return [head, sep, body].join('\n')
}
