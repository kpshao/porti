// 安全 Markdown 解析器（纯函数）：把模型输出解析成固定形状的 AST，由 Markdown 组件渲染。
// 安全契约：不识别原始 HTML（一律按文本）；图片只保留 alt、不保留地址；
// 只有通过共享外链白名单（src/shared/url.ts）的链接才产成 link 节点，其余按原文显示。
// 支持子集：标题、段落、围栏代码、行内代码、粗体/斜体/删除线、列表、引用、表格、分隔线、http(s) 链接。

import { isSafeHttpUrl } from '../../../shared/url'

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] }
  | { type: 'del'; children: MarkdownInline[] }
  | { type: 'link'; href: string; children: MarkdownInline[] }
  | { type: 'image'; alt: string }
  | { type: 'br' }

export type MarkdownBlock =
  | { type: 'heading'; level: number; children: MarkdownInline[] }
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownInline[][] }
  | { type: 'blockquote'; children: MarkdownBlock[] }
  | { type: 'table'; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { type: 'hr' }

const FENCE_RE = /^ {0,3}```([\w+-]*)\s*$/
const FENCE_END_RE = /^ {0,3}```\s*$/
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const BLOCKQUOTE_RE = /^ {0,3}>\s?(.*)$/
const LIST_RE = /^ {0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/
const TABLE_SEP_RE = /^ {0,3}\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/
const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/
const AUTOLINK_RE = /^<(https?:\/\/[^>\s]+)>/

function isOrderedMarker(marker: string): boolean {
  return /^\d/.test(marker)
}

/** 行内解析：返回 AST 节点序列。 */
export function parseInline(text: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') {
      nodes.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]

    if (ch === '\n') {
      flush()
      nodes.push({ type: 'br' })
      i += 1
      continue
    }

    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ type: 'code', text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if (ch === '!' && text[i + 1] === '[') {
      const match = IMAGE_RE.exec(text.slice(i))
      if (match !== null) {
        flush()
        nodes.push({ type: 'image', alt: match[1] })
        i += match[0].length
        continue
      }
    }

    if (ch === '[') {
      const match = LINK_RE.exec(text.slice(i))
      if (match !== null) {
        if (isSafeHttpUrl(match[2])) {
          flush()
          nodes.push({ type: 'link', href: match[2], children: parseInline(match[1]) })
        } else {
          buffer += match[0]
        }
        i += match[0].length
        continue
      }
    }

    if (ch === '<') {
      const match = AUTOLINK_RE.exec(text.slice(i))
      if (match !== null) {
        flush()
        nodes.push({ type: 'link', href: match[1], children: [{ type: 'text', text: match[1] }] })
        i += match[0].length
        continue
      }
      // 原始 HTML 一律按普通字符处理
      buffer += ch
      i += 1
      continue
    }

    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        nodes.push({ type: 'strong', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        nodes.push({ type: 'del', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    if (ch === '*') {
      const end = text.indexOf('*', i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ type: 'em', children: parseInline(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    buffer += ch
    i += 1
  }

  flush()
  return nodes
}

function splitTableRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map((cell) => cell.trim())
}

/** 该行是否开启一个新块（段落收集时用于断行） */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]
  if (line.trim() === '') return true
  if (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    LIST_RE.test(line)
  ) {
    return true
  }
  return line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])
}

function parseBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence !== null) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE_END_RE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1 // 跳过结束围栏；未闭合时吃到文末
      blocks.push({ type: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2])
      })
      i += 1
      continue
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const match = BLOCKQUOTE_RE.exec(lines[i])
        if (match === null) break
        inner.push(match[1])
        i += 1
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner) })
      continue
    }

    const listStart = LIST_RE.exec(line)
    if (listStart !== null) {
      const ordered = isOrderedMarker(listStart[1])
      const start = ordered ? Number.parseInt(listStart[1], 10) : 1
      const items: string[] = []
      while (i < lines.length) {
        const item = LIST_RE.exec(lines[i])
        if (item !== null) {
          if (isOrderedMarker(item[1]) !== ordered) break
          items.push(item[2])
          i += 1
          continue
        }
        if (lines[i].trim() === '') break
        if (/^\s+/.test(lines[i]) && items.length > 0) {
          // 缩进续行归入上一项
          items[items.length - 1] += `\n${lines[i].trim()}`
          i += 1
          continue
        }
        break
      }
      blocks.push({ type: 'list', ordered, start, items: items.map(parseInline) })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitTableRow(line).map(parseInline)
      i += 2
      const rows: MarkdownInline[][][] = []
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]).map(parseInline))
        i += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && !startsBlock(lines, i)) {
      paragraph.push(lines[i])
      i += 1
    }
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) })
    } else {
      // 防御：startsBlock 判定与当前分支不一致时前进一行，避免死循环
      i += 1
    }
  }

  return blocks
}

/** 把 Markdown 源文本解析为块级 AST。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'))
}
