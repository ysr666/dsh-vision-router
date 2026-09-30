export function parseVersionComparator(clause) {
  const value = String(clause ?? '')
  if (value === '') return undefined
  if (value.startsWith('>=') || value.startsWith('<=')) {
    const version = value.slice(2)
    return version === '' ? undefined : { op: value.slice(0, 2), version }
  }
  if (value[0] === '>' || value[0] === '<' || value[0] === '=') {
    const version = value.slice(1)
    return version === '' ? undefined : { op: value[0], version }
  }
  return { op: '=', version: value }
}
