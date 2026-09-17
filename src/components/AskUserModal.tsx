// human-in-the-loop：agent 调用 ask_user 时弹出的回答卡片（多问题 / 选项单选多选 / 自由输入 / 取消）。
// 只渲染"当前会话"的挂起提问：后台会话（已切走）的 ask 不弹窗，等超时/中断由后端结算
// （第一版限制，见 guide/10-ask-user.md §7）。
import { useState } from 'react'
import { useMainStore } from '../store'
import type { AskUserAnswer, AskUserQuestion } from '../types'
import { Button } from './ui/button'

interface Draft {
  selected: string[]
  custom: string
}

function emptyDraft(q: AskUserQuestion): Draft {
  return { selected: [], custom: '' }
}

export default function AskUserModal() {
  const pendingAsk = useMainStore((s) => s.pendingAsk)
  const currentSessionId = useMainStore((s) => s.currentSessionId)
  const answerAsk = useMainStore((s) => s.answerAsk)
  const cancelAsk = useMainStore((s) => s.cancelAsk)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)

  // 只展示当前会话的提问；后台会话的 ask 不打扰当前视图
  if (!pendingAsk || pendingAsk.sessionId !== currentSessionId) return null

  const { requestId, questions } = pendingAsk

  function draftOf(q: AskUserQuestion): Draft {
    return drafts[q.id] ?? emptyDraft(q)
  }

  function toggleOption(q: AskUserQuestion, label: string) {
    const d = draftOf(q)
    const next = q.multi_select
      ? d.selected.includes(label)
        ? d.selected.filter((x) => x !== label)
        : [...d.selected, label]
      : [label]
    setDrafts({ ...drafts, [q.id]: { ...d, selected: next } })
  }

  function setCustom(q: AskUserQuestion, value: string) {
    setDrafts({ ...drafts, [q.id]: { ...draftOf(q), custom: value } })
  }

  async function submit() {
    setBusy(true)
    const answers: AskUserAnswer[] = questions.map((q) => {
      const d = draftOf(q)
      return { id: q.id, selected: d.selected, custom: d.custom.trim() || undefined }
    })
    await answerAsk(answers)
    setBusy(false)
    setDrafts({})
  }

  async function cancel() {
    setBusy(true)
    await cancelAsk()
    setBusy(false)
    setDrafts({})
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-semibold">🤖 Agent 需要你的回答</h2>
          <span className="font-mono text-[11px] text-muted-foreground">{requestId}</span>
        </div>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-5 py-4">
          {questions.map((q) => {
            const d = draftOf(q)
            return (
              <div key={q.id}>
                {q.header && <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{q.header}</p>}
                <p className="mt-0.5 text-sm font-medium leading-snug">{q.question}</p>

                {q.options && q.options.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {q.options.map((opt) => {
                      const active = d.selected.includes(opt.label)
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => toggleOption(q, opt.label)}
                          className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                            active
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-border bg-background hover:border-primary/50'
                          }`}
                        >
                          <span className="font-medium">{opt.label}</span>
                          {opt.description && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">{opt.description}</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}

                <textarea
                  value={d.custom}
                  onChange={(e) => setCustom(q, e.target.value)}
                  placeholder={q.options?.length ? '或补充说明（可选）…' : '输入你的回答…'}
                  rows={q.options?.length ? 2 : 3}
                  className="mt-2 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
            取消提问
          </Button>
          <Button size="sm" disabled={busy} onClick={submit}>
            提交回答
          </Button>
        </div>
      </div>
    </div>
  )
}
