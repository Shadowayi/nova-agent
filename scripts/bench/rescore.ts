// 重判分已保存的压测结果（零 API 成本）
// 场景：判分规则修正（如空白规范化）后，对历史 results.json 重算命中率并重写 report.md。
// 事实判定只依赖保存下来的回答文本，素材由同种子确定性重新生成，不需要重跑 API。
// 用法：npm run bench:rescore -- scripts/bench/out/run-<时间戳>/results.json

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateFactRecall, generateConstraint, generateOverflow, type Fixture } from './fixtures.js'
import { scoreFacts, pct } from './score.js'
import { buildReport, type RunResult } from './run.js'

const file = process.argv[2]
if (!file) {
  console.error('用法: tsx scripts/bench/rescore.ts <results.json 路径>')
  process.exit(1)
}

const data: RunResult = JSON.parse(readFileSync(file, 'utf8'))
const cfg = data.config
const fixtures: Fixture[] = [
  generateFactRecall({ seed: cfg.seed, exchanges: cfg.exchanges }),
  generateConstraint({ seed: cfg.seed, exchanges: cfg.exchanges }),
  generateOverflow({ seed: cfg.seed, exchanges: cfg.exchanges }),
]

for (const arm of data.arms) {
  const fixture = fixtures.find((f) => f.scenario === arm.scenario)
  if (!fixture || !fixture.facts.length) continue
  for (const cp of arm.checkpoints) {
    const asked = fixture.facts.filter((f) => f.turnIndex <= cp.exchange - 1)
    const hits = asked.filter((f) => scoreFacts([cp.answer], [f])[0].hit).length
    cp.askedFacts = asked.length
    cp.hitFacts = hits
    cp.hitPct = pct(hits, asked.length)
  }
  const lastCp = arm.checkpoints[arm.checkpoints.length - 1]
  if (lastCp) {
    if (lastCp.overflowed && !lastCp.recovered) {
      arm.finalHitPct = '溢出'
    } else {
      const asked = fixture.facts.filter((f) => f.turnIndex <= lastCp.exchange - 1)
      const hits = asked.filter((f) => scoreFacts([lastCp.answer], [f])[0].hit).length
      arm.finalHitPct = pct(hits, asked.length)
    }
  }
}

writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
writeFileSync(join(dirname(file), 'report.md'), buildReport(data, fixtures), 'utf8')
console.log('已重判分并更新:', file)
