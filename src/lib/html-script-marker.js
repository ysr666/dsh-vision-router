function isHtmlSpace(code) {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20
}

function isTagBoundary(char) {
  return char === '>' || char === '/' || (char !== '' && isHtmlSpace(char.charCodeAt(0)))
}

function findOpeningTagEnd(html, start) {
  let quote = ''
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return index
  }
  return -1
}

function openingTagHasAttribute(html, start, end, marker) {
  let index = start
  while (index < end) {
    while (index < end && isHtmlSpace(html.charCodeAt(index))) index += 1
    if (index >= end) break
    if (html[index] === '/') {
      index += 1
      continue
    }

    const nameStart = index
    while (index < end) {
      const char = html[index]
      if (char === '=' || char === '/' || isHtmlSpace(char.charCodeAt(0))) break
      index += 1
    }
    if (index === nameStart) {
      index += 1
      continue
    }
    if (html.slice(nameStart, index).toLowerCase() === marker) return true

    while (index < end && isHtmlSpace(html.charCodeAt(index))) index += 1
    if (html[index] !== '=') continue
    index += 1
    while (index < end && isHtmlSpace(html.charCodeAt(index))) index += 1
    if (index >= end) break

    const quote = html[index]
    if (quote === '"' || quote === "'") {
      index += 1
      while (index < end && html[index] !== quote) index += 1
      if (index < end) index += 1
      continue
    }
    while (index < end && !isHtmlSpace(html.charCodeAt(index))) index += 1
  }
  return false
}

function findClosingScript(html, start) {
  const lower = html.toLowerCase()
  let index = start
  while (index < html.length) {
    const close = lower.indexOf('</script', index)
    if (close === -1) return -1
    const boundary = html[close + 8] ?? ''
    if (isTagBoundary(boundary)) return close
    index = close + 2
  }
  return -1
}

export function htmlHasScriptMarker(html, marker) {
  if (typeof html !== 'string' || typeof marker !== 'string' || marker === '') return false
  const markerName = marker.toLowerCase()
  const lower = html.toLowerCase()
  let index = 0

  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) return false

    if (html.startsWith('<!--', open)) {
      const commentEnd = html.indexOf('-->', open + 4)
      if (commentEnd === -1) return false
      index = commentEnd + 3
      continue
    }

    if (lower.slice(open + 1, open + 7) !== 'script' || !isTagBoundary(html[open + 7] ?? '')) {
      index = open + 1
      continue
    }

    const tagEnd = findOpeningTagEnd(html, open + 7)
    if (tagEnd === -1) return false
    if (openingTagHasAttribute(html, open + 7, tagEnd, markerName)) return true

    const close = findClosingScript(html, tagEnd + 1)
    if (close === -1) return false
    const closeEnd = html.indexOf('>', close + 8)
    index = closeEnd === -1 ? html.length : closeEnd + 1
  }

  return false
}
