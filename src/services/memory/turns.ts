/**
 * 会话 → 整理用的扁平消息列表。
 *
 * 单独一个模块是为了破环：`chat/store.ts` 要在回答收尾处记活动（需要这个函数），
 * 而 `memory/run.ts` 要读 store（取当前会话）。函数本身只依赖 branches 与 reply，
 * 两边都 import 它，环就断在这里。
 *
 * 口径统一：`collectTurns` 的条数同时是水位的 `processedCount` 和活动记录的 `turnCount`。
 * 记忆要读的正是模型当时读到的那部分，所以直接复用 `getContextRounds`，
 * 「哪些轮次能进上下文」这条规则只有一份。
 */
import { getVisibleMessages } from '../chat/branches.js'
import { getContextRounds, getReplyText } from '../chat/reply.js'
import type { Session } from '../chat/types.js'

/** 一轮里的单条消息；只认角色与正文，不依赖会话类型 */
export interface MemoryTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** 把会话翻成整理用的扁平消息列表 */
export const collectTurns = (session: Session): MemoryTurn[] =>
  getContextRounds(getVisibleMessages(session)).flatMap(([question, reply]) => [
    { role: 'user' as const, text: question.content },
    { role: 'assistant' as const, text: getReplyText(reply) },
  ])
