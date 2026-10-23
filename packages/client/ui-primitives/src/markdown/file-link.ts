/** Local Markdown destinations accepted by the file-preview callback. */

/**
 * Decode a file destination with a GitHub-style fragment or colon line suffix.
 * A fragment takes precedence over suffix parsing. Percent-encode literal `?`,
 * `#`, and a colon that would otherwise introduce a numeric line suffix.
 * @param value - Parsed Markdown link destination.
 * @returns A local path and optional first line, or undefined for URLs,
 * fragment-only links, queries, malformed escapes, or invalid line ranges.
 */
export function parseFileLink(value: string): { path: string; line?: number } | undefined {
  const hash = value.indexOf('#')
  let destination = hash < 0 ? value : value.slice(0, hash)
  if (destination.includes('?')) return undefined
  const suffix = hash < 0 ? /:(\d+)(?:-(\d+))?$/.exec(destination) : null
  if (suffix !== null) destination = destination.slice(0, suffix.index)
  let path: string
  try {
    path = decodeURIComponent(destination)
  } catch (_error) {
    // Malformed percent escapes cannot identify a file unambiguously.
    return undefined
  }
  if (path.length === 0 || /[\u0000-\u001f\u007f]/.test(path)
    || /^[\\/]{2}/.test(path)
    || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) return undefined
  if (hash < 0 && suffix === null) return { path }
  const match = suffix ?? /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(value.slice(hash + 1))
  if (match === null) return undefined
  const line = Number(match[1])
  const end = match[2] === undefined ? line : Number(match[2])
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || line < 1 || end < line) return undefined
  return { path, line }
}
