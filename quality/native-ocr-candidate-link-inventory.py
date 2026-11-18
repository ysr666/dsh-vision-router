"""Inventory actual archive members reported by LLVM-MinGW COFF verbose link.
Read-only evidence. No distribution, payload upload, or automatic license approval.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

REVISION = '0d6dfbc348dfad714761c0a7151615767f96bcb5'
LLVM_REVISION = '7a941dfb2877a0b8cf30323fefa85ad019e0b0f5'
TOOLCHAIN = 'llvm-mingw-20261020-ucrt-x86_64'
ARCHIVES = {
    'libncnn.a': ('ncnn', 'ncnn-build-windows-llvm/src/libncnn.a'),
    'libc++.a': ('LLVM libc++/libc++abi', 'x86_64-w64-mingw32/lib/libc++.a'),
    'libunwind.a': ('LLVM libunwind', 'x86_64-w64-mingw32/lib/libunwind.a'),
    'libclang_rt.builtins-x86_64.a': ('LLVM compiler-rt', 'lib/clang/23/lib/windows/libclang_rt.builtins-x86_64.a'),
    'libmingw32.a': ('MinGW-w64 CRT', 'x86_64-w64-mingw32/lib/libmingw32.a'),
    'libmingwex.a': ('MinGW-w64 extensions', 'x86_64-w64-mingw32/lib/libmingwex.a'),
    'libmoldname.a': ('MinGW-w64 compatibility', 'x86_64-w64-mingw32/lib/libmoldname.a'),
    'libmsvcrt.a': ('MinGW-w64 UCRT imports and static extra objects', 'x86_64-w64-mingw32/lib/libmsvcrt.a'),
    **{'lib'+lib+'.a': ('Windows DLL import archive', 'x86_64-w64-mingw32/lib/lib'+lib+'.a')
       for lib in ['kernel32','advapi32','shell32','user32']},
}

def digest(path):
    with path.open('rb') as stream:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(stream,'sha256').hexdigest()}

def parse_trace(text):
    groups = {}
    for name, member in re.findall(r'^ld[.]lld: (?:Reading|Loaded) ([A-Za-z0-9_+.-]+[.]a)\(([^)\r\n]+)\)', text, re.M):
        if name not in ARCHIVES:
            raise RuntimeError('UNREVIEWED_LINK_ARCHIVE: '+name)
        if '/' in member or '\\' in member:
            raise RuntimeError('UNEXPECTED_LINK_MEMBER_PATH: '+name)
        groups.setdefault(name,set()).add(member)
    for required in ['libncnn.a','libc++.a','libmingw32.a','libmingwex.a','libmsvcrt.a','libkernel32.a']:
        if required not in groups:
            raise RuntimeError('INCOMPLETE_VERBOSE_LINK_EVIDENCE: '+required)
    if len(groups['libncnn.a']) < 100:
        raise RuntimeError('INCOMPLETE_NCNN_MEMBER_EVIDENCE')
    return groups

def inventory(root, trace, worker, map_file):
    tool = root / 'toolchain' / TOOLCHAIN
    raw = trace.read_bytes()
    # PowerShell redirection may use UTF-16 or UTF-8 with BOM.
    text = raw.decode('utf-16' if raw.startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8-sig',errors='replace')
    groups = parse_trace(text)
    rows = []
    for name in sorted(groups):
        family, rel = ARCHIVES[name]
        path = (root if name == 'libncnn.a' else tool) / rel
        members = sorted(groups[name])
        imported = [m for m in members if m.lower().endswith('.dll')]
        static = [m for m in members if not m.lower().endswith('.dll')]
        if any(not re.match(r'^(kernel32[.]dll|api-ms-win-crt-[a-z0-9-]+[.]dll)$', m,re.I) for m in imported):
            raise RuntimeError('UNREVIEWED_SYSTEM_IMPORT')
        rows.append({'archive': name, 'family': family, 'relativePath': rel,
                     **digest(path),'selectedStaticMembers': static,'selectedImportMembers': imported})
    map_text = map_file.read_text(encoding='utf-8-sig',errors='replace')
    startup = []
    for name in ['crt2.o','crtbegin.o','crtend.o']:
        if name not in map_text and name not in text:
            raise RuntimeError('MISSING_CRT_STARTUP_EVIDENCE: '+name)
        rel = 'x86_64-w64-mingw32/lib/'+name
        startup.append({'name':name,'relativePath':rel,**digest(tool / rel)})
    return {'worker':digest(worker),'trace':digest(trace),'linkMap':digest(map_file),
            'toolchain': TOOLCHAIN, 'llvmSourceRevision':LLVM_REVISION, 'mingwSourceRevision':REVISION,
            'archiveCount':len(rows),'staticMemberCount':sum(len(r['selectedStaticMembers']) for r in rows),
            'archives':rows,'startupObjects':startup,'distributionReady':False,
            'scope':'Selected COFF archive members, actual archive identities and startup objects; not final retained section attribution or legal clearance.'}

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root',type=Path,required=True)
    p.add_argument('--trace',type=Path,required=True)
    p.add_argument('--worker',type=Path,required=True)
    p.add_argument('--map',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True)
    a=p.parse_args()
    r=inventory(a.root,a.trace,a.worker,a.map)
    a.report.write_text(json.dumps(r,indent=2)+'\n',encoding='utf-8')
    print('CANDIDATE_LINK_INVENTORY',r['archiveCount'],r['staticMemberCount'],'selected static members; review only')
if __name__ == '__main__':
    main()
