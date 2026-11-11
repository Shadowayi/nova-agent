// 冒烟测试：拉起 dist/index.js，用官方 SDK 客户端走完整 MCP 流程
// （initialize 握手 → tools/list → tools/call ×3），并记录每次调用耗时。
// 用法：npm run build && npm run smoke
// 注意：真实请求 arXiv；两次 API 调用间主动间隔 3s+ 以尊重官方限速建议。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] })
  const client = new Client({ name: 'arxiv-smoke', version: '0.0.1' }, { capabilities: {} })
  await client.connect(transport)
  console.log('✔ 已连接 arxiv MCP server（stdio）')

  const t0 = Date.now()
  const tools = await client.listTools()
  console.log(`✔ tools/list：${tools.tools.map((t) => t.name).join('、')}（${Date.now() - t0}ms）`)

  await sleep(3200) // 尊重 arXiv 限速建议
  let t = Date.now()
  const search = await client.callTool({
    name: 'search_papers',
    arguments: { query: 'attention is all you need transformer', max_results: 3 },
  })
  const searchText = (search.content as Array<{ text: string }>)[0]?.text ?? ''
  console.log(`\n✔ search_papers（${Date.now() - t}ms，isError=${search.isError === true}）`)
  console.log(searchText.split('\n').slice(0, 14).join('\n'))

  await sleep(3200)
  t = Date.now()
  const paper = await client.callTool({ name: 'get_paper', arguments: { id: '1706.03762' } })
  const paperText = (paper.content as Array<{ text: string }>)[0]?.text ?? ''
  console.log(`\n✔ get_paper(1706.03762)（${Date.now() - t}ms，isError=${paper.isError === true}）`)
  console.log(paperText.split('\n').slice(0, 8).join('\n'))

  // 错误路径：本地参数校验，不打 API
  t = Date.now()
  const bad = await client.callTool({ name: 'get_paper', arguments: { id: 'not-an-arxiv-id' } })
  const badText = (bad.content as Array<{ text: string }>)[0]?.text ?? ''
  console.log(`\n✔ get_paper(错误 ID)（${Date.now() - t}ms，isError=${bad.isError === true}）`)
  console.log(badText)

  await client.close()
  console.log('\n✔ 冒烟通过')
}

main().catch((err) => {
  console.error('✘ 冒烟失败:', err)
  process.exit(1)
})
