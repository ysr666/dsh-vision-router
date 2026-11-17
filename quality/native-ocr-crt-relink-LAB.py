"""Re-link the private, audited Windows OCR candidate. Never publishes or edits the input toolchain."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

REPLACEMENT_SHA256 = '011c1d2777f991641afb8373fd2ab5dcec4a98da0441251bd7fef7bb75349b0b'
OLD_WORKER_SHA256 = '4f7ad042349239baca6a654d8ca31937c2c49886f6f51413c8447071ff80bfa8'
NEW_WORKER_SHA256 = 'd1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166'
NCNN_ARCHIVE_SHA256 = '1346fc6c0728de98a0f198a75898f428a15f2ea6208bfd1e90ddbc1d4c041dd2'
TOOLCHAIN = 'llvm-mingw-20261020-ucrt-x86_64'


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run():
    p = argparse.ArgumentParser(description=__doc__)
    for arg in ('lab-root', 'repo-root', 'replacement-zip', 'out'):
        p.add_argument('--' + arg, required=True, type=Path)
    a = p.parse_args()
    root, repo, archive, out = (a.lab_root.resolve(), a.repo_root.resolve(),
                               a.replacement_zip.resolve(), a.out.resolve())
    require(os.name == 'nt', 'Windows x64 build host required')
    require(not out.exists() and not out.is_relative_to(root) and not root.is_relative_to(out)
            and not out.is_relative_to(repo) and not repo.is_relative_to(out),
            'Use a fresh, separate private output directory')
    require(sha(archive) == REPLACEMENT_SHA256, 'Private replacement archive identity mismatch')
    require(sha(root / (TOOLCHAIN + '.zip')) ==
            'fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd',
            'Original toolchain archive identity mismatch')
    prior = json.loads((repo / 'quality/native-ocr-mingw-source-evidence.json').read_text())
    local = json.loads((root / 'candidate-license-evidence-local/link-inventory.json').read_text())
    require(prior['worker']['sha256'] == local['worker']['sha256'] == OLD_WORKER_SHA256
            and sha(root / 'candidate-license-evidence-local/worker.exe') == OLD_WORKER_SHA256,
            'Unrecognized original candidate')
    ncnn = root / 'ncnn-build-windows-llvm/src/libncnn.a'
    require(sha(ncnn) == NCNN_ARCHIVE_SHA256 ==
            next(x['sha256'] for x in local['archives'] if x['archive'] == 'libncnn.a'),
            'Unrecognized local ncnn archive')
    cpp = repo / 'quality/native-ocr-lab.cpp'
    require(sha(cpp) == '6e3d7e41bd4599b7f5625cd103935d1cc015295ac50b4abcfaa3d3913d5b091d',
            'Wrapper source identity mismatch')
    stock = root / 'toolchain' / TOOLCHAIN
    librel = Path('x86_64-w64-mingw32/lib')
    for x in prior['linkedArchives']:
        require(sha(stock / librel / x['archive']) == x['sha256'], 'Stock CRT archive mismatch')
    for x in prior['startupObjects']:
        require(sha(stock / librel / x['name']) == x['sha256'], 'Stock startup mismatch')
    require(sha(stock / 'include/stdarg.h') ==
            'ce6e43d79dc89b50208ecf259b1ffd519f5a78cd3a2c7fcaac6386f376b89fef',
            'Expected previously audited private LLVM header replacement')
    expected = {(x['archive'], x['member']) for x in prior['sourceFiles']} - {
        ('startup', 'crtbegin.o'), ('startup', 'crtend.o')}
    out.mkdir(parents=True)
    objects = out / 'members'
    with zipfile.ZipFile(archive) as z:
        manifest = json.loads(z.read('manifest.json'))
        require(len(manifest) == len(expected) == 68 and
                {(x['archive'], x['member']) for x in manifest} == expected,
                'Unexpected replacement members')
        names = set(z.namelist())
        files = {x['archive'] + '/' + x['member'] for x in manifest}
        require(names == files | {'manifest.json'} and len(names) == len(z.infolist()),
                'Unexpected replacement archive paths')
        for x in manifest:
            name = x['archive'] + '/' + x['member']
            b = z.read(name)
            require(len(b) == x['bytes'] and hashlib.sha256(b).hexdigest() == x['sha256'],
                    'Replacement object integrity mismatch')
            f = objects / name
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(b)
    tool = out / 'toolchain' / TOOLCHAIN
    shutil.copytree(stock, tool)
    lib = tool / librel
    ar = tool / 'bin/llvm-ar.exe'
    for name in sorted({x['archive'] for x in manifest}):
        items = [objects / name / x['member'] for x in manifest if x['archive'] == name]
        if name == 'startup':
            require(len(items) == 1 and items[0].name == 'crt2.o', 'Unexpected startup replacement')
            shutil.copyfile(items[0], lib / 'crt2.o')
        else:
            subprocess.run([str(ar), 'r', str(lib / name), *map(str, items)], check=True,
                           capture_output=True, timeout=90)
    for x in manifest:
        if x['archive'] == 'startup':
            b = (lib / x['member']).read_bytes()
        else:
            b = subprocess.check_output([str(ar), 'p', str(lib / x['archive']), x['member']],
                                        timeout=20)
        require(hashlib.sha256(b).hexdigest() == x['sha256'], 'Linked archive replacement failed')
    ncnn_copy = out / 'ncnn-build-windows-llvm/src/libncnn.a'
    ncnn_copy.parent.mkdir(parents=True)
    shutil.copyfile(ncnn, ncnn_copy)
    require(sha(ncnn_copy) == NCNN_ARCHIVE_SHA256, 'Copied ncnn archive mismatch')
    worker = out / 'worker.exe'
    linkmap = out / 'candidate-link-map.txt'
    trace = out / 'candidate-link-trace.txt'
    cxx = tool / 'bin/x86_64-w64-mingw32-clang++.exe'
    env = dict(os.environ, SOURCE_DATE_EPOCH='1794700800')
    args = [str(cxx), '-O2', '-std=c++17', '-static',
            f'-ffile-prefix-map={root}=/dvr-native', f'-ffile-prefix-map={repo}=/dvr-src',
            '-Wl,--no-insert-timestamp', f'-Wl,-Map,{linkmap}', '-v', '-Wl,--verbose', '-H',
            '-I' + str(root / 'ncnn/src'), '-I' + str(root / 'ncnn-build-windows-llvm/src'),
            str(cpp), str(ncnn_copy), '-o', str(worker)]
    result = subprocess.run(args, env=env, capture_output=True, timeout=180)
    trace.write_bytes(result.stdout + result.stderr)
    require(result.returncode == 0, 'Private worker link failed; see trace')
    spec = importlib.util.spec_from_file_location('inventory', repo / 'quality/native-ocr-candidate-link-inventory.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    inv = module.inventory(out, trace, worker, linkmap)
    expected_members = {r['archive']: set(r['selectedStaticMembers']) for r in local['archives']}
    actual_members = {r['archive']: set(r['selectedStaticMembers']) for r in inv['archives']}
    require(actual_members == expected_members and inv['staticMemberCount'] == 640,
            'Selected linked-object set changed')
    dump = subprocess.check_output([str(tool / 'bin/llvm-objdump.exe'), '-p', str(worker)],
                                   text=True, timeout=30)
    imports = re.findall(r'DLL Name:\s*(\S+)', dump)
    require(imports and all(re.fullmatch(r'KERNEL32\.dll|api-ms-win-crt-[a-z0-9-]+\.dll', x)
                            for x in imports), 'Unexpected non-system DLL dependency')
    for x in prior['linkedArchives']:
        require(sha(stock / librel / x['archive']) == x['sha256'], 'Input stock archive changed')
    for x in prior['startupObjects']:
        require(sha(stock / librel / x['name']) == x['sha256'], 'Input startup object changed')
    report = {'originalWorkerSha256': OLD_WORKER_SHA256, 'workerSha256': sha(worker),
              'expectedPrivateWorkerSha256': NEW_WORKER_SHA256,
              'exactWorkerMatch': sha(worker) == NEW_WORKER_SHA256,
              'replacementArchiveSha256': REPLACEMENT_SHA256, 'replacementMembers': manifest,
              'ncnnSha256': NCNN_ARCHIVE_SHA256, 'selectedStaticMembers': inv['staticMemberCount'],
              'imports': imports, 'stockUnchanged': True, 'distributionReady': False}
    (out / 'new-link-inventory.json').write_text(json.dumps(inv, indent=2) + '\n', encoding='utf8')
    (out / 'replacement-evidence.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    require(report['exactWorkerMatch'], 'Worker bytes differ; require fresh review and acceptance, do not admit')
    print('PRIVATE_CRT_RELINK_EXACT_MATCH', report['workerSha256'], 'distributionReady=false')


if __name__ == '__main__':
    run()
