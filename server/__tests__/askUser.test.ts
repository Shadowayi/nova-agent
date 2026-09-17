// AskUserService（human-in-the-loop 注册表）单元测试：注册/回答/校验/取消/会话中断清理
import { describe, it, expect } from 'vitest'
import { AskUserService } from '../askUser.js'
import type { AskUserQuestion } from '../askUser.js'

const Q: AskUserQuestion[] = [
  { id: 'a', question: '部署方式？', options: [{ label: 'Docker' }, { label: '裸机' }] },
  { id: 'b', question: '要不要补文档？', multi_select: true },
]

describe('AskUserService', () => {
  it('createRequest：注册挂起提问，peek 可见，answer 后 resolve 并清理', async () => {
    const svc = new AskUserService()
    const { requestId, wait } = svc.createRequest('s1', Q)
    expect(requestId.startsWith('ask_')).toBe(true)
    expect(svc.peek('s1')).toMatchObject({ requestId, questions: Q })
    expect(svc.activeCount).toBe(1)

    const done = wait.then((o) => o)
    expect(svc.answer(requestId, 's1', [
      { id: 'a', selected: ['Docker'] },
      { id: 'b', selected: [], custom: '补' },
    ])).toBe(true)

    const outcome = await done
    expect(outcome.status).toBe('answered')
    if (outcome.status === 'answered') {
      expect(outcome.answers).toHaveLength(2)
      expect(outcome.answers[0]).toMatchObject({ id: 'a', selected: ['Docker'] })
    }
    expect(svc.peek('s1')).toBeNull()
    expect(svc.activeCount).toBe(0)
  })

  it('answer 校验：sessionId 不匹配 / 答案缺 / id 不存在 / 单选多选越界都拒绝', async () => {
    const svc = new AskUserService()
    const { requestId } = svc.createRequest('s1', Q)

    expect(svc.answer(requestId, 's2', [{ id: 'a', selected: ['Docker'] }, { id: 'b', selected: [] }])).toBe(false)
    expect(svc.answer(requestId, 's1', [{ id: 'a', selected: ['Docker'] }])).toBe(false) // 缺一个
    expect(svc.answer(requestId, 's1', [{ id: 'zz', selected: [] }, { id: 'b', selected: [] }])).toBe(false) // 未知 id
    expect(svc.answer(requestId, 's1', [{ id: 'a', selected: ['Docker', '裸机'] }, { id: 'b', selected: [] }])).toBe(false) // 单选选两个
    // 全部非法后 pending 仍存活（未被消费）
    expect(svc.peek('s1')).toBeTruthy()
    // 合法答案仍可提交
    expect(svc.answer(requestId, 's1', [{ id: 'a', selected: ['裸机'] }, { id: 'b', selected: ['是'] }])).toBe(true)
    expect(svc.peek('s1')).toBeNull()
  })

  it('cancel：取消不是错误路径，pending 清理', async () => {
    const svc = new AskUserService()
    const { requestId, wait } = svc.createRequest('s1', Q)
    const done = wait.then((o) => o)
    expect(svc.cancel(requestId, 's1', '用户取消了提问')).toBe(true)
    expect(svc.cancel(requestId, 's1', '再来一次')).toBe(false) // 已消费
    const outcome = await done
    expect(outcome).toMatchObject({ status: 'cancelled', reason: '用户取消了提问' })
    expect(svc.activeCount).toBe(0)
  })

  it('cancelAllForSession：会话中断时清理该会话所有挂起提问（多问全清）', async () => {
    const svc = new AskUserService()
    const a = svc.createRequest('s1', Q)
    const b = svc.createRequest('s1', Q)
    const c = svc.createRequest('s2', Q) // 别的会话不受影响
    const outA = a.wait.then((o) => o)
    const outB = b.wait.then((o) => o)

    expect(svc.cancelAllForSession('s1', '会话已中断')).toBe(2)
    expect((await outA).status).toBe('cancelled')
    expect((await outB).status).toBe('cancelled')
    expect(svc.peek('s1')).toBeNull()
    expect(svc.activeCount).toBe(1) // c 仍在
    expect(svc.cancelAllForSession('s1', 'x')).toBe(0) // 幂等：已清空
    // 清理 c 收尾
    svc.cancelAllForSession('s2', 'teardown')
    expect(svc.activeCount).toBe(0)
  })

  it('不存在的 requestId / 跨会话取消返回 false', async () => {
    const svc = new AskUserService()
    expect(svc.answer('ask_none', 's1', [])).toBe(false)
    expect(svc.cancel('ask_none', 's1', 'x')).toBe(false)
    expect(svc.cancelAllForSession('s_ghost', 'x')).toBe(0)
  })
})
