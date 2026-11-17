"""Inventory exact toolchain header bytes used by the candidate build.
This is a review input, not an automatic license conclusion.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--report', type=Path, required=True)
    a = p.parse_args()
    root = a.root.resolve()
    bin_root = (root / 'toolchain/llvm-mingw-20261020-ucrt-x86_64').resolve()
    deps = root / 'candidate-ninja-deps.txt'
    wrap = root / 'candidate-wrapper-headers.txt'
    link = root / 'candidate-link-map.txt'
    paths = set()
    # Ninja deps prints a space-indented absolute dependency per line.
    # Clang -H prints dot-indented include paths.
    for file in [deps, wrap]:
        for line in file.read_text(encoding='utf-8-sig', errors='replace').splitlines():
            value = line.strip()
            value = re.sub(r'^\.+\s+', '', value)
            if not re.match(r'^[A-Za-z]:[\\/]', value):
                continue
            path = Path(value).resolve()
            if path.is_file() and path.is_relative_to(bin_root):
                paths.add(path)
    if len(paths) < 100:
        raise RuntimeError(f'INCOMPLETE_HEADER_INVENTORY={len(paths)}')
    rows, flags = [], []
    pattern = re.compile(r'SPDX-License-Identifier:\s*(?:\(?GPL|\(?LGPL)|GNU (?:Lesser |Library )?General Public License', re.I)
    for path in sorted(paths, key=lambda x: str(x).lower()):
        raw = path.read_bytes()
        name = path.relative_to(bin_root).as_posix()
        text = raw.decode('utf-8', errors='replace')
        risk = [line.strip()[:180] for line in text.splitlines() if pattern.search(line)][:5]
        rows.append({'path': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes':len(raw),
                     'copyleftTextHints':risk})
        if risk:
            flags.append(name)
    data = link.read_bytes()
    if len(data) < 1024:
        raise RuntimeError('EMPTY_LINK_MAP')
    trace = root / 'candidate-link-trace.txt'
    trace_bytes = trace.read_bytes() if trace.exists() else b''
    report = {'headerCount':len(rows), 'headers':rows, 'copyleftTextFlaggedPaths':flags,
              'linkMapSha256':hashlib.sha256(data).hexdigest(),
              'linkTraceSha256':hashlib.sha256(trace_bytes).hexdigest() if trace_bytes else None,
              'status':'review-required', 'distributionReady':False}
    a.report.write_text(json.dumps(report, indent=2) + '\n')
    print(f'CANDIDATE_HEADER_INVENTORY={len(rows)}; copyleft-text flags={len(flags)}; manual license review required')

if __name__ == '__main__':
    main()
