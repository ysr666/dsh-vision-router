"""Build the Windows x64 OCR worker on Apple Silicon from reviewed inputs.

Diagnostic only. Never execute the PE on Mac, upload binary payloads, change
canary pins or admit distribution. Compare the baseline and remediated output
against their Windows-native lab identities and the actual selected link set.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import zipfile

TOOL = 'llvm-mingw-20261020-ucrt-macos-universal'
WIN_TOOL = 'llvm-mingw-20261020-ucrt-x86_64'
WINDOWS_ZIP_SHA = 'fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd'
OLD_SHA = '4f7ad042349239baca6a654d8ca31937c2c49886f6f51413c8447071ff80bfa8'
NEW_SHA = 'd1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166'
LINK_SET_SHA = '34f7018f1ad11402c2fb1c0cb5500a060c9f0468b1bfa8e672233039c0fb6d10'
NCNN = 'd1f6ac67e9fc91390cc70f7168573fd2626f1d66'
RECONSTRUCTION_ZIP_SHA = '4352197dadef779a8a6cc5cff0126a31d9f5968c43a09f273aa9fdd58f1dcf24'
RECONSTRUCTION_MANIFEST_SHA = 'ab1b59aafd377be81eaa738a5f3fa02ecb84647d1702f0d5794b046868315c41'
DEPENDENCY_MAP_SHA = 'c70466f05ffa8969f728c00b4d27d42c30439c546abc90abdb9ca59b5f8a8c3a'
PER_OBJECT_MAP_SHA = '9a86e34c75dfbf5a81e6ad20d14aa3285f3159d3691d3d46889a1ee27dcd4a3d'
CRT_STOCK_INVENTORY_SHA = '02a0118858bad374d4abb3f104c86b6a4ec737f8b559109eb74be61c4756e941'
STOCK = {
    'x86_64-w64-mingw32/lib/libc++.a': (3715512, '7951a18341870b622e67bea17bed9cd953d827cc7fbd0b521f01944f1ac7d22c'),
    'lib/clang/23/lib/windows/libclang_rt.builtins-x86_64.a': (256660, 'fa6a7a18518ff5372a5f32a386ab0d689099d8c258c18eaea2431f514154c55b'),
    'x86_64-w64-mingw32/lib/libkernel32.a': (577358, '6ee0041fafa7ad06bd7dc8b6b387e4ca066e76ccfeca56ae84af5a2a6d42a345'),
    'x86_64-w64-mingw32/lib/libmingw32.a': (139220, 'a0aad43b481208ad1ff583102c00bd2a1e56e855b2045e282ed03845a44feef7'),
    'x86_64-w64-mingw32/lib/libmingwex.a': (1881848, 'df21bc3944a8766542f1b4c1ffc864e2b5dd997f2d14604eec12d3ba9258bfea'),
    'x86_64-w64-mingw32/lib/libmsvcrt.a': (848642, 'e4e38200c764bbfd217f3290f64b9bd3cc963dd782b34f3d747df27780360f62'),
    'x86_64-w64-mingw32/lib/libunwind.a': (91768, 'b37299ed084757834d7cee8d723aff6b349890d61505478602e9e981dcca839c'),
    'x86_64-w64-mingw32/lib/crt2.o': (26304, 'ffcfcbf19e168693bac1d2a8ab19551228291217bc5cde5193c5b7c65eacdef3'),
    'x86_64-w64-mingw32/lib/crtbegin.o': (628, '5dc28a7b0ecf42c769578f63b8d169c89c958f95c2e67b3a0d8f94b8bd3c6c60'),
    'x86_64-w64-mingw32/lib/crtend.o': (628, 'c6b583eaf68b432e35507013e3213557edd2656c33916a7878c8efda18b95c19'),
}


def require(ok, error):
    if not ok:
        raise RuntimeError(error)


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def checked_path(root, relative):
    p = root / relative
    require(p.resolve().is_relative_to(root.resolve()), 'TOOLCHAIN_PATH_ESCAPE: ' + relative)
    return p


def run_logged(args, log, env, timeout=600):
    with log.open('wb') as f:
        result = subprocess.run([str(a) for a in args], stdout=f, stderr=subprocess.STDOUT,
                                env=env, timeout=timeout)
    if result.returncode:
        print(log.read_text(errors='replace')[-2500:], flush=True)
        raise RuntimeError('BUILD_STEP_FAILED: ' + log.name)


def link_set(inv):
    obj = {r['archive']: {'static': sorted(r['selectedStaticMembers']),
                          'import': sorted(r['selectedImportMembers'])} for r in inv['archives']}
    return hash_bytes(json.dumps(obj, sort_keys=True, separators=(',', ':')).encode())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'reconstruction', 'stock-windows-zip', 'out'):
        p.add_argument('--'+name, type=Path, required=True)
    a = p.parse_args()
    repo, recon, stock_zip, lab = (a.repo.resolve(), a.reconstruction.resolve(),
                                   a.stock_windows_zip.resolve(), a.out.resolve())
    require(platform.system() == 'Darwin' and platform.machine() == 'arm64', 'APPLE_SILICON_REQUIRED')
    require(not lab.exists() and not lab.is_relative_to(repo) and not lab.is_relative_to(recon) and
            not repo.is_relative_to(lab) and not recon.is_relative_to(lab), 'FRESH_SEPARATE_OUTPUT_REQUIRED')
    require(re.fullmatch(r'/[A-Za-z0-9_./-]+', str(lab)), 'SIMPLE_OUTPUT_PATH_REQUIRED')
    require(digest(stock_zip) == WINDOWS_ZIP_SHA, 'STOCK_WINDOWS_ZIP_MISMATCH')
    report = json.loads((recon/'crt-reconstruction-evidence.json').read_text())
    require(report['distributionReady'] is False and report['stockInventorySha256'] == CRT_STOCK_INVENTORY_SHA
            and report['normalizedMatches'] == report['exactStrippedObjectReplayMatches'] == 68
            and report['exactArchiveReplayMatch'] is True and report['zeroCoffTimestamps'] is True
            and len(report['dependencies']) == 419, 'UNVERIFIED_SOURCE_RECONSTRUCTION')
    replacement = recon/'crt-reconstructed.zip'
    require(digest(replacement) == report['replacementArchiveSha256'] == RECONSTRUCTION_ZIP_SHA,
            'INDEPENDENT_RUNNER_RECONSTRUCTION_ZIP_MISMATCH')
    for key, expected in [('dependencies', DEPENDENCY_MAP_SHA), ('perObject', PER_OBJECT_MAP_SHA)]:
        require(hash_bytes(json.dumps(report[key], sort_keys=True, separators=(',', ':')).encode()) == expected,
                'RECONSTRUCTION_MAP_MISMATCH: ' + key)
    with zipfile.ZipFile(replacement) as zip_in:
        require(zip_in.namelist().count('manifest.json') == 1 and
                hash_bytes(zip_in.read('manifest.json')) == RECONSTRUCTION_MANIFEST_SHA,
                'INDEPENDENT_RUNNER_RECONSTRUCTION_MANIFEST_MISMATCH')
    print('INDEPENDENT_RUNNER_CRT_REPLAY_MATCH', RECONSTRUCTION_ZIP_SHA, flush=True)
    cpp = repo/'quality/native-ocr-lab.cpp'
    require(digest(cpp) == '6e3d7e41bd4599b7f5625cd103935d1cc015295ac50b4abcfaa3d3913d5b091d',
            'WRAPPER_SOURCE_MISMATCH')
    lab.mkdir(mode=0o700, parents=True)
    tool = lab/'toolchain'/TOOL
    tool.parent.mkdir()
    shutil.copytree(recon/TOOL, tool, symlinks=True)
    # Force the ten actually reviewed Windows archive/startup inputs, rather
    # than assuming host-specific toolchain tarballs contain identical libs.
    with zipfile.ZipFile(stock_zip) as z:
        names = z.namelist()
        for relative, (size, expected) in STOCK.items():
            key = WIN_TOOL + '/' + relative
            require(names.count(key) == 1, 'AMBIGUOUS_STOCK_ENTRY: ' + key)
            data = z.read(key)
            require(len(data) == size and hash_bytes(data) == expected, 'STOCK_ENTRY_MISMATCH: ' + key)
            dest = checked_path(tool, relative)
            require(dest.is_file(), 'MAC_CROSS_SYSROOT_LAYOUT_MISMATCH: ' + relative)
            dest.write_bytes(data)
    header = checked_path(tool, 'generic-w64-mingw32/include/stdarg.h')
    llvm = checked_path(tool, 'lib/clang/23/include/stdarg.h')
    require(digest(header) == '09f6041cdc0f2f3325828a0e1bfb05e2fb4fb0a73cf715a3b6cb5315612c8c56' and
            digest(llvm) == 'ce6e43d79dc89b50208ecf259b1ffd519f5a78cd3a2c7fcaac6386f376b89fef',
            'STDARG_INPUT_MISMATCH')
    shutil.copyfile(llvm, header)
    source = lab/'ncnn'
    subprocess.run(['git','init',str(source)], check=True, timeout=30)
    subprocess.run(['git','-C',str(source),'fetch','--depth','1',
                    'https://github.com/Tencent/ncnn.git',NCNN], check=True, timeout=240)
    subprocess.run(['git','-C',str(source),'checkout','--detach','FETCH_HEAD'], check=True, timeout=60)
    subprocess.run(['git','-C',str(source),'submodule','update','--init','--recursive'], check=True, timeout=300)
    require(subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip() == NCNN,
            'NCNN_REVISION_MISMATCH')
    bin = tool/'bin'
    cc = bin/'x86_64-w64-mingw32-clang'
    cxx = bin/'x86_64-w64-mingw32-clang++'
    build = lab/'ncnn-build-windows-llvm'
    env = dict(os.environ, PATH=str(bin)+':'+os.environ['PATH'], SOURCE_DATE_EPOCH='1794700800', LC_ALL='C')
    for k in ('SDKROOT','MACOSX_DEPLOYMENT_TARGET','CC','CXX','CFLAGS','CPPFLAGS','CXXFLAGS','LDFLAGS'):
        env.pop(k, None)
    flags = f'-ffile-prefix-map={lab}=/dvr-native -ffile-prefix-map={repo}=/dvr-src'
    cmake = ['cmake','-S',source,'-B',build,'-G','Ninja','-DCMAKE_SYSTEM_NAME=Windows',
             '-DCMAKE_SYSTEM_PROCESSOR=x86_64','-DCMAKE_BUILD_TYPE=Release',
             f'-DCMAKE_C_COMPILER={cc}',f'-DCMAKE_CXX_COMPILER={cxx}',
             f'-DCMAKE_C_FLAGS={flags}',f'-DCMAKE_CXX_FLAGS={flags}',
             '-DNCNN_OPENMP=OFF','-DNCNN_VULKAN=OFF','-DNCNN_SHARED_LIB=OFF','-DNCNN_PIXEL=ON',
             '-DNCNN_BUILD_TOOLS=OFF','-DNCNN_BUILD_EXAMPLES=OFF','-DNCNN_BUILD_TESTS=OFF',
             '-DNCNN_BUILD_BENCHMARK=OFF']
    run_logged(cmake, lab/'cmake.log', env, 240)
    run_logged(['cmake','--build',build,'--target','ncnn','-j','6'], lab/'ncnn-build.log', env, 900)
    ncnn = build/'src/libncnn.a'
    spec = importlib.util.spec_from_file_location('inventory',repo/'quality/native-ocr-candidate-link-inventory.py')
    invmod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(invmod)
    invmod.TOOLCHAIN = TOOL
    worker = lab/'worker-llvm-header-static.exe'
    mapping = lab/'candidate-link-map.txt'
    trace = lab/'candidate-link-trace.txt'

    def link():
        args = [cxx,'-O2','-std=c++17','-static',f'-ffile-prefix-map={lab}=/dvr-native',
                f'-ffile-prefix-map={repo}=/dvr-src','-Wl,--no-insert-timestamp',
                f'-Wl,-Map,{mapping}','-v','-Wl,--verbose','-H',
                '-I'+str(source/'src'),'-I'+str(build/'src'),cpp,ncnn,'-o',worker]
        run_logged(args, trace, env, 180)
        inv = invmod.inventory(lab,trace,worker,mapping)
        require(inv['staticMemberCount'] == 640 and inv['archiveCount'] == 8, 'LINK_MEMBER_COUNT_MISMATCH')
        require(link_set(inv) == LINK_SET_SHA, 'LINK_MEMBER_IDENTITY_MISMATCH')
        imports = re.findall(r'DLL Name:\s*(\S+)',subprocess.check_output(
            [str(bin/'llvm-objdump'),'-p',str(worker)],text=True,timeout=30))
        require(imports and all(re.fullmatch(r'KERNEL32\.dll|api-ms-win-crt-[a-z0-9-]+\.dll',x) for x in imports),
                'UNEXPECTED_DLL_IMPORT')
        return inv['worker']['sha256'], imports

    old, old_imports = link()
    print('CROSS_STOCK_WORKER_SHA256',old,'matches Windows lab:',old==OLD_SHA,flush=True)
    # If the cross baseline differs, avoid claiming that the reconstructed
    # inputs were linked into an equivalent candidate. Still record evidence.
    result = {'schemaVersion':1,'sourceReconstructionArchiveSha256':digest(replacement),
              'independentRunnerArchiveReplayMatch':True,
              'reconstructionManifestSha256':RECONSTRUCTION_MANIFEST_SHA,
              'dependencyMapSha256':DEPENDENCY_MAP_SHA,'perObjectMapSha256':PER_OBJECT_MAP_SHA,
              'ncnnArchiveSha256':digest(ncnn),'crossStockWorkerSha256':old,
              'expectedStockWorkerSha256':OLD_SHA,'baselineExactMatch':old==OLD_SHA,
              'linkSetSha256':LINK_SET_SHA,'distributionReady':False}
    (lab/'cross-relink-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
    require(old == OLD_SHA, 'CROSS_BASELINE_NOT_BYTE_IDENTICAL')
    ledger=json.loads((repo/'quality/native-ocr-mingw-source-evidence.json').read_text())
    expected={(r['archive'],r['member']) for r in ledger['sourceFiles']}-{('startup','crtbegin.o'),('startup','crtend.o')}
    objects=lab/'replacement-members';objects.mkdir()
    with zipfile.ZipFile(replacement) as z:
        manifest=json.loads(z.read('manifest.json'))
        require(manifest==report['replacementManifest'] and len(manifest)==68 and
                {(r['archive'],r['member']) for r in manifest}==expected, 'REPLACEMENT_MANIFEST_MISMATCH')
        names={r['archive']+'/'+r['member'] for r in manifest}|{'manifest.json'}
        require(set(z.namelist())==names and len(z.infolist())==len(names),'REPLACEMENT_PATH_MISMATCH')
        for row in manifest:
            name=row['archive']+'/'+row['member'];data=z.read(name)
            require(len(data)==row['bytes'] and hash_bytes(data)==row['sha256'],'REPLACEMENT_MEMBER_MISMATCH')
            out=objects/name;out.parent.mkdir(exist_ok=True,parents=True);out.write_bytes(data)
    lib=tool/'x86_64-w64-mingw32/lib'
    ar=bin/'llvm-ar'
    for name in sorted({r['archive'] for r in manifest}):
        members=[objects/name/r['member'] for r in manifest if r['archive']==name]
        if name=='startup':
            require(len(members)==1 and members[0].name=='crt2.o','STARTUP_REPLACEMENT_MISMATCH')
            shutil.copyfile(members[0],lib/'crt2.o')
        else:
            subprocess.run([str(ar),'r',str(lib/name),*map(str,members)],check=True,timeout=90,capture_output=True)
    for row in manifest:
        data=(lib/row['member']).read_bytes() if row['archive']=='startup' else subprocess.check_output(
            [str(ar),'p',str(lib/row['archive']),row['member']],timeout=30)
        require(hash_bytes(data)==row['sha256'],'REPLACED_MEMBER_READBACK_MISMATCH')
    new, imports = link()
    result.update(crossRemediatedWorkerSha256=new, expectedRemediatedWorkerSha256=NEW_SHA,
                  remediatedExactMatch=new==NEW_SHA, imports=imports,
                  importsUnchanged=imports==old_imports, replacementMembers=68)
    (lab/'cross-relink-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
    print('CROSS_REMEDIATED_WORKER_SHA256',new,'matches Windows native lab:',new==NEW_SHA,flush=True)
    require(new==NEW_SHA and imports==old_imports,'CROSS_REMEDIATED_WORKER_NOT_BYTE_IDENTICAL')


if __name__=='__main__':
    os.umask(0o077)
    main()
