import { describe, it, expect } from 'vitest'
import { annotatePagination } from '../../src/mcp/pagination-annotator.js'

describe('annotatePagination', () => {
  const base = { items: [], pagination: { page: 1, page_size: 50, total_items: 187, total_pages: 4 } }

  it('has_more=true 时给出 next_page', () => {
    const out = annotatePagination(base, { requestedPage: 1, requestedPageSize: 50, userSpecifiedPageSize: false })
    expect(out.pagination).toMatchObject({
      has_more: true,
      is_truncated: true,
      default_page_size_applied: true,
      next_page: 2,
    })
  })

  it('已是最后一页时 has_more=false、next_page=null', () => {
    const out = annotatePagination(
      { items: [], pagination: { page: 4, page_size: 50, total_items: 187, total_pages: 4 } },
      { requestedPage: 4, requestedPageSize: 50, userSpecifiedPageSize: false },
    )
    expect(out.pagination).toMatchObject({ has_more: false, is_truncated: false, next_page: null })
  })

  it('LLM 显式传 page_size 时 default_page_size_applied=false', () => {
    const out = annotatePagination(base, { requestedPage: 1, requestedPageSize: 100, userSpecifiedPageSize: true })
    expect(out.pagination.default_page_size_applied).toBe(false)
  })

  it('保留原 items 与 pagination 字段不被破坏', () => {
    const orig = { items: [{ a: 1 }], pagination: { page: 2, page_size: 25, total_items: 60, total_pages: 3 } }
    const out = annotatePagination(orig, { requestedPage: 2, requestedPageSize: 25, userSpecifiedPageSize: true })
    expect(out.items).toEqual([{ a: 1 }])
    expect(out.pagination.page).toBe(2)
    expect(out.pagination.page_size).toBe(25)
    expect(out.pagination.total_items).toBe(60)
    expect(out.pagination.total_pages).toBe(3)
  })
})
