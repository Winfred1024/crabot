/**
 * Agent 构建版本。
 * resume checkpoint 版本守卫用——upgrade 后版本不匹配时拒绝 resume，避免消息格式不兼容。
 */
export const AGENT_VERSION: string = process.env.npm_package_version ?? '0.0.0'
