/**
 * Remove a trailing run of `/` without a backtracking regular expression.
 *
 * Several endpoint builders accept configured/library-provided base URLs.
 * Scanning backward once keeps normalization O(n) even for hostile strings
 * such as a very long slash run followed by a non-slash character.
 */
export function stripTrailingSlashes(value) {
  const text = String(value ?? '')
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1
  return end === text.length ? text : text.slice(0, end)
}
