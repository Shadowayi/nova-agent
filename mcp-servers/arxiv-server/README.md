# arxiv-server：自研 arXiv MCP Server（接入记录）

从零实现的一个 MCP Server（非调用现成 server）：stdio 传输，提供 `search_papers` / `get_paper` 两个工具，
已通过 [Nova Agent](../../README.md) 的 MCP 网关零改动接入（`mcp-servers/arxiv.json`）。

```
Nova Agent（MCP 客户端）──stdio(JSON-RPC)──> arxiv-server（本包）──HTTPS──> export.arxiv.org（Atom XML）
```

## 快速开始

```bash
npm run build:arxiv          # 根目录执行：构建本包（tsc → dist/）
cd mcp-servers/arxiv-server && npm run smoke   # 冒烟：真实请求 arXiv 走完整 MCP 流程
```

构建产物 `dist/index.js` 由根目录 `mcp-servers/arxiv.json` 配置引用（`node mcp-servers/arxiv-server/dist/index.js`）。
Nova Agent 启动时自动拉起本进程，无需改任何主程序代码。

## 协议适配（arXiv 侧）

arXiv 导出 API 没有官方 JSON，返回的是 **Atom XML**，这一层是主要的适配工作：

| 问题 | 处理 |
|---|---|
| Atom XML（命名空间 atom / arxiv: / opensearch:） | `fast-xml-parser` 解析；`arxiv:primary_category`、`arxiv:comment` 等带前缀字段按原名取 |
| 单 entry 时 XML 解析出对象而非数组 | `asArray()` 统一包一层数组 |
| `search_query` 裸词搜索不可靠 | 映射为 arXiv 字段语法：裸词逐个包 `all:"词"` AND 连接（支持引号短语）；已带 `ti:`/`au:`/`abs:` 等前缀则原样透传 |
| 论文 ID 多形态（`2401.12345` / `2401.12345v2` / 完整 abs URL / 旧式 `cs/0112017`） | 入参统一归一化（正则提取 id + 可选版本号），返回时 id 与 version 分开 |
| 摘要含连续空白/换行 | 输出前折叠为单空格 |

## 协议纪律（MCP 侧）

- **stdout 是 JSON-RPC 通道**：所有日志只走 stderr（`console.error`）——向 stdout 打一条日志就会污染协议流，这是自研 server 最常见的翻车点。
- **握手**：客户端连上后 `initialize` → 能力协商 → `notifications/initialized`，随后 `tools/list` 拉工具清单、`tools/call` 调用。本包用官方 SDK 的 `McpServer` + `StdioServerTransport`（`registerTool` 注册，zod schema 声明入参，SDK 负责校验与 JSON Schema 暴露）。
- **错误结构化**：工具失败返回 `isError: true` + 可读错误文本（含修正示例），让调用方模型能自行调整，而不是拿到一堆栈。

## 错误处理

| 错误 | 策略 |
|---|---|
| HTTP 503 / 429（arXiv 限流，官方建议 1 请求/3 秒） | 服务端内置指数退避重试（最多 2 次）：优先尊重 `Retry-After` 头，否则 3s→6s |
| 网络错误 / 超时（单请求 15s，`AbortSignal.timeout`） | 同样走退避重试；非瞬态错误（如参数非法）不重试直接返回 |
| ID 格式非法 | **本地校验、不发起请求**（~1ms 返回，附正确示例） |
| 格式合法但 ID 不存在 | arXiv 返回空 feed → 结构化错误"ID 不存在或已被删除" |
| 搜索无结果 | **不算错误**：返回可操作的换词建议文本，模型可自行重试 |

## 性能实测（2026-11-11，单机 Windows，Node 22，走系统代理）

| 操作 | 耗时 | 说明 |
|---|---|---|
| stdio 握手 + tools/list | ~3ms | 本地进程，与 arXiv 无关 |
| search_papers（3 篇，相关性排序） | 2,556ms | 耗时以 arXiv 侧为主 |
| get_paper（1706.03762，Attention Is All You Need） | 238ms | 冷/热差异明显 |
| get_paper（2312.11866） | 2,517ms | 同一接口，波动大 |
| get_paper（合法格式但不存在的 2401.99999） | 1,093ms | 往返一次 API 后结构化报错 |
| get_paper（格式非法 ID） | 1ms | 本地校验，不出网 |

> 样本量小、单机单网络环境，数字仅供量级参考；arXiv 未承诺接口时延。限流退避路径（503）未在本次冒烟中自然触发——重试逻辑由代码审查覆盖。

## 已知局限

- 只实现了 **tools** 能力，未实现 resources/prompts/sampling（arXiv 检索场景用不到）。
- 搜索结果摘要截断 240 字符（完整摘要用 `get_paper`）；`max_results` 上限 20。
- 未做本地缓存——同一 ID 反复查询会重复出网（arXiv 允许，礼貌起见别并发轰）。
- 空结果/换词建议是英文检索调优过的中文提示，中文关键词命中率天然低（arXiv 是英文库）。

## 面试考点自查（为什么这么写）

- **为什么用官方 SDK 而不是手写 JSON-RPC？** 协议层（握手/分帧/错误码）是标准件，自研价值在 arXiv 适配层；手写握手只在教学场景有意义。
- **为什么 stdout 不能打日志？** stdio 传输下 stdout 即协议流，混入非 JSON-RPC 文本会让客户端解析直接崩——所以日志统一 `console.error`。
- **为什么空结果不是 error？** `isError` 应保留给"操作失败"；"没搜到"是合法业务结果，返回建议文本让模型决定下一步，链路才不会断。
- **为什么限流重试放 server 而不是客户端？** 限速是 arXiv 对"这个客户端"的要求，谁出网谁负责礼貌；客户端（Nova Agent）的超时只管整体调用预算。
