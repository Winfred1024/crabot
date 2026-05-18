import type { DispatchContext } from './dispatcher-types.js'

/** Dispatcher system prompt 装配。Task 4 完整实现。 */
export function assembleDispatcherPrompt(_ctx: DispatchContext): string {
  return '你是 Crabot 的消息分诊器。输出 {"actions":[...]}。'
}
