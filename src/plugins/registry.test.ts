import { describe, expect, it } from 'vitest'
import { composeSystemPrompt } from './index.js'

/**
 * 只测 composeSystemPrompt 的公开契约（src/plugins/index.ts 顶部注释里写死的那几条铁律），
 * 不测内部实现。插件具体正文不在这里断言 —— 正文是内容，改文案不该让测试红。
 */

describe('composeSystemPrompt', () => {
  it('没有任何插件显式开启时，原样返回 system', () => {
    expect(composeSystemPrompt('base')).toBe('base')
  })

  it('插件状态里没有 enabled: true 时不执行', () => {
    const out = composeSystemPrompt('base', [], { nsfw: { enabled: false } }, { advanced: true })
    expect(out).toBe('base')
  })

  it('社区插件在高级模式关闭时整段跳过', () => {
    const out = composeSystemPrompt('base', [], { purge: { enabled: true } }, { advanced: false })
    expect(out).toBe('base')
  })

  it('社区插件在高级模式开启后注入，且尾部内容排在原文之后', () => {
    const out = composeSystemPrompt('base', [], { purge: { enabled: true } }, { advanced: true })
    expect(out.startsWith('base\n\n')).toBe(true)
    expect(out.length).toBeGreaterThan('base'.length)
  })

  it('非社区插件不受高级模式门禁', () => {
    const out = composeSystemPrompt(
      'base',
      [],
      { 'custom-instructions': { enabled: true, config: { text: 'TAIL' } } },
      { advanced: false }
    )
    expect(out).toBe('base\n\nTAIL')
  })

  it('config.text 非空时优先于内置正文', () => {
    const out = composeSystemPrompt(
      'base',
      [],
      { nsfw: { enabled: true, config: { text: 'HEAD' } } },
      { advanced: true }
    )
    expect(out).toBe('HEAD\n\nbase')
  })

  it('config.text 为空白时回退内置正文', () => {
    const builtin = composeSystemPrompt('base', [], { nsfw: { enabled: true } }, { advanced: true })
    const blank = composeSystemPrompt(
      'base',
      [],
      { nsfw: { enabled: true, config: { text: '   ' } } },
      { advanced: true }
    )
    expect(blank).toBe(builtin)
  })

  it('脏 config 不抛错，按未配置处理', () => {
    for (const config of [null, 42, 'text', { text: 1 }, []]) {
      const out = composeSystemPrompt(
        'base',
        [],
        { nsfw: { enabled: true, config } },
        { advanced: true }
      )
      expect(out.startsWith('HEAD')).toBe(false)
      expect(out.endsWith('base')).toBe(true)
    }
  })

  it('多个插件按 order 升序执行：head 在外层，tail 在内层', () => {
    const out = composeSystemPrompt(
      'base',
      [],
      {
        nsfw: { enabled: true, config: { text: 'H' } },
        'custom-instructions': { enabled: true, config: { text: 'T' } },
      },
      { advanced: true }
    )
    expect(out).toBe('H\n\nbase\n\nT')
  })

  it('内置档记忆块排在自定义指令之后，且带「不是本轮指令」与相对时间', () => {
    const updatedAt = Date.now() - 3 * 24 * 60 * 60 * 1000
    const out = composeSystemPrompt(
      'base',
      [],
      {
        'custom-instructions': { enabled: true, config: { text: 'TAIL' } },
        memory: {
          enabled: true,
          config: {
            identity: '我叫阿满',
            preferences: '',
            ongoing: '',
            unresolved: [],
            updatedAt,
            turnsSeen: 0,
            // 「现在」由宿主给：插件不自己取时钟
            now: updatedAt + 3 * 24 * 60 * 60 * 1000,
          },
        },
      },
      { advanced: false }
    )
    expect(out.startsWith('base\n\nTAIL\n\n')).toBe(true)
    expect(out).toContain('不是本轮指令')
    expect(out).toContain('与用户当前说法冲突时以当前说法为准')
    expect(out.endsWith('档案更新于 3 天前')).toBe(true)
  })

  it('档案三段全空时记忆插件不注入', () => {
    const out = composeSystemPrompt(
      'base',
      [],
      {
        memory: {
          enabled: true,
          config: { identity: '  ', preferences: '', ongoing: '', updatedAt: Date.now() },
        },
      },
      { advanced: false }
    )
    expect(out).toBe('base')
  })

  it('记忆插件的脏 config 不抛错，按空档案处理', () => {
    for (const config of [undefined, null, 42, 'text', [], { identity: 1 }]) {
      const out = composeSystemPrompt('base', [], { memory: { enabled: true, config } }, {})
      expect(out).toBe('base')
    }
  })

  it('不修改传入的 system 字符串之外的状态：同样入参两次结果一致', () => {
    const args = ['base', [], { purge: { enabled: true } }, { advanced: true }] as const
    expect(composeSystemPrompt(...args)).toBe(composeSystemPrompt(...args))
  })
})
