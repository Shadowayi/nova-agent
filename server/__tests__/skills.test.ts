// 技能系统单元测试：目录块（懒加载入口）与 load_skill 的加载函数
import { describe, it, expect } from 'vitest'
import { skillCatalog, loadSkillContent, parseFrontmatter } from '../skills.js'

describe('parseFrontmatter（CRLF 兼容：Windows autocrlf 检出）', () => {
  it('LF 行尾正常解析', () => {
    const { meta, body } = parseFrontmatter('---\nname: 测试技能\ndescription: 描述文字\nwhen_to_use: 使用时机\n---\n正文第一行\n第二行')
    expect(meta.name).toBe('测试技能')
    expect(meta.description).toBe('描述文字')
    expect(meta.when_to_use).toBe('使用时机')
    expect(body).toContain('正文第一行')
  })

  it('CRLF 行尾：frontmatter 不被丢弃（回归：曾致技能目录全空）', () => {
    const { meta, body } = parseFrontmatter('---\r\nname: 测试技能\r\ndescription: 描述文字\r\nwhen_to_use: 使用时机\r\n---\r\n正文内容')
    expect(meta.name).toBe('测试技能')
    expect(meta.description).toBe('描述文字')
    expect(meta.when_to_use).toBe('使用时机')
    expect(body).toBe('正文内容')
  })

  it('无 frontmatter：meta 为空、body 原样返回', () => {
    const { meta, body } = parseFrontmatter('纯正文，没有 frontmatter')
    expect(meta.name).toBeUndefined()
    expect(body).toBe('纯正文，没有 frontmatter')
  })
})

describe('skillCatalog（目录块：只给名字+描述，不给正文）', () => {
  it('空勾选 = 空字符串（不花 token）', () => {
    expect(skillCatalog([])).toBe('')
  })

  it('勾选技能 = 名字/使用时机/描述 + load_skill 指引', () => {
    const cat = skillCatalog(['browser-ops', 'file-ops'])
    expect(cat).toContain('浏览器操作专家')
    expect(cat).toContain('文件操作')
    expect(cat).toContain('使用时机')
    expect(cat).toContain('load_skill')
    // 关键：正文不进目录（懒加载的证明）
    expect(cat).not.toContain('Playwright MCP 工具')
  })

  it('勾选不存在的 id = 只输出存在的', () => {
    const cat = skillCatalog(['browser-ops', 'ghost-skill'])
    expect(cat).toContain('浏览器操作专家')
    expect(cat).not.toContain('ghost-skill')
  })
})

describe('loadSkillContent（按名加载，受勾选约束）', () => {
  it('按中文名字命中且已勾选 = 返回全文', () => {
    const res = loadSkillContent(['browser-ops'], '浏览器操作专家')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.id).toBe('browser-ops')
      expect(res.content).toContain('浏览器操作专家')
      expect(res.whenToUse).toContain('打开 URL')
    }
  })

  it('按 id 也能命中（模型可能记目录里的 id）', () => {
    const res = loadSkillContent(['browser-ops'], 'browser-ops')
    expect(res.ok).toBe(true)
  })

  it('存在但未勾选 = 拒绝（勾选即授权）', () => {
    const res = loadSkillContent(['browser-ops'], '文件操作')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('未在 Agent 勾选中启用')
  })

  it('未知名字 = 报错并提示看目录', () => {
    const res = loadSkillContent(['browser-ops'], '不存在的技能')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('未知技能')
  })
})
