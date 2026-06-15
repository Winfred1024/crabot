/**
 * 测试隔离：把 Module Manager 端口指向死端口。
 *
 * 测试里 boot 的真实 AdminModule 会发出站 RPC（callAgentRpc / pushConfigToAgentModules
 * 等先经 MM resolve）——不隔离的话，开发机上正在运行的 live 实例会被测试解析到：
 * self-healing 测试拿测试库的 task id 去调 live agent 的 start_recovery_task
 * （表现为 live 日志反复出现 "Failed to start recovery task <uuid>: ADMIN_TASK_NOT_FOUND"），
 * 配置推送测试把测试配置推给 live agent（"Worker Agent SDK env hot-updated" 循环）。
 *
 * 指向死端口后这些出站调用快速失败，全部调用方本就是 best-effort（catch + warn）。
 */
process.env.CRABOT_MM_PORT = '59321'
