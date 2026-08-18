from pathlib import Path

path = Path('index.js')
text = path.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    text = text.replace(old, new, 1)


replace_once(
    "  proxyHosts: z.array(z.string()).default([...DEFAULT_PROXY_HOSTS]),\n  freeFallback: z.boolean().default(true),\n",
    "  proxyHosts: z.array(z.string()).default([...DEFAULT_PROXY_HOSTS]),\n"
    "  // Remote browsers are intentionally unable to use DSH's broad settings.*\n"
    "  // plane. This narrow Vision Router bridge is opt-in and still uses DSH's\n"
    "  // trusted-host transport fence. Only a loopback/local settings page may\n"
    "  // change this permission; the remote bridge rejects writes to the field.\n"
    "  allowRemoteSettings: z.boolean().default(false),\n"
    "  freeFallback: z.boolean().default(true),\n",
    'allowRemoteSettings schema',
)

replace_once(
    "export function artifactStemOf(imagePath, suffix) {\n",
    "/** Resolve a configured artifact root and refuse lexical workspace escapes. */\n"
    "export function resolveArtifactRootPath(workspace, configured) {\n"
    "  const root = path.resolve(String(workspace ?? ''))\n"
    "  const raw = typeof configured === 'string' && configured.trim() !== ''\n"
    "    ? configured.trim()\n"
    "    : '.dsh-vision-router/artifacts'\n"
    "  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {\n"
    "    throw new Error('artifactsDir must be relative to the session workspace')\n"
    "  }\n"
    "  const target = path.resolve(root, raw)\n"
    "  const relative = path.relative(root, target)\n"
    "  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {\n"
    "    throw new Error('artifactsDir must stay inside the session workspace')\n"
    "  }\n"
    "  return target\n"
    "}\n\n"
    "export function artifactStemOf(imagePath, suffix) {\n",
    'artifact root public contract',
)

path.write_text(text, encoding='utf-8')
print('latest-main index semantics merged into batch3')
