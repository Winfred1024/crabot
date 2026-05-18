/**
 * Subagent runtime helpers
 *
 * 保留运行时辅助函数；subagent 配置已移到 admin 注册表（详见 SubAgentManager）。
 */

export function formatSupplementForSubAgent(text: string): string {
  return [
    '[实时纠偏 - 来自用户]\n',
    '用户在你执行任务期间发来了补充指示：\n\n',
    `"${text}"\n\n`,
    '请判断：\n',
    '- 如果此指示与你当前的工作直接相关，立即调整你的行为\n',
    '- 如果此指示与你当前的工作无关（可能是针对整体任务的），忽略它继续工作\n',
    '- 如果此指示表明你的整个子任务已不再需要，停止工作并返回当前已有的结果',
  ].join('')
}
