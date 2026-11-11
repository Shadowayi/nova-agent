// arXiv API 客户端：查询构造、Atom XML 解析、限流退避。
// 协议要点（见 README「接入记录」）：
// - arXiv 导出 API 返回 Atom XML（命名空间：atom 默认 / arxiv: / opensearch:），无官方 JSON
// - 官方建议限速 1 请求/3 秒；超速返回 HTTP 503 + Retry-After 头
// - search_query 需要 arXiv 字段前缀（ti:/au:/abs:/all:...），裸词搜索不可靠——本层做映射
// - 论文 ID 形态：2401.12345 / 2401.12345v2 / 完整 URL，入参统一归一化

import { XMLParser } from 'fast-xml-parser'

const API_BASE = 'https://export.arxiv.org/api/query'
const USER_AGENT = 'nova-arxiv-mcp-server/0.1.0 (+https://github.com/Syotick/nova-agent)'
const REQUEST_TIMEOUT_MS = 15_000
const RETRY_MAX = 2 // 限流/网络错误的退避重试次数（0 = 不重试）
const RATE_LIMIT_BACKOFF_MS = 3_000 // arXiv 官方建议 1 请求/3 秒

export interface ArxivPaper {
  id: string // 形如 2401.12345（不含版本号）
  version: string // 形如 v2（首版为 v1）
  title: string
  authors: string[]
  abstract: string
  published: string // ISO 时间（首发）
  updated: string // ISO 时间（最近更新）
  primaryCategory: string
  categories: string[]
  pdfUrl?: string
  journalRef?: string
  comment?: string
  absUrl: string // https://arxiv.org/abs/<id>
}

// ---------- 查询构造：裸词 → all:"..."，已带字段前缀则透传 ----------

const FIELD_PREFIX_RE = /(?:^|\s)(?:ti|au|abs|co|jr|cat|all|id):/

/** 把用户输入映射成 arXiv 查询语法。示例：
 *  "attention transformer"        → all:"attention" AND all:"transformer"
 *  `"deep learning" reinforcement` → all:"deep learning" AND all:"reinforcement"
 *  "ti:attention AND au:vaswani"   → 原样透传（已是 arXiv 语法） */
export function buildSearchQuery(input: string): string {
  const q = input.trim()
  if (!q) throw new ArxivError('query 不能为空')
  if (FIELD_PREFIX_RE.test(q)) return q
  // 裸词：支持引号短语；逐词（或短语）包 all:"..."，AND 连接
  const terms: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(q)) !== null) {
    const term = (m[1] ?? m[2]).trim()
    if (term) terms.push(`all:"${term.replace(/"/g, '')}"`)
  }
  if (!terms.length) throw new ArxivError('query 不能为空')
  return terms.join(' AND ')
}

// ---------- ID 归一化：URL / 带版本 / 纯 ID → (id, version) ----------

const ARXIV_ID_RE = /(\d{4}\.\d{4,5})(v\d+)?$/i
const OLD_STYLE_ID_RE = /^([a-z-]+\/\d{7})(v\d+)?$/i

export function normalizePaperId(input: string): { id: string; version?: string } {
  const s = input.trim().replace(/^https?:\/\/(www\.)?(arxiv\.org|export\.arxiv\.org)\/abs\//i, '')
  const m = s.match(ARXIV_ID_RE) ?? s.match(OLD_STYLE_ID_RE)
  if (!m) {
    throw new ArxivError(
      `无法识别的 arXiv ID："${input}"。示例：2401.12345、2401.12345v2、https://arxiv.org/abs/2401.12345（旧式 cs/0112017 亦支持）`,
    )
  }
  return { id: m[1], version: m[2]?.toLowerCase() }
}

// ---------- HTTP + 退避 ----------

export class ArxivError extends Error {}

async function fetchAtom(url: string): Promise<string> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    if (attempt > 0) {
      // 退避：优先尊重 Retry-After，否则按官方建议 3s 起步、逐次翻倍
      const delay = Math.min(lastRetryAfterMs ?? RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1), 10_000)
      log(`第 ${attempt} 次重试，等待 ${delay}ms（原因：${lastErr?.message ?? '未知'}）`)
      await sleep(delay)
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.status === 503 || res.status === 429) {
        lastRetryAfterMs = Number(res.headers.get('retry-after') ?? 0) * 1000 || null
        lastErr = new ArxivError(`arXiv 限流（HTTP ${res.status}${lastRetryAfterMs ? `，Retry-After ${lastRetryAfterMs}ms` : ''}）`)
        continue
      }
      if (!res.ok) throw new ArxivError(`arXiv API 返回 HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (err instanceof ArxivError && !String(err.message).includes('限流')) throw err // 非瞬态错误不重试
      lastErr = err as Error
    }
  }
  throw new ArxivError(`arXiv API 连续 ${RETRY_MAX + 1} 次请求失败：${lastErr?.message ?? '未知错误'}`)
}

let lastRetryAfterMs: number | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...args: unknown[]) => console.error('[arxiv-server]', ...args) // stdout 是协议通道，日志只能走 stderr

// ---------- Atom XML → 结构化 ----------

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
})

type XmlNode = string | number | Record<string, unknown> | Array<Record<string, unknown> | string | number>

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/** 节点文本：fast-xml-parser 对"文本 + 属性"混合节点会把文本放 #text */
function textOf(node: XmlNode | undefined): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim()
  if (typeof node === 'object' && '#text' in node) return String((node as Record<string, unknown>)['#text'] ?? '').trim()
  return ''
}

/** Atom 文本里的连续空白折叠为单空格（标题/摘要排版更稳定） */
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

function parseFeed(xmlText: string): ArxivPaper[] {
  const feed = xml.parse(xmlText)?.feed as Record<string, unknown> | undefined
  if (!feed) throw new ArxivError('arXiv 返回了无法解析的内容（非 Atom feed）')
  const entries = asArray(feed.entry as XmlNode) as Array<Record<string, unknown>>
  return entries
    .filter((e) => e && typeof e === 'object' && ('id' in e || 'title' in e))
    .map((e) => {
      const rawId = textOf(e['id'] as XmlNode) // 形如 http://arxiv.org/abs/2401.12345v2
      const { id, version } = normalizePaperId(rawId)
      const categories = asArray(e['category'] as XmlNode)
        .map((c) => String((c as Record<string, unknown>)?.['@_term'] ?? '').trim())
        .filter(Boolean)
      const links = asArray(e['link'] as XmlNode) as Array<Record<string, unknown>>
      const pdfLink = links.find((l) => l?.['@_title'] === 'pdf' || String(l?.['@_href'] ?? '').includes('/pdf/'))
      const authors = asArray(e['author'] as XmlNode)
        .map((a) => textOf((a as Record<string, unknown>)?.['name'] as XmlNode))
        .filter(Boolean)
      return {
        id,
        version: version ?? 'v1',
        title: collapse(textOf(e['title'] as XmlNode)),
        authors,
        abstract: collapse(textOf(e['summary'] as XmlNode)),
        published: textOf(e['published'] as XmlNode),
        updated: textOf(e['updated'] as XmlNode),
        primaryCategory: String((e['arxiv:primary_category'] as Record<string, unknown>)?.['@_term'] ?? categories[0] ?? ''),
        categories,
        pdfUrl: pdfLink ? String(pdfLink['@_href'] ?? '') : undefined,
        journalRef: textOf(e['arxiv:journal_ref'] as XmlNode) || undefined,
        comment: textOf(e['arxiv:comment'] as XmlNode) || undefined,
        absUrl: `https://arxiv.org/abs/${id}`,
      }
    })
}

// ---------- 对外两个查询 ----------

export type SortBy = 'relevance' | 'lastUpdatedDate' | 'submittedDate'

export async function searchPapers(query: string, opts?: { maxResults?: number; sortBy?: SortBy; start?: number }): Promise<ArxivPaper[]> {
  const searchQuery = buildSearchQuery(query)
  const maxResults = Math.min(Math.max(1, opts?.maxResults ?? 5), 20)
  const start = Math.max(0, opts?.start ?? 0)
  const sortBy = opts?.sortBy ?? 'relevance'
  const url = `${API_BASE}?search_query=${encodeURIComponent(searchQuery)}&start=${start}&max_results=${maxResults}&sortBy=${sortBy}`
  log(`search: ${searchQuery}（max=${maxResults}）`)
  return parseFeed(await fetchAtom(url))
}

export async function getPaper(input: string): Promise<ArxivPaper> {
  const { id, version } = normalizePaperId(input)
  const url = `${API_BASE}?id_list=${encodeURIComponent(version ? `${id}${version}` : id)}&max_results=1`
  log(`get: ${id}${version ?? ''}`)
  const papers = parseFeed(await fetchAtom(url))
  const paper = papers.find((p) => p.id === id)
  if (!paper) throw new ArxivError(`arXiv 上没有找到论文 ${id}（ID 不存在或已被删除）`)
  return paper
}
