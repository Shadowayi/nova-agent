#!/usr/bin/env node
// arXiv MCP Server（stdio 传输）：两个工具
// - search_papers：关键词/字段检索论文列表
// - get_paper：按 ID 取单篇完整摘要与元数据
//
// 协议纪律：stdout 是 JSON-RPC 通道，任何日志只准走 stderr；
// 工具失败返回结构化错误文本（isError: true），让模型能读懂原因并自行调整。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { searchPapers, getPaper, ArxivError, type ArxivPaper } from './arxiv.js'

const VERSION = '0.1.0'
const SEARCH_ABSTRACT_CHARS = 240 // 列表里摘要截断长度（全文摘要用 get_paper）

const server = new McpServer({ name: 'arxiv', version: VERSION })

// ---------- 输出格式化 ----------

function formatPaper(p: ArxivPaper, opts: { index?: number; fullAbstract?: boolean } = {}): string {
  const lines: string[] = []
  const head = opts.index !== undefined ? `[#${opts.index}] ${p.title}` : p.title
  lines.push(head)
  lines.push(`作者: ${p.authors.join(', ') || '（未知）'}`)
  const pub = p.published ? p.published.slice(0, 10) : '?'
  const upd = p.updated ? p.updated.slice(0, 10) : '?'
  lines.push(`时间: 首发 ${pub} / 最近更新 ${upd}（${p.version}）`)
  lines.push(`ID: ${p.id} · 分类: ${[p.primaryCategory, ...p.categories.filter((c) => c !== p.primaryCategory)].join(', ')}`)
  lines.push(`链接: ${p.absUrl}${p.pdfUrl ? ` · PDF: ${p.pdfUrl}` : ''}`)
  if (p.comment) lines.push(`备注: ${p.comment}`)
  if (p.journalRef) lines.push(`发表: ${p.journalRef}`)
  if (opts.fullAbstract) {
    lines.push(`摘要: ${p.abstract}`)
  } else {
    const short = p.abstract.length > SEARCH_ABSTRACT_CHARS ? `${p.abstract.slice(0, SEARCH_ABSTRACT_CHARS)}…` : p.abstract
    lines.push(`摘要: ${short}${p.abstract.length > SEARCH_ABSTRACT_CHARS ? '（已截断，用 get_paper 看全文摘要）' : ''}`)
  }
  return lines.join('\n')
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(err: unknown) {
  const message = err instanceof ArxivError ? err.message : `arXiv 查询失败：${(err as Error).message}`
  console.error('[arxiv-server] 工具失败:', message)
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const }
}

// ---------- 工具注册 ----------

server.registerTool(
  'search_papers',
  {
    title: 'arXiv 论文搜索',
    description:
      '检索 arXiv 论文列表。query 支持两种写法：直接给关键词（自动按全文匹配，如 "attention transformer"），' +
      '或 arXiv 字段语法（如 ti:attention、au:vaswani、cat:cs.CL，可用 AND/OR/ANDNOT 组合）。' +
      '返回标题/作者/时间/ID/分类/摘要截断；要看某篇完整摘要与 PDF 链接，用 get_paper。',
    inputSchema: {
      query: z.string().min(1).describe('检索词。裸关键词或 arXiv 字段语法（ti:/au:/abs:/cat:/all:），支持引号短语与 AND/OR'),
      max_results: z.number().int().min(1).max(20).optional().describe('返回条数，默认 5，上限 20'),
      sort_by: z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']).optional().describe('排序：相关性（默认）/ 最近更新 / 提交时间'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, max_results, sort_by }) => {
    try {
      const papers = await searchPapers(query, { maxResults: max_results, sortBy: sort_by })
      if (!papers.length) {
        // 空结果不是错误：返回可操作的提示文本，模型可换词重试
        return textResult(`arXiv 没有找到与「${query}」匹配的论文。建议：换更通用的关键词；或改用字段语法（如 ti: / abs:）；英文检索效果远好于中文。`)
      }
      const body = papers.map((p, i) => formatPaper(p, { index: i + 1 })).join('\n\n')
      return textResult(`arXiv 检索「${query}」命中 ${papers.length} 篇（按 ${sort_by ?? 'relevance'} 排序）：\n\n${body}`)
    } catch (err) {
      return errorResult(err)
    }
  },
)

server.registerTool(
  'get_paper',
  {
    title: 'arXiv 单篇详情',
    description:
      '按 arXiv ID 获取单篇论文的完整摘要与元数据（作者/分类/时间/PDF 链接/期刊引用）。' +
      'ID 形态：2401.12345、2401.12345v2 或完整 URL（https://arxiv.org/abs/2401.12345）。先 search_papers 找 ID，再用本工具看详情。',
    inputSchema: {
      id: z.string().min(1).describe('arXiv ID 或 abs 链接，如 1706.03762'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ id }) => {
    try {
      const paper = await getPaper(id)
      return textResult(formatPaper(paper, { fullAbstract: true }))
    } catch (err) {
      return errorResult(err)
    }
  },
)

// ---------- 启动（stdio） ----------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[arxiv-server] 已启动（stdio，v${VERSION}），等待 MCP 客户端握手…`)
}

main().catch((err) => {
  console.error('[arxiv-server] 启动失败:', err)
  process.exit(1)
})
