import { homedir } from 'node:os'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { lstat, open, rename } from 'node:fs/promises'

function sameEntry(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
}

export function sameNativeOcrDirectory(a, b) {
  return a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink() && sameEntry(a, b)
}

function sameRegularFile(a, b) {
  return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() &&
    sameEntry(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

// Do not validate a path and subsequently read that path again. Read only
// from the opened descriptor; bound the actual read even if a file grows.
// O_NOFOLLOW and O_NONBLOCK prevent following the final symlink or hanging
// on a FIFO on POSIX. On Windows compare the opened object with lstat before
// consuming bytes and again afterwards. This is not a sandbox against a
// malicious process running as the same OS user.
export async function readNativeOcrRegularFile(file, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 32 * 1024 * 1024)
    throw Error('invalid native OCR file size limit')
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 :
    (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  const handle = await open(file, flags)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 0 || info.size > maxBytes ||
        !sameRegularFile(info, await lstat(file)))
      throw Error('invalid native OCR file size or type')
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== info.size || !sameRegularFile(info, await handle.stat()) ||
        !sameRegularFile(info, await lstat(file)))
      throw Error('native OCR file changed during read')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}

export async function isOwnedNativeOcrDirectory(root) {
  try {
    const dir = await lstat(root)
    if (!sameNativeOcrDirectory(dir, dir)) return false
    const text = (await readNativeOcrRegularFile(join(root, 'SOURCE-NOTICE.md'), 32 * 1024)).toString('utf8')
    return sameNativeOcrDirectory(dir, await lstat(root)) &&
      text.startsWith('# Locally installed native OCR assets\n') &&
      text.includes('Runtime: Tencent/ncnn @')
  } catch { return false }
}

// Move into a fresh, caller-generated sibling before destructive cleanup.
// If the source was exchanged during the move, preserve the moved directory
// for recovery instead of treating it as an owned installation and deleting it.
export async function moveOwnedNativeOcrDirectory(root, target) {
  const before = await lstat(root)
  if (!sameNativeOcrDirectory(before, before) || !await isOwnedNativeOcrDirectory(root))
    throw Error('refusing to move unowned OCR directory')
  await rename(root, target)
  let verified = false
  try {
    verified = sameNativeOcrDirectory(before, await lstat(target)) && await isOwnedNativeOcrDirectory(target)
  } catch { /* keep the moved directory on any identity-check failure */ }
  if (!verified) throw Error('refusing to remove changed OCR directory; moved directory preserved for recovery')
}

// Owner-installed, integrity-pinned native OCR. Never probe unapproved Linux
// variants or switch a default unless the named worker actually exists.
export function localNativeOcrInstallPaths({
  platform = process.platform, arch = process.arch, home = homedir(),
} = {}) {
  const target = platform + '-' + arch
  if (target !== 'darwin-arm64' && target !== 'win32-x64') return null
  const root = join(home, '.dsh-vision-router', 'ocr', 'ppocrv6-small')
  return Object.freeze({
    root,
    binaryPath: join(root, target === 'win32-x64' ? 'worker.exe' : 'worker'),
    modelDir: join(root, 'models'),
  })
}
