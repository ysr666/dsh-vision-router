import { homedir } from 'node:os'
import { join } from 'node:path'

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
