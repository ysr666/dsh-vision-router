"""Read-only source-member and Cephes-symbol evidence for the exact final PE.

Do not substitute name-based translation-unit mapping for full compiler-header
or binary section provenance. The report never grants distribution approval.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess

WORKER = 'd1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166'
LINK_SET = '34f7018f1ad11402c2fb1c0cb5500a060c9f0468b1bfa8e672233039c0fb6d10'
LLVM = {'libc++.a', 'libunwind.a', 'libclang_rt.builtins-x86_64.a'}
MINGW = {'libmingw32.a', 'libmingwex.a', 'libmsvcrt.a', 'libmoldname.a'}
SYMBOL = re.compile(r'(?<![A-Za-z0-9_])(?:__imp_)?_?cbrt(?:f|l)?(?![A-Za-z0-9_])')


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def member_coverage(inv, llvm_ledger, mingw_ledger):
    rows = {(a['archive'], m) for a in inv['archives'] for m in a['selectedStaticMembers']}
    need(len(rows) == inv['staticMemberCount'] == 640 and inv['archiveCount'] == 8, 'FINAL_STATIC_COUNT')
    llvm = {x for x in rows if x[0] in LLVM}
    mingw = {x for x in rows if x[0] in MINGW}
    startup = {('startup', x['name']) for x in inv['startupObjects']}
    ncnn = {x for x in rows if x[0] == 'libncnn.a'}
    need(len(ncnn) == 534 and len(llvm) == 39 and len(mingw) == 67 and len(startup) == 3, 'FINAL_FAMILY_COUNTS')
    need(rows == ncnn | llvm | mingw, 'UNCLASSIFIED_STATIC_MEMBER')
    need(llvm_ledger['sourceRevision'] == '7a941dfb2877a0b8cf30323fefa85ad019e0b0f5', 'LLVM_REVISION')
    need(mingw_ledger['sourceRevision'] == '0d6dfbc348dfad714761c0a7151615767f96bcb5', 'MINGW_REVISION')
    need(len(llvm_ledger['sourceFiles']) == 39 and len(mingw_ledger['sourceFiles']) == 70, 'SOURCE_LEDGER_COUNT')
    need(llvm == {(x['archive'], x['member']) for x in llvm_ledger['sourceFiles']}, 'LLVM_SOURCE_MEMBER_MISMATCH')
    need(mingw | startup == {(x['archive'], x['member']) for x in mingw_ledger['sourceFiles']}, 'MINGW_SOURCE_MEMBER_MISMATCH')
    return {'ncnnSelectedPinnedBuildMembers': len(ncnn), 'llvmSelectedSourceMappings': len(llvm),
            'mingwSelectedSourceMappings': len(mingw), 'mingwStartupSourceMappings': len(startup),
            'allSelectedStaticFamiliesAccountedFor': True,
            'fullPreprocessorClosureVerified': False}


def parse_imports(text):
    rows = {}
    current = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == 'Import {':
            current = None
        elif stripped.startswith('Name: '):
            name = stripped[6:].strip()
            need(re.fullmatch(r'(?:KERNEL32|api-ms-win-crt-[a-z0-9-]+)\.dll', name, re.I), 'UNREVIEWED_IMPORT_DLL')
            current = name.lower()
            need(current not in rows, 'DUPLICATE_IMPORT_DLL')
            rows[current] = []
        elif stripped.startswith('Symbol: '):
            need(current is not None, 'IMPORT_SYMBOL_WITHOUT_DLL')
            name = stripped[8:].split(' ', 1)[0]
            need(bool(re.fullmatch(r'[A-Za-z0-9_@$?.]+', name)), 'UNEXPECTED_IMPORT_SYMBOL')
            rows[current].append(name)
        elif stripped == '}':
            current = None
    need(bool(rows) and all(rows.values()), 'EMPTY_IMPORT_TABLE')
    return rows


def cephes_symbols(imports, map_text):
    # Only symbols, never private absolute paths or full raw map lines.
    need(bool(map_text.strip()), 'EMPTY_LINK_MAP')
    tokens = [m.group() for line in map_text.splitlines() for m in SYMBOL.finditer(line)]
    return {'importSymbols': [{'dll': dll, 'symbol': name} for dll, names in imports.items()
                             for name in names if SYMBOL.fullmatch(name)],
            'linkMapSymbolTokens': sorted(set(tokens)), 'linkMapMatchCount': len(tokens),
            'conclusion': 'Observed import and linker-map names only; retained or inlined implementation provenance requires review.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'root', 'report'):
        p.add_argument('--' + name, type=Path, required=True)
    a = p.parse_args()
    repo, root = a.repo.resolve(), a.root.resolve()
    invmod = load('inventory', repo/'quality/native-ocr-candidate-link-inventory.py')
    cross = load('cross', repo/'quality/native-ocr-crt-cross-relink-LAB.py')
    recon = load('recon', repo/'quality/native-ocr-crt-reconstruct-LAB.py')
    replay = json.loads((root/'native-replay-evidence.json').read_bytes())
    worker = root/'worker.exe'
    mapping = root/'candidate-link-map.txt'
    inv = invmod.inventory(root, root/'candidate-link-trace.txt', worker, mapping)
    need(inv['worker']['sha256'] == WORKER == replay['workerSha256'] and replay['exactWorkerMatch'] is True
         and replay['matchedObjects'] == 68 and cross.link_set(inv) == LINK_SET == replay['linkSetSha256'], 'FINAL_WORKER_REPLAY_IDENTITY')
    llvm_ledger = json.loads((repo/'quality/native-ocr-llvm-source-byte-evidence.json').read_bytes())
    coverage = member_coverage(inv, llvm_ledger, recon.read_ledger(repo))
    tool = root/'toolchain'/invmod.TOOLCHAIN/'bin/llvm-readobj.exe'
    dump = subprocess.check_output([str(tool), '--coff-imports', str(worker)], text=True, timeout=30)
    imports = parse_imports(dump)
    need(set(imports) == {dll.lower() for dll in replay['imports']}, 'PE_IMPORT_DLL_SET_MISMATCH')
    symbols = cephes_symbols(imports, mapping.read_text(encoding='utf-8-sig', errors='strict'))
    result = {'schemaVersion': 1, 'workerSha256': WORKER, 'linkSetSha256': LINK_SET,
              'scope': 'Final PE identity, selected archive membership, source ledger match and actual named OS imports; not license clearance.',
              'coverage': coverage, 'finalInventory': inv, 'osImportSymbols': imports,
              'cephesDeclarationEvidence': symbols,
              'distributionReviewComplete': False, 'distributionReady': False, 'ownerPublicationAuthorized': False}
    with a.report.open('x', encoding='utf-8') as f:
        f.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'workerSha256': WORKER, 'coverage': coverage, 'cephesDeclarationEvidence': symbols,
                      'distributionReady': False}))


if __name__ == '__main__':
    main()
