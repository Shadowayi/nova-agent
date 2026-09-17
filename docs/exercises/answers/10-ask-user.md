# 🔑 答案 10：Human-in-the-loop —— 停下来问用户

> 先做题，再翻这页。每题的"为什么"都对应 [指南 10](../guide/10-ask-user.md) 的某一节。

---

## 练习 1：服务层为什么"什么都不知道"

**答案**：

- `askUser.ts` **只 import 了 `newId`**（生成 requestId），不 import HTTP / SSE / agentLoop / toolRegistry。
- 工具通过 **`ToolRuntime.askUserService`**（agentLoop 构建 runtime 时注入的进程级单例）拿到服务——capability seam，工具不碰服务内部、测试可注入独立实例。
- `settle()` 做三件事：① `pending.delete(requestId)`（按 id 索引删）；② 从 `bySession` 集合删该 id、空则删会话索引；③ `resolve(outcome)`（唤醒等待中的工具）。

**为什么**：纯状态机 = 可独立单测（askUser.test.ts 零 mock 覆盖回答/校验/取消/中断）；"谁广播"属于调用方（工具 emit 事件、路由接 HTTP），服务不背这口锅（指南 §3）。

---

## 练习 2：什么时候该问，什么时候不该问

**答案**：

1. **可问可不问**——术语拿不准会影响交付质量，确认一次成本低；但若上下文足够（README 风格能推断）也可以不问。
2. **该问**——"哪台服务器、什么环境"是缺失的关键信息，猜错 = 整个部署方案推倒重来。这就是 ask_user 的核心场景：**信息不足且代价高**。
3. **不该问**——3 个方案都能推进，选哪个是内部工程决策，能自己推进就自己推。问 = 打扰，违反"信息已足够不要问"。
4. **该问**——抬头称呼猜错会影响求职邮件的第一印象，且这是一个"用户拍板"性质的低成本问题。

**为什么**：判断标准不是"有没有不确定"，而是"**猜错的代价 vs 打断的成本**"。代价高 → 问；代价低/能推断 → 不问（指南 §0 纪律）。

---

## 练习 3：亲手跑一次 ask_user 全流程

**答案（自检对照）**：

- 弹窗出现时 **SSE 流仍打开**（没有 done），因为工具 `await wait` 只是让当前轮悬停，HTTP 连接没断。
- 提交后：`POST /answer` → `askUserService.answer` → resolve → 工具返回"用户回答：…" → 模型拿到结构化答案继续 → 最终 `done`。
- "暂停的是工具等待，不是 HTTP 连接"——这是理解 human-in-the-loop 在 SSE 模型里怎么实现的关键（指南 §5）。

**如果 agent 没主动问**：检查是不是工具没装配（默认始终装配，除非你改了 CONTROL_TOOLS）或模型把它当成可选项。直白指令"调用 ask_user 工具"通常就触发。

---

## 练习 4：取消与中断两条退路

**答案**：

- **取消**：弹窗"取消提问" → `store.cancelAsk` → `POST /answer { cancelled: true }` → `askUserService.cancel` → 工具返回**非 error**的"用户取消了提问（原因：用户取消了提问）…基于现状给结论/建议"→ turn 继续，模型换路。
- **中断**：点停止 → `abortRun(sessionId)` → `askUserService.cancelAllForSession(sessionId, '会话已中断')` → 挂起提问以 cancelled 结算、注册表清空 → turn 结束（error/done），`activeCount` 归零。
- 两条退路对应两个触发方：**用户主动放弃回答**（answer 路由的 cancelled）与**外部终止会话**（abortRun）。共同点：都走 `settle`，都保证不留幽灵等待（指南 §3、§5）。

**为什么取消不是 error**：error 会让模型以为"出错了"而重试/放弃；取消是"人拒绝提供答案"，模型应该基于现状继续（给建议或结论）。语义不同，返回文本也不同。

---

## 练习 5：扩展——给挂起提问加"等待时长进度"

**答案（自检对照）**：

- 最小改法：`AskUserService.createRequest` 里给 Pending 加 `createdAt: Date.now()`；`peek` 返回它（向后兼容——peek 的返回对象加字段不破坏现有调用）；或加 `getElapsed(sessionId): number | null`。
- 前端 `AskUserModal` 用 `setInterval` 每 5s 读 `pendingAsk.createdAt` 渲染"已等待 X 秒"。
- **服务层加字段/方法是新增能力**：现有 `answer/cancel/cancelAllForSession` 语义不变，`askUser.test.ts` 与 `toolRegistry.test.ts` **一条不用改**——因为工具与路由只依赖既有 API（createRequest 返回结构 + peek），不依赖实现细节。这就是 capability seam + 纯状态机解耦的收益（指南 §7 取舍 1）。

**做的时候发现要改旧测试 = 耦合信号**：说明你的扩展动了既有行为（如改了 createRequest 签名、改了 settle 语义），回头想清楚"新增 vs 修改"再动手。

---

**对完答案 → 10 课全通 → 去 [🎓 终极验收项目](../exercises/capstone.md)。**
