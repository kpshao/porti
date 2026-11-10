// AI 回答的 Markdown 渲染：解析器与安全契约见 utils/markdown。
// 链接不应用内导航：点击后交给主进程二次校验并由系统浏览器打开。

import { useMemo } from 'react'
import { parseMarkdown } from '../utils/markdown'
import type { MarkdownBlock, MarkdownInline } from '../utils/markdown'

function openExternal(href: string): void {
  void window.api.aiOpenExternal(href)
}

function InlineNodes({ nodes }: { nodes: MarkdownInline[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'text':
            return <span key={index}>{node.text}</span>
          case 'br':
            return <br key={index} />
          case 'code':
            return (
              <code key={index} className="md-code">
                {node.text}
              </code>
            )
          case 'strong':
            return (
              <strong key={index}>
                <InlineNodes nodes={node.children} />
              </strong>
            )
          case 'em':
            return (
              <em key={index}>
                <InlineNodes nodes={node.children} />
              </em>
            )
          case 'del':
            return (
              <del key={index}>
                <InlineNodes nodes={node.children} />
              </del>
            )
          case 'link':
            return (
              <a
                key={index}
                className="md-link"
                href={node.href}
                onClick={(event) => {
                  event.preventDefault()
                  openExternal(node.href)
                }}
                onAuxClick={(event) => event.preventDefault()}
              >
                <InlineNodes nodes={node.children} />
              </a>
            )
          case 'image':
            // 图片一律不加载（含远程地址）：只展示替代文本占位
            return (
              <span key={index} className="md-image">
                [图片：{node.alt === '' ? '未显示' : node.alt}]
              </span>
            )
        }
      })}
    </>
  )
}

/** Markdown 标题映射到页面内的低层级标题，避免出现第二个 h1 */
function headingTag(level: number): 'h3' | 'h4' | 'h5' | 'h6' {
  if (level <= 1) return 'h3'
  if (level === 2) return 'h4'
  if (level === 3) return 'h5'
  return 'h6'
}

function Block({ block }: { block: MarkdownBlock }): React.JSX.Element {
  switch (block.type) {
    case 'heading': {
      const Tag = headingTag(block.level)
      return (
        <Tag className="md-heading">
          <InlineNodes nodes={block.children} />
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p className="md-paragraph">
          <InlineNodes nodes={block.children} />
        </p>
      )
    case 'code':
      return (
        <pre className="md-pre">
          <code>{block.text}</code>
        </pre>
      )
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <InlineNodes nodes={item} />
        </li>
      ))
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      )
    }
    case 'blockquote':
      return (
        <blockquote className="md-quote">
          {block.children.map((child, index) => (
            <Block key={index} block={child} />
          ))}
        </blockquote>
      )
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index}>
                    <InlineNodes nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      <InlineNodes nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <hr className="md-hr" />
  }
}

export default function Markdown({ source }: { source: string }): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  )
}
