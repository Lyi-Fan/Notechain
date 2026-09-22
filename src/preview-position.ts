function normalizedText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function headingLevel(element: Element) {
  return /^H[1-6]$/.test(element.tagName) ? Number(element.tagName.slice(1)) : 0
}

function headingForHash(reader: HTMLElement, href: string) {
  const hashIndex = href.indexOf('#')
  if (hashIndex < 0 || !href.slice(hashIndex + 1)) return null
  let id = href.slice(hashIndex + 1)
  try { id = decodeURIComponent(id) } catch { /* Keep malformed fragments inert. */ }
  return [...reader.querySelectorAll<HTMLElement>('[id]')].find((element) => element.id === id) ?? null
}

function textNodesInSection(reader: HTMLElement, heading: HTMLElement | null) {
  if (!heading) return textNodes(reader)
  const level = headingLevel(heading)
  const nodes: TextSegment[] = []
  let current: Element | null = heading
  while (current) {
    if (current !== heading && headingLevel(current) && headingLevel(current) <= level) break
    nodes.push(...textNodes(current))
    current = current.nextElementSibling
  }
  return nodes
}

interface TextSegment { node: Text; block: Element | null }

function textNodes(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: TextSegment[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.textContent) {
      const text = node as Text
      nodes.push({
        node: text,
        // Inline markup should read as a continuous sentence, whereas adjacent
        // paragraphs/list cells need a separator for excerpt matching.
        block: text.parentElement?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th') ?? null,
      })
    }
  }
  return nodes
}

function excerptRange(nodes: TextSegment[], excerpt: string) {
  const fold = (value: string) => {
    let result = ''
    for (const character of value) result += character.toLowerCase()
    return result
  }
  const needle = fold(normalizedText(excerpt))
  if (!needle) return null
  let text = ''
  let previousBlock: Element | null | undefined
  let hasText = false
  let previousWhitespace = false
  const append = (value: string) => { text += fold(value) }
  const visit = (onText?: (node: Text, start: number, end: number, sourceStart: number, sourceEnd: number) => void) => {
    previousBlock = undefined
    hasText = false
    previousWhitespace = false
    for (const { node, block } of nodes) {
      if (hasText && previousBlock !== block && !previousWhitespace) {
        text += ' '
        previousWhitespace = true
      }
      const value = node.textContent ?? ''
      for (let offset = 0; offset < value.length;) {
        const character = String.fromCodePoint(value.codePointAt(offset) ?? 0)
        if (/\s/u.test(character)) {
          if (hasText && !previousWhitespace) {
            const start = text.length
            append(' ')
            onText?.(node, start, text.length, offset, offset + character.length)
          }
          previousWhitespace = true
        } else {
          const start = text.length
          append(character)
          onText?.(node, start, text.length, offset, offset + character.length)
          hasText = true
          previousWhitespace = false
        }
        offset += character.length
      }
      previousBlock = block
    }
  }
  visit()
  const index = text.indexOf(needle), end = index + needle.length
  if (index < 0) return null
  let first: { node: Text; offset: number } | undefined
  let last: { node: Text; offset: number } | undefined
  // Map only the matched interval back to the DOM after finding it in the
  // normalized corpus. This avoids allocating a locator for every character.
  text = ''
  visit((node, start, finish, sourceStart, sourceEnd) => {
    if (finish <= index || start >= end) return
    if (!first) first = { node, offset: sourceStart }
    last = { node, offset: sourceEnd }
  })
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset)
  return range
}

export function positionPreviewReader(reader: HTMLElement, href: string, excerpt?: string) {
  const heading = headingForHash(reader, href)
  const range = excerpt ? excerptRange(textNodesInSection(reader, heading), excerpt) : null
  const rect = range?.getBoundingClientRect() ?? heading?.getBoundingClientRect()
  if (!rect) return false
  const readerRect = reader.getBoundingClientRect()
  reader.scrollTop += rect.top - readerRect.top - 16
  return true
}
