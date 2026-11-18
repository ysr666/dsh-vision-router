#!/usr/bin/env python3
"""Reconstruct the selected Windows CRT objects from upstream source on Apple Silicon.

Only fixed-hash official input archives are consumed. The historical normalized
stock object inventory is regenerated from the official Windows ZIP, not from
private replacement objects. No upload, installation or distribution admission.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import struct
import subprocess
import tarfile
import zipfile

MINGW_REV = '0d6dfbc348dfad714761c0a7151615767f96bcb5'
SOURCE_SHA = '03f717ddb9005d6519e38434359af281d0819d5d468a42578e28bd0fd8e31d0c'
TOOL_SHA = 'e9c13e4ede38e715003ffc674d4d00a1088df8235439d1f0c16188ff0704c17e'
WINDOWS_ZIP_SHA = 'fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd'
STOCK_INVENTORY_SHA = '02a0118858bad374d4abb3f104c86b6a4ec737f8b559109eb74be61c4756e941'
LEGACY_HEADER_SHA = '09f6041cdc0f2f3325828a0e1bfb05e2fb4fb0a73cf715a3b6cb5315612c8c56'
LEDGER_BLOB = 'c033b18fa78d20f16d0fed143b5dac82079ea772'
LLVM_HEADER_SHA = 'ce6e43d79dc89b50208ecf259b1ffd519f5a78cd3a2c7fcaac6386f376b89fef'
TOOL_NAME = 'llvm-mingw-20261020-ucrt-macos-universal'
WINDOWS_TOOL_NAME = 'llvm-mingw-20261020-ucrt-x86_64'
OLD_WORKER_SHA = '4f7ad042349239baca6a654d8ca31937c2c49886f6f51413c8447071ff80bfa8'
RISK = re.compile(r'\b(?:SPDX-License-Identifier:.*(?:GPL|LGPL|AGPL)|GNU (?:Lesser |Library )?General Public License|Cephes|Stephen L\. Moshier)\b', re.I)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def normalized_coff(data):
    """Historical normalization: section data, flags and relocation symbols.
    Excludes debug/address-significance metadata, not a full equivalence proof.
    """
    machine, n, _, sym, nsy, opt, _ = struct.unpack_from('<HHIIIHH', data)
    require(machine == 0x8664 and opt == 0 and 0 < n < 1000, 'UNEXPECTED_COFF_HEADER')
    off = sym + 18 * nsy
    length = struct.unpack_from('<I', data, off)[0]
    require(length >= 4 and off + length <= len(data), 'BAD_COFF_STRING_TABLE')
    strings = data[off:off+length]

    def name(s, section=False):
        if section and s.startswith(b'/'):
            return strings[int(s.rstrip(b'\0')[1:]):].split(b'\0', 1)[0].decode('utf8')
        if not section and s[:4] == b'\0' * 4:
            return strings[struct.unpack_from('<I', s, 4)[0]:].split(b'\0', 1)[0].decode('utf8')
        return s.rstrip(b'\0').decode('utf8')

    sections = []
    for k in range(n):
        pos = 20 + 40 * k
        nm = name(data[pos:pos+8], True)
        _, _, size, ptr, rel, _, nrel, _, flags = struct.unpack_from('<IIIIIIHHI', data, pos+8)
        require(not ptr or ptr + size <= len(data), 'BAD_COFF_SECTION')
        require(not nrel or rel + nrel * 10 <= len(data), 'BAD_COFF_RELOCATION')
        sections.append((nm, size, ptr, rel, nrel, flags))
    symbols = {}
    i = 0
    while i < nsy:
        row = data[sym+18*i:sym+18*(i+1)]
        v, si, ty, cls, aux = struct.unpack_from('<IhHBB', row, 8)
        require(si <= n and i + aux < nsy, 'BAD_COFF_SYMBOL')
        symbols[i] = [name(row[:8]), v, sections[si-1][0] if si > 0 else str(si), ty, cls]
        i += 1 + aux
    normalized = []
    for nm, size, ptr, rel, nrel, flags in sections:
        if nm.startswith(('.debug', '.llvm_addrsig', '.llvm.call-graph-profile')):
            continue
        require(not flags & 0x1000000, 'UNSUPPORTED_COFF_RELOCATION_OVERFLOW')
        relocations = []
        for j in range(nrel):
            addr, si, ty = struct.unpack_from('<IIH', data, rel+10*j)
            relocations.append([addr, ty, symbols[si]])
        normalized.append({'name': nm, 'bytes': size, 'flags': flags,
                           'dataSha256': sha(data[ptr:ptr+size]) if ptr else None,
                           'relocations': relocations})
    return sha(json.dumps(normalized, sort_keys=True, separators=(',', ':')).encode())


def read_ledger(repo):
    data = (repo / 'quality/native-ocr-mingw-source-evidence.json').read_bytes()
    blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    require(blob == LEDGER_BLOB, 'SOURCE_LEDGER_CHANGED')
    ledger = json.loads(data)
    require(ledger['sourceRevision'] == MINGW_REV and ledger['worker']['sha256'] == OLD_WORKER_SHA,
            'LEDGER_IDENTITY_MISMATCH')
    require(len(ledger['sourceFiles']) == 70, 'EXPECTED_70_SELECTED_OBJECTS')
    return ledger


def regenerate_stock(archive, ledger, out, ar):
    """Extract only the six exact audited file entries; never run Windows code."""
    require(file_sha(archive) == WINDOWS_ZIP_SHA, 'WINDOWS_TOOLCHAIN_HASH_MISMATCH')
    out.mkdir()
    files = {}
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        rows = [(x['archive'], x) for x in ledger['linkedArchives']]
        rows += [(x['name'], x) for x in ledger['startupObjects']]
        for name, row in rows:
            key = WINDOWS_TOOL_NAME + '/' + row['relativePath']
            require(names.count(key) == 1, 'STOCK_ENTRY_MISSING_OR_AMBIGUOUS: ' + name)
            info = z.getinfo(key)
            require(info.file_size == row['bytes'], 'STOCK_ENTRY_SIZE_MISMATCH: ' + name)
            data = z.read(info)
            require(sha(data) == row['sha256'], 'STOCK_ENTRY_HASH_MISMATCH: ' + name)
            dest = out/name
            dest.write_bytes(data)
            files[name] = dest
    stock = []
    for row in ledger['sourceFiles']:
        member, archive = row['member'], row['archive']
        if archive == 'startup':
            data = files[member].read_bytes()
        else:
            data = subprocess.check_output([str(ar), 'p', str(files[archive]), member], timeout=30)
        require(bool(data), 'EMPTY_STOCK_OBJECT: ' + member)
        stock.append({'archive': archive, 'member': member, 'normalizedSha256': normalized_coff(data)})
    # The original Windows audit wrote JSON using CRLF. Recreate those exact
    # serialization bytes and verify against its independently recorded SHA.
    serialized = (json.dumps(stock, indent=2) + '\n').replace('\n', '\r\n').encode()
    require(sha(serialized) == STOCK_INVENTORY_SHA, 'HISTORICAL_STOCK_INVENTORY_MISMATCH')
    (out/'stock-crt-normalized-coff.json').write_bytes(serialized)
    return [dict(row, expectedNormalized=expected['normalizedSha256'])
            for row, expected in zip(ledger['sourceFiles'], stock)
            if (row['archive'], row['member']) not in {('startup', 'crtbegin.o'), ('startup', 'crtend.o')}]


def find_targets(makefile, rows):
    result = []
    for x in rows:
        member = re.escape(x['member'])
        targets = sorted(set(re.findall(r'(?m)^([^\s:#]+/' + member + r'|' + member + r')\s*:', makefile)))
        require(len(targets) == 1, 'AMBIGUOUS_MAKE_TARGET: ' + x['member'])
        target = targets[0]
        # Automake places archive members under their source subdirectory,
        # while the startup object is generated in lib64. Bind the full
        # target to the reviewed ledger, not an arbitrary Makefile path.
        source_parent = Path(x['source']).parent.relative_to('mingw-w64-crt')
        expected = ('lib64/' if x['archive'] == 'startup' else source_parent.as_posix() + '/') + x['member']
        require(target == expected and all(re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', part)
                                          for part in target.split('/')),
                'BAD_MAKE_TARGET: ' + target)
        result.append(dict(x, target=target))
    require(len(result) == 68 and len({x['target'] for x in result}) == 68, 'TARGET_SET_MISMATCH')
    return result


def compile_recipe(lines, row, source, tool, build, overlay, output):
    lookup = 'lib64/crt1.o' if row['target'] == 'lib64/crt2.o' else row['target']
    candidates = [l for l in lines if l.startswith('x86_64-w64-mingw32-gcc ') and
                  re.search(r'-o ' + re.escape(lookup) + r'(?:\s|$)', l)]
    require(bool(candidates), 'MISSING_REAL_COMPILE_COMMAND: ' + lookup)
    recipe = re.sub(r"\x60test -f '[^']+' \|\| echo '[^']+'\x60[^\s]+",
                    str(source / row['source']), candidates[-1])
    require('\x60' not in recipe and '\n' not in recipe, 'UNSUPPORTED_SHELL_RECIPE')
    args = shlex.split(recipe)
    require(args[0] == 'x86_64-w64-mingw32-gcc' and '-c' in args and '-o' in args,
            'UNEXPECTED_COMPILE_RECIPE')
    require(all(x not in (';', '&&', '||', '|', '>', '<') for x in args), 'SHELL_METACHAR_RECIPE')
    args[0] = str(tool / 'bin/x86_64-w64-mingw32-gcc')
    include = '-I' + str(tool / 'x86_64-w64-mingw32/include')
    require(include in args, 'EXPECTED_SYSROOT_INCLUDE_MISSING')
    args = [x for x in args if x != include]
    args[1:1] = ['-ivfsoverlay', str(overlay)]
    args[args.index('-o')+1] = str(output)
    dependency = output.with_suffix('.d')
    if '-MF' in args:
        args[args.index('-MF')+1] = str(dependency)
    else:
        args += ['-MD', '-MF', str(dependency)]
    return args, dependency


def dependencies(dep, build, roots):
    lines = dep.read_text().replace('\\\n', ' ').splitlines()
    require(bool(lines) and ':' in lines[0], 'EMPTY_DEPFILE')
    paths = shlex.split(lines[0].split(':', 1)[1])
    require(bool(paths), 'EMPTY_DEPENDENCY_SET')
    roots = [(Path(root).resolve(), label) for root, label in roots]
    result = {}
    for token in paths:
        p = Path(token)
        p = (p if p.is_absolute() else build / p).resolve()
        key = None
        for root, label in roots:
            if p.is_relative_to(root):
                key = label + '/' + p.relative_to(root).as_posix()
                break
        require(key and p.is_file(), 'UNEXPECTED_DEPENDENCY_PATH: ' + str(p))
        require(not key.startswith('private-overlay/') or key == 'private-overlay/dvr-llvm-stdarg-forwarder.h',
                'UNEXPECTED_OVERLAY_DEPENDENCY: ' + key)
        require(not (key.endswith('/stdarg.h') and '/lib/clang/' not in key), 'LEGACY_STDARG_DEPENDENCY')
        b = p.read_bytes()
        hints = [{'line': i+1, 'text': line.strip()[:240]} for i, line in enumerate(b.decode('utf8', 'replace').splitlines()) if RISK.search(line)]
        if hints:
            require(key == 'toolchain/generic-w64-mingw32/include/math.h' and
                    hints == [{'line': 822, 'text': '/* Implementations adapted from Cephes versions */'}],
                    'UNREVIEWED_DEPENDENCY_NOTICE: ' + key)
        result[key] = {'sha256': sha(b), 'bytes': len(b), 'riskHints': hints}
    return result


def deterministic_zip(dest, members, manifest):
    data = dict(members)
    data['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    with zipfile.ZipFile(dest, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, content in sorted(data.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100600 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def run(a):
    require(platform.system() == 'Darwin' and platform.machine() == 'arm64', 'APPLE_SILICON_REQUIRED')
    repo, source_archive, tool_archive, windows_zip, lab = [getattr(a, k).resolve() for k in
        ('repo', 'source_tar', 'compiler_tar', 'stock_windows_zip', 'out')]
    require(not lab.exists() and not lab.is_relative_to(repo) and not repo.is_relative_to(lab), 'FRESH_SEPARATE_OUTPUT_REQUIRED')
    require(re.fullmatch(r'/[A-Za-z0-9_./-]+', str(lab)), 'USE_SIMPLE_ABSOLUTE_BUILD_PATH')
    require(file_sha(source_archive) == SOURCE_SHA, 'SOURCE_ARCHIVE_HASH_MISMATCH')
    require(file_sha(tool_archive) == TOOL_SHA, 'COMPILER_ARCHIVE_HASH_MISMATCH')
    ledger = read_ledger(repo)
    lab.mkdir(mode=0o700, parents=True)
    for archive in [source_archive, tool_archive]:
        with tarfile.open(archive) as tf:
            tf.extractall(lab, filter='data')
    source = lab / ('mingw-w64-' + MINGW_REV)
    tool = lab / TOOL_NAME
    header = tool / 'generic-w64-mingw32/include/stdarg.h'
    llvm = tool / 'lib/clang/23/include/stdarg.h'
    require(file_sha(header) == LEGACY_HEADER_SHA and file_sha(llvm) == LLVM_HEADER_SHA, 'STDARG_INPUT_HASH_MISMATCH')
    rows = regenerate_stock(windows_zip, ledger, lab/'stock-crt', tool/'bin/llvm-ar')
    require(len(rows) == 68, 'EXPECTED_68_NONEMPTY_OBJECTS')
    for row in rows:
        require(file_sha(source/row['source']) == row['sha256'], 'SOURCE_FILE_IDENTITY_MISMATCH: ' + row['member'])
    print('HISTORICAL_STOCK_INVENTORY_REGENERATED 70/70', flush=True)
    env = dict(os.environ, PATH=str(tool / 'bin') + ':/opt/homebrew/bin:/usr/bin:/bin', LC_ALL='C')
    for k in ('SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'CC', 'CXX', 'CFLAGS', 'CPPFLAGS', 'LDFLAGS'):
        env.pop(k, None)
    build = lab / 'build-x86_64'
    build.mkdir()
    config = [str(source/'mingw-w64-crt/configure'), '--host=x86_64-w64-mingw32',
              '--prefix=' + str(tool/'x86_64-w64-mingw32'), '--disable-lib32', '--enable-lib64',
              '--with-default-msvcrt=ucrt', '--enable-silent-rules', '--enable-cfguard']
    with (lab/'configure.log').open('wb') as f:
        subprocess.run(config, cwd=build, env=env, stdout=f, stderr=subprocess.STDOUT, check=True, timeout=300)
    rows = find_targets((build/'Makefile').read_text(), rows)
    (build/'lib64').mkdir(exist_ok=True)
    with (lab/'stock-rebuild.log').open('wb') as f:
        subprocess.run(['make', '-j4', 'V=1', *[x['target'] for x in rows]], cwd=build,
                       env=env, stdout=f, stderr=subprocess.STDOUT, check=True, timeout=300)
    for x in rows:
        require(normalized_coff((build/x['target']).read_bytes()) == x['expectedNormalized'],
                'STOCK_REBUILD_COFF_MISMATCH: ' + x['member'])
    print('HISTORICAL_STOCK_RECONSTRUCTION_MATCH 68/68', flush=True)
    replacement = lab / 'dvr-llvm-stdarg-forwarder.h'
    replacement.write_text('/* DVR private audit: use Clang standard varargs implementation. */\n#include "' + str(llvm) + '"\n#include <_mingw_stdarg.h>\n', encoding='utf8')
    aliases = set()
    for p in [header, tool/'x86_64-w64-mingw32/include/stdarg.h']:
        aliases.update([str(p), str(p.resolve())])
        if str(p).startswith('/tmp/'):
            aliases.add('/private' + str(p))
    overlay = lab/'llvm-stdarg-vfs.json'
    overlay.write_text(json.dumps({'version': 0, 'case-sensitive': True, 'use-external-names': True,
        'roots': [{'type': 'file', 'name': n, 'external-contents': str(replacement)} for n in sorted(aliases)]}, indent=2)+'\n')
    lines = (lab/'stock-rebuild.log').read_text().splitlines()
    output = lab/'replacement-objects'
    roots = [(tool.resolve(), 'toolchain'), (source.resolve(), 'source'), (build.resolve(), 'build'), (lab.resolve(), 'private-overlay')]
    def compile_one(row):
        target = output/row['target']
        target.parent.mkdir(parents=True, exist_ok=True)
        args, dep = compile_recipe(lines, row, source, tool, build, overlay, target)
        with target.with_suffix('.log').open('wb') as f:
            subprocess.run(args, cwd=build, env=env, stdout=f, stderr=subprocess.STDOUT, check=True, timeout=60)
        require(normalized_coff(target.read_bytes()) == row['expectedNormalized'], 'REMEDIATED_COFF_MISMATCH: ' + row['member'])
        deps = dependencies(dep, build, roots)
        stripped = target.with_suffix('.stripped.o')
        subprocess.run([str(tool/'bin/llvm-objcopy'), '--strip-debug', str(target), str(stripped)], check=True, timeout=30)
        return row, stripped.read_bytes(), deps
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        built = list(pool.map(compile_one, rows))
    aggregate, per_object, members, manifest = {}, {}, {}, []
    for x, data, deps in built:
        for key, entry in deps.items():
            require(key not in aggregate or aggregate[key] == entry, 'DEPENDENCY_IDENTITY_CHANGED')
            aggregate[key] = entry
        name = x['archive'] + '/' + x['member']
        require(name not in members, 'DUPLICATE_REPLACEMENT_MEMBER')
        members[name] = data
        manifest.append({'archive': x['archive'], 'member': x['member'], 'sha256': sha(data), 'bytes': len(data)})
        per_object[name] = {'normalizedSha256': x['expectedNormalized'], 'dependencies': sorted(deps)}
    require(len(aggregate) == 419 and len(manifest) == 68, 'DEPENDENCY_OR_MEMBER_COUNT_CHANGED')
    require(file_sha(header) == LEGACY_HEADER_SHA and file_sha(llvm) == LLVM_HEADER_SHA, 'STOCK_HEADERS_CHANGED')
    z = lab/'crt-reconstructed.zip'
    deterministic_zip(z, members, manifest)
    report = {'schemaVersion': 1, 'sourceRevision': MINGW_REV, 'compilerArchiveSha256': TOOL_SHA,
              'stockWindowsZipSha256': WINDOWS_ZIP_SHA, 'stockInventorySha256': STOCK_INVENTORY_SHA,
              'normalizedMatches': 68, 'dependencies': aggregate, 'perObject': per_object,
              'replacementManifest': manifest, 'replacementArchiveSha256': file_sha(z),
              'distributionReady': False,
              'scope': 'Source-to-object output only. Fresh Windows relink and exact worker identity acceptance required.'}
    (lab/'crt-reconstruction-evidence.json').write_text(json.dumps(report, indent=2)+'\n')
    print('CRT_SOURCE_RECONSTRUCTION_MATCH', report['replacementArchiveSha256'], 'distributionReady=false')


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'source-tar', 'compiler-tar', 'stock-windows-zip', 'out'):
        p.add_argument('--'+name, type=Path, required=True)
    run(p.parse_args())


if __name__ == '__main__':
    main()
