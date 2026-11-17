import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat, readFile } from 'node:fs/promises'

export async function isOwnedNativeOcrDirectory(root) {
  try {
    const dir = await lstat(root)
    if (!dir.isDirectory() || dir.isSymbolicLink()) return false
    const notice = join(root, 'SOURCE-NOTICE.md')
    const info = await lstat(notice)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) return false
    const text = await readFile(notice, 'utf8')
    return text.startsWith('# Locally installed native OCR assets\n') &&
      text.includes('Runtime: Tencent/ncnn @')
  } catch { return false }
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
