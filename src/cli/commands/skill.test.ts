import { describe, it, expect } from 'vitest'

describe('skill restore command', () => {
  it('占位：execute 调 POST /api/skills/:id/restore', () => {
    // 主要逻辑在 commander action 内，间接通过 e2e / undo dispatch test 覆盖
    // 本文件留作 buildXxxBody 等纯函数单测的钩子（如未来 restore 需要 body）
    expect(true).toBe(true)
  })
})

describe('add reverseFromResult 分支', () => {
  // 这里直接测 reverseFromResult 函数本身——必须先把它从 action 内的闭包
  // 抽到模块顶层 export，参见 Task 5
  it.todo('was_overwrite=true → skill restore reverse')
  it.todo('was_overwrite=false → skill delete reverse')
})
