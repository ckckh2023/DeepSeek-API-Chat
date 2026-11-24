import { describe, expect, it } from 'vitest'
import { withMemoryProfile } from './profile.js'
import type { MemoryProfile } from '../../plugins/memory/prompt.js'

/**
 * 只测「档案怎么交给插件」这一条。文本与档案的互相转换随第二步的「用户不能直接编辑
 * 档案」一起删掉了，所以这里不再有那两个用例。
 */

const profile = (patch: Partial<MemoryProfile> = {}): MemoryProfile => ({
  identity: '',
  preferences: '',
  ongoing: '',
  unresolved: [],
  updatedAt: 0,
  turnsSeen: 0,
  ...patch,
})

describe('withMemoryProfile', () => {
  it('插件没开启时原样返回，档案不会变成隐式启用', () => {
    const states = { memory: { enabled: false } }
    expect(withMemoryProfile(states, profile({ identity: 'X' }))).toBe(states)
  })

  it('插件开启时把档案挂到 config 上，并附上宿主给的「现在」', () => {
    const out = withMemoryProfile({ memory: { enabled: true } }, profile({ identity: 'X' }))
    const config = out.memory?.config as { identity?: string; now?: unknown }
    expect(config.identity).toBe('X')
    expect(typeof config.now).toBe('number')
  })

  it('不改入参、不动其它插件的状态', () => {
    const states = { memory: { enabled: true }, purge: { enabled: true, config: { text: 'T' } } }
    withMemoryProfile(states, profile({ identity: 'X' }))
    expect('config' in states.memory).toBe(false)
    expect(withMemoryProfile(states, profile({ identity: 'X' })).purge).toStrictEqual({
      enabled: true,
      config: { text: 'T' },
    })
  })
})
