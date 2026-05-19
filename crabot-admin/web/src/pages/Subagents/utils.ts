/** snake_case 校验：必须以小写字母开头，后接小写字母 / 数字 / 下划线 */
export function isValidSubagentName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name)
}

/** Tab 2 「插入 example 模板」内容 */
export const WHEN_TO_USE_EXAMPLE_TEMPLATE = `Use this subagent when ...

<example>
[典型场景]
人类: 帮我搜集近一周 AI agent 框架在 GitHub trending 上的对比情况
原因: 涉及大量网页爬取 + 多源信息整合，main 上下文会被原始 HTML 撑爆
</example>

<example>
[反例]
人类: 我们 agent 的最新代码改了什么？
原因: 直接 git log 即可，无需启动 subagent
</example>
`

/** Tab 3 「插入边界默认条款」内容 */
export const ROLE_BOUNDARY_TEMPLATE = `
边界约束：
- 不读用户项目代码
- 不写入任何文件
- 不通过 crab-messaging 发消息
- 不调 delegate_task 嵌套委派
`
