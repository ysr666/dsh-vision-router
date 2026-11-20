// Read a native OCR archive through one verified file descriptor. A pathname
// check followed by path-based readFile is vulnerable to replacement races.
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

const MAX_BYTES = 64 * 1024 * 1024

export async function readBoundedNativeOcrArchive(path, { minBytes = 128, maxBytes = MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(minBytes) || !Number.isSafeInteger(maxBytes) ||
      minBytes < 0 || maxBytes > MAX_BYTES || minBytes > maxBytes) {
    throw Error('invalid native OCR archive size bounds')
  }
  // POSIX rejects symlinks at open; on Windows, cross-check the opened file's
  // identity against lstat and always read from the opened descriptor.
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0))
  const file = await open(path, flags)
  try {
    const [opened, named] = await Promise.all([file.stat(), lstat(path)])
    const size = opened.size
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
        opened.dev !== named.dev || opened.ino !== named.ino ||
        !Number.isSafeInteger(size) || size < minBytes || size > maxBytes) {
      throw Error('unsafe native OCR archive')
    }
    // Cap reads even if a concurrent writer extends the file after stat.
    const bytes = Buffer.allocUnsafe(size + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length !== size || (await file.stat()).size !== size) {
      throw Error('native OCR archive changed during read')
    }
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}
