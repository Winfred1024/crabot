export interface PaginatedInput<T> {
  items: T[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
}

export interface PaginatedOutput<T> {
  items: T[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
    has_more: boolean
    is_truncated: boolean
    default_page_size_applied: boolean
    next_page: number | null
  }
}

export interface AnnotateOpts {
  requestedPage: number
  requestedPageSize: number
  userSpecifiedPageSize: boolean
}

export function annotatePagination<T>(input: PaginatedInput<T>, opts: AnnotateOpts): PaginatedOutput<T> {
  const { page, page_size, total_items, total_pages } = input.pagination
  const has_more = page < total_pages
  return {
    items: input.items,
    pagination: {
      page,
      page_size,
      total_items,
      total_pages,
      has_more,
      is_truncated: has_more,
      default_page_size_applied: !opts.userSpecifiedPageSize,
      next_page: has_more ? page + 1 : null,
    },
  }
}
