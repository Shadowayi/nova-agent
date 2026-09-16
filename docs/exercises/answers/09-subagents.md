# 🔑 答案 09：子 Agent 体系与父子通信

> 先做题，再翻这页。每题的"为什么"都对应 [指南 09](../guide/09-subagents.md) 的某一节。

---

## 练习 1：注册表字段各管什么

**答案**：

- `id`（sub_xxx）= 子代理的 **durable id**，同时作为子会话 id 喂 `runTurn`；`parentId` = 父会话 id。
  - **认亲靠 `parentId`**：结算通知投给谁（`pendingNotices(parentId)`）、子说 `to: parent` 认谁当父（`findSubagentBySessionId` 反查），全看它。`send_message` 的"只允许直系"= 父只能对 `parentId == 自己` 的子发消息。
- `inbox` = **父 → 子** 的待处理消息队列。子空闲时 `pumpSubagent` 启动新轮，从 `inbox.shift()` 取队首消费；运行中来的消息进队列，当前轮结束才处理。
- `notice` / `notice_consumed` = **子 → 父** 的待送达通知。
  - 子完成/失败/留言时 `appendNotice` 写入 `notice` 并把 `notice_consumed` 置 0（未消费）。
  - **消费发生在父下一轮**：`agentLoop.ts` 组装 history 时 `pendingNotices(session.id)` 取出、注入、`consumeNotice` 置 1。防的是：溢出重试时同一通知被重复注入。

**为什么**：这三个字段正好对应通信的"两端"——`parentId` 定义父子关系，`inbox` 管父→子，`notice` 管子→父。中间人只做数据与队列，不碰父子的执行（§1、§3、§5）。

---

## 练习 2：三个场景选哪个模式

**答案**：

1. **spawn**——"并行调研 5 个方向"：子任务互不相干、各自独立、task 自包含即可。fork 反而多此一举（带上父历史浪费 token），background 没需求（等结果回来再继续）。
2. **fork**——"把刚才的讨论落到文档"：子必须知道刚才聊了什么才能落文档。spawn 从零开始做不到；background 也没必要常驻。
3. **background**——"盯一个可能要好几分钟的爬虫"：父不想干等，要后台跑 + 完成时通知。spawn/fork 是同步等待，会阻塞父当前轮。

**为什么**：三模式 = 三维度——spawn/fork 是"子要不要父上下文"，同步/后台是"父等不等结果"。场景 1 是"独立 + 同步"（spawn），场景 2 是"继承 + 同步"（fork），场景 3 是"独立 + 后台"（background）。组合出的第四种（fork + background）也存在，但极少用（§2、§3）。

---

## 练习 3：亲手派后台子代理

**答案（自检对照）**：

- 创建时父立即收到 `[子代理已启动] id: sub_xxx`——**没有阻塞**父当前轮。
- `list_agents` 能看到：id、状态（先"运行中"→ 后"空闲"）、任务、待处理消息数。
- 父**再发一句话**后，回复里出现 `[系统通知] 你的后台子代理有新动态` + 子代理的调研结果。

**为什么"父必须再发一轮才能看到"**：结算通知是注入到父**下一轮请求**的 history 里（`pendingNotices` → push → `consumeNotice`）。父如果一直不发言，通知就一直在 `notice` 里等着（不会丢失，只是没被看到）。这是"零竞态"设计换来的代价（§5）。

**动手提示**：如果子代理跑得太快、`list_agents` 已经"空闲"，可以给子任务加大难度或观察日志里的 `[子代理...已空闲]`，进程是异步的，但状态一定会在某次 `list_agents` 里变成"空闲"。

---

## 练习 4：验证"运行中排队"语义

**答案**：

- 对**运行中**的子 `send_message`：消息进 `inbox` **排队**，子当前轮**不被打断**，当前轮结束（settle）后 `pumpSubagent` 发现 `inbox` 非空 → 再启动一轮处理。
- 对**空闲**的子 `send_message`：`rec.status === 'idle'` → 立即 `void pumpSubagent(...)` 启动新轮。

对照代码 `pumpSubagent` 的 `while` 循环：

```
while (rec) {
  content = 首轮 ? task : inbox.shift()   // 一次一轮，取队首
  runSubagentTurn(...)
  rec = getSubagent(id)
  if (rec.inbox.length === 0) break       // 队列空 → idle 收工
}
```

**为什么这是取舍**：Nova 没有 AI SDK 的 steer（子运行中途注入），所以用队列——**不打断、简单可靠**；代价是不能在子执行中途"纠偏"。面试被问"父子能否中途插话"：答"能，但走队列、下一轮生效"，并说出这个取舍（§4）。

---

## 练习 5：结算通知为什么不能实时推送

**答案**：

`saveSession` 是**整个 session 覆盖写**（`INSERT ... ON CONFLICT DO UPDATE SET messages = excluded.messages`），不是 append。竞态时序：

1. 父 turn 进行中，`runTurn` 持有**内存里的父 session 对象**（`session.messages` 还在被 push）。
2. 子这时结束，调 `saveSession(getSession(父id)+通知)` —— 把通知写进 **DB**。
3. 父 turn 结束，路由 `saveSession(内存 session)` —— **用内存对象整体覆盖 DB**，把步骤 2 写的通知**冲掉了**。

结果：通知丢失。除非加锁/合并逻辑——那才是真正的复杂度来源。

**为什么"父的下一轮再注入"能避开**：注入发生在父**自己的** turn 组装 history 时（`attemptModel` 里读 `pendingNotices`），读的时候父 turn 已经在写自己的 session，读写同一个来源、同一时序，**没有第二个写入者**——零竞态。代价只是"父要再发一轮才看到"（§5）。

**延伸**：如果要做到"子结束父立刻能看到"，正确做法不是写父会话，而是**前端事件流**（父有事件订阅，子 settle 推一个 `subagent-done` 事件给前端，父会话本身仍走下一轮注入）——这是 Nova 未来可扩展的方向。

---

**对完答案 → 去 [🎓 终极验收项目](../exercises/capstone.md)。**
