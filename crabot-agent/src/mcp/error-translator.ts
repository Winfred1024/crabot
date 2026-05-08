import { RpcCallError } from 'crabot-shared'

export interface TranslatedError {
  error_code: string
  error: string
  hint?: string
  missing_scope?: string
}

export function translateChannelError(err: unknown): TranslatedError {
  if (!(err instanceof RpcCallError)) {
    return {
      error_code: 'INTERNAL',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  switch (err.code) {
    case 'CHANNEL_LIST_GROUPS_NOT_SUPPORTED':
      return {
        error_code: err.code,
        error: err.message,
        hint: "该 channel 平台不支持列群，请改用 list_sessions(type='group') 看已感知会话",
      }
    case 'CHANNEL_LIST_CONTACTS_NOT_SUPPORTED':
      return {
        error_code: err.code,
        error: err.message,
        hint: '该 channel 平台不支持列联系人，请改用 list_sessions 看已感知会话',
      }
    case 'PERMISSION_DENIED': {
      const missing = err.details?.missing_scope
      return typeof missing === 'string'
        ? { error_code: err.code, error: err.message, missing_scope: missing }
        : { error_code: err.code, error: err.message }
    }
    default:
      return { error_code: err.code, error: err.message }
  }
}
