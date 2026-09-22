/** Display UTF-8 URL text without decoding separators, escapes or invisible characters. */
export function displayUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value
  return value.replace(/(?:%[89a-f][0-9a-f])+/gi, (bytes) => {
    try {
      const text = decodeURIComponent(bytes)
      return /[\p{C}\p{Z}]/u.test(text) ? bytes : text
    } catch { return bytes }
  })
}

/** Keep text-fragment navigation intact, but do not show captured prose as an address. */
export function displaySourceUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value
  try {
    const url = new URL(value)
    const directive = url.hash.indexOf(':~:')
    if (directive >= 0 && url.hash.slice(directive + 3).split('&').some((part) => part.startsWith('text='))) {
      url.hash = directive === 1 ? '' : url.hash.slice(0, directive)
      return displayUrl(url.href)
    }
  } catch { /* Non-URL notes and malformed addresses keep their original display. */ }
  return displayUrl(value)
}
