const REDACTED = '[REDACTED]'

const PATTERNS: [RegExp, ((match: string) => string)][] = [
  // tenant/user access token（t- 開頭的飛書 token，至少 20 個字符）
  [/\bt-[A-Za-z0-9._-]{20,}\b/g, () => REDACTED],
  // Bearer header（保留 Bearer 關鍵詞）
  [/Bearer\s+[A-Za-z0-9._\-/+=]{20,}/g, () => `Bearer ${REDACTED}`],
  // JSON 字段名含 SECRET/TOKEN/KEY/PASSWORD（值在引號裡）
  [/"(?:APP_SECRET|APP_KEY|API_KEY|API_SECRET|ACCESS_TOKEN|MASTER_KEY|PASSWORD|SECRET)":\s*"[^"]{6,}"/gi, () => REDACTED],
  // 完整飛書 channel-config JSON（含 APP_ID + APP_SECRET 同時出現則整體 mask）
  [/\{[^{}]*"FEISHU_APP_SECRET"\s*:\s*"[^"]{6,}"[^{}]*\}/g, () => REDACTED],
]

/**
 * 對 text 做脫敏處理：mask 已知 secret 值 + 高置信度模式。
 * 純函數，返回新串，不修改入參。
 */
export function redactSecrets(text: string, knownSecrets: readonly string[]): string {
  if (!text) return text
  let result = text

  // 已知 secret 值逐字替換
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 6) continue
    result = result.split(secret).join(REDACTED)
  }

  // 模式替換
  for (const [pattern, replacer] of PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, replacer)
  }

  return result
}
