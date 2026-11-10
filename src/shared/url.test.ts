import { describe, expect, it } from 'vitest'
import { isSafeHttpUrl } from './url'

describe('isSafeHttpUrl — 外链白名单', () => {
  it('只放行 http/https 且不含内嵌凭据的地址', () => {
    expect(isSafeHttpUrl('https://example.com/a?b=1')).toBe(true)
    expect(isSafeHttpUrl('http://127.0.0.1:8080/x')).toBe(true)
  })

  it('javascript/file/data 与相对路径、内嵌凭据、非法地址一律拒绝', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeHttpUrl('/settings')).toBe(false)
    expect(isSafeHttpUrl('https://user:pass@example.com/x')).toBe(false)
    expect(isSafeHttpUrl('not a url')).toBe(false)
  })
})
