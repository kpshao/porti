// 外链白名单（主进程与渲染进程共用的纯函数）：仅 http/https 且不含内嵌凭据。
// 渲染进程用它决定是否把 Markdown 文本渲染成链接；主进程在交给系统浏览器前再校验一次。

/** 是否是可安全打开/渲染链接的 http(s) 地址 */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}
