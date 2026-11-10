import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

/** 收集 AST 中出现的所有节点类型（断言安全边界用） */
function collectTypes(node: unknown, types = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, types)
  } else if (node !== null && typeof node === 'object') {
    const obj = node as { type?: string; children?: unknown; items?: unknown; header?: unknown; rows?: unknown }
    if (typeof obj.type === 'string') types.add(obj.type)
    for (const value of Object.values(obj)) {
      if (typeof value === 'object') collectTypes(value, types)
    }
  }
  return types
}

describe('parseMarkdown — 块级结构', () => {
  it('解析标题、段落与空行分隔', () => {
    const blocks = parseMarkdown('# 组合判断\n\n你的组合**比较集中**。\n\n## 依据\n\n- HHI 0.42')
    expect(blocks).toEqual([
      { type: 'heading', level: 1, children: [{ type: 'text', text: '组合判断' }] },
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: '你的组合' },
          { type: 'strong', children: [{ type: 'text', text: '比较集中' }] },
          { type: 'text', text: '。' }
        ]
      },
      { type: 'heading', level: 2, children: [{ type: 'text', text: '依据' }] },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[{ type: 'text', text: 'HHI 0.42' }]]
      }
    ])
  })

  it('有序列表保留起始序号，列表项内换行渲染为 br', () => {
    const blocks = parseMarkdown('3. 第一项\n   续行\n4. 第二项')
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 3,
        items: [
          [
            { type: 'text', text: '第一项' },
            { type: 'br' },
            { type: 'text', text: '续行' }
          ],
          [{ type: 'text', text: '第二项' }]
        ]
      }
    ])
  })

  it('围栏代码块保留原文，行内反引号不解析 markdown', () => {
    const blocks = parseMarkdown('```ts\nconst x = "**不是粗体**"\n```\n\n用 `**原样**` 显示')
    expect(blocks[0]).toEqual({
      type: 'code',
      lang: 'ts',
      text: 'const x = "**不是粗体**"'
    })
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', text: '用 ' },
        { type: 'code', text: '**原样**' },
        { type: 'text', text: ' 显示' }
      ]
    })
  })

  it('解析引用块与表格', () => {
    const blocks = parseMarkdown('> 注意：数据截止 2024-06-01\n\n| 指标 | 数值 |\n| --- | ---: |\n| HHI | 0.420 |')
    expect(blocks[0]).toEqual({
      type: 'blockquote',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', text: '注意：数据截止 2024-06-01' }]
        }
      ]
    })
    expect(blocks[1]).toEqual({
      type: 'table',
      header: [
        [{ type: 'text', text: '指标' }],
        [{ type: 'text', text: '数值' }]
      ],
      rows: [
        [
          [{ type: 'text', text: 'HHI' }],
          [{ type: 'text', text: '0.420' }]
        ]
      ]
    })
  })
})

describe('parseMarkdown — 行内格式与安全边界', () => {
  it('斜体、删除线、自动链接与 http(s) 链接', () => {
    const nodes = parseInline('*略* ~~旧~~ [官方](https://example.com/a) <https://example.org/b>')
    expect(nodes).toEqual([
      { type: 'em', children: [{ type: 'text', text: '略' }] },
      { type: 'text', text: ' ' },
      { type: 'del', children: [{ type: 'text', text: '旧' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', text: '官方' }] },
      { type: 'text', text: ' ' },
      {
        type: 'link',
        href: 'https://example.org/b',
        children: [{ type: 'text', text: 'https://example.org/b' }]
      }
    ])
  })

  it('非 http(s) 链接（javascript/file/相对路径）降级为原文文本', () => {
    for (const source of [
      '[危险](javascript:alert(1))',
      '[本地](file:///etc/passwd)',
      '[相对](/settings)',
      '[凭据](https://user:pass@example.com/x)'
    ]) {
      const nodes = parseInline(source)
      expect(collectTypes(nodes).has('link')).toBe(false)
      expect(nodes.every((n) => n.type === 'text')).toBe(true)
    }
  })

  it('原始 HTML 一律按文本处理，不产生 html 节点', () => {
    const blocks = parseMarkdown('<img src="https://evil.test/x.png" onerror="alert(1)">\n\n<div>块级 HTML</div>')
    const types = collectTypes(blocks)
    expect(types.has('html')).toBe(false)
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        children: [
          {
            type: 'text',
            text: '<img src="https://evil.test/x.png" onerror="alert(1)">'
          }
        ]
      },
      { type: 'paragraph', children: [{ type: 'text', text: '<div>块级 HTML</div>' }] }
    ])
  })

  it('图片只保留 alt，不保留远程地址', () => {
    const nodes = parseInline('![走势图](https://evil.test/track.png)')
    expect(nodes).toEqual([{ type: 'image', alt: '走势图' }])
    expect(JSON.stringify(nodes)).not.toContain('evil.test')
  })

  it('段落内的软换行渲染为 br，而不是空格', () => {
    expect(parseMarkdown('第一行\n第二行')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: '第一行' },
          { type: 'br' },
          { type: 'text', text: '第二行' }
        ]
      }
    ])
  })
})
