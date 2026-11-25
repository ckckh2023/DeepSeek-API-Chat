import { create } from 'zustand'
import type { ChatModel } from './api/types.js'

/** 首页的对话模式：快速用 flash，专家用 pro。 */
export type ChatMode = 'flash' | 'pro'

/** 全局模型配置；思考强度后续在这里扩展。 */
export const CHAT_MODES: Record<ChatMode, { model: ChatModel }> = {
  flash: { model: 'deepseek-flash' },
  pro: { model: 'deepseek-v4-pro' },
}

const KEY = 'deepseek-api-chat:chat-mode'

const read = (): ChatMode => {
  try {
    return localStorage.getItem(KEY) === 'pro' ? 'pro' : 'flash'
  } catch {
    return 'flash'
  }
}

export const useChatMode = create(() => ({ mode: read() }))

export const setChatMode = (mode: ChatMode) => {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // 存储不可用时只在内存中生效
  }
  useChatMode.setState({ mode })
}

export const currentChatModel = (): ChatModel => CHAT_MODES[useChatMode.getState().mode].model
/** v4-pro 不支持服务端工具调用（联网搜索、阅读链接）与会话标题生成，请求里不能带。 */
export const supportsChatExtras = (model: ChatModel): boolean => model !== 'deepseek-v4-pro'