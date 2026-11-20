"""Windows-native replay of the already audited Mac source recipe.
Only JSON instructions/generated public-source header travel between runners.
Verify all 68 stripped COFF identities against the frozen reconstruction
manifest, final exact PE, selected link membership, and OS imports. No upload.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import zipfile

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def need(cond, reason):
    if not cond:
        raise RuntimeError(reason)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def run(args, cwd, env, log):
    with log.open('wb') as f:
        result = subprocess.run([str(a) for a in args], cwd=cwd, env=env,
                                stdout=f, stderr=subprocess.STDOUT, timeout=180)
    if result.returncode:
        print(log.read_text(errors='replace')[-2400:], flush=True)
        raise RuntimeError('NATIVE_COMPILE_OR_LINK_FAILED: ' + log.name)

def safe(relative):
    need(isinstance(relative,str) and re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',relative)
         and all(p not in ('.','..') for p in relative.split('/')), 'INVALID_RELATIVE_PATH')
    return relative

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for k in ('repo','root','source','recipe','out'):
        parser.add_argument('--'+k, type=Path, required=True)
    a = parser.parse_args()
    repo, root, source_tar, recipe_path, out = (getattr(a,k).resolve() for k in ('repo','root','source','recipe','out'))
    need(os.name=='nt' and not out.exists() and not out.is_relative_to(root)
         and not out.is_relative_to(repo), 'WINDOWS_FRESH_OUTPUT_REQUIRED')
    recon = load('recon',repo/'quality/native-ocr-crt-reconstruct-LAB.py')
    cross = load('cross',repo/'quality/native-ocr-crt-cross-relink-LAB.py')
    invmod = load('inventory',repo/'quality/native-ocr-candidate-link-inventory.py')
    need(recon.file_sha(source_tar)==recon.SOURCE_SHA, 'MINGW_SOURCE_SHA_MISMATCH')
    stock_zip=root/(cross.WIN_TOOL+'.zip')
    need(recon.file_sha(stock_zip)==cross.WINDOWS_ZIP_SHA,'TOOLCHAIN_SHA_MISMATCH')
    need(recon.file_sha(root/'worker-llvm-header-static.exe')==cross.OLD_SHA,'BASELINE_WORKER_SHA_MISMATCH')
    need(recipe_path.stat().st_size<=512*1024, 'RECIPE_SIZE_LIMIT')
    recipe=json.loads(recipe_path.read_text(encoding='utf8'))
    need(recipe['distributionReady'] is False and recipe['sourceRevision']==recon.MINGW_REV
         and recipe['replacementArchiveSha256']==cross.RECONSTRUCTION_ZIP_SHA, 'RECIPE_IDENTITY')
    ledger=recon.read_ledger(repo)
    expected={(x['archive'],x['member']):x for x in ledger['sourceFiles']
              if (x['archive'],x['member']) not in {('startup','crtbegin.o'),('startup','crtend.o')}}
    rows=recipe['recipes']
    need(len(rows)==68 and {(x['archive'],x['member']) for x in rows}==set(expected),'RECIPE_MEMBER_SET')
    manifest=[{k:x[k] for k in ('archive','member','sha256','bytes')} for x in rows]
    need(sha((json.dumps(manifest,indent=2)+'\n').encode())==cross.RECONSTRUCTION_MANIFEST_SHA,
         'FROZEN_OBJECT_MANIFEST_MISMATCH')
    out.mkdir()
    evidence={'schemaVersion':1,'distributionReady':False,'matchedObjects':0,
              'expectedWorkerSha256':cross.NEW_SHA,'portableRecipeSha256':recon.file_sha(recipe_path)}
    report=out/'native-replay-evidence.json'
    def save():
        report.write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf8')
    save()
    try:
        with tarfile.open(source_tar) as tf:
            tf.extractall(out,filter='data')
        source=out/('mingw-w64-'+recon.MINGW_REV)
        tool=out/'toolchain'/cross.WIN_TOOL
        tool.parent.mkdir()
        shutil.copytree(root/'toolchain'/cross.WIN_TOOL,tool)
        bin=tool/'bin'
        build=out/'build'
        build.mkdir()
        headers=recipe['generatedHeaders']
        need(len(headers)==1,'GENERATED_HEADER_COUNT')
        for relative,fact in headers.items():
            relative=safe(relative)
            data=fact['text'].encode('utf8')
            need(relative.endswith('.h') and len(data)<=65536 and sha(data)==fact['sha256'],'GENERATED_HEADER_IDENTITY')
            path=build/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        # Stock archive/startup inputs must match the exact reviewed Windows
        # ZIP, even though the independent baseline build already used them.
        for relative,(size,digest) in cross.STOCK.items():
            path=tool/relative
            need(path.stat().st_size==size and recon.file_sha(path)==digest,'STOCK_ARCHIVE_IDENTITY: '+relative)
        llvm=tool/'lib/clang/23/include/stdarg.h'
        need(recon.file_sha(llvm)==recon.LLVM_HEADER_SHA,'LLVM_VARARGS_IDENTITY')
        forwarder=out/'dvr-llvm-stdarg-forwarder.h'
        forwarder.write_text('/* DVR private audit: use Clang standard varargs implementation. */\n#include "'+llvm.as_posix()+'"\n#include <_mingw_stdarg.h>\n',encoding='utf8')
        aliases=set()
        for candidate in (tool/'include/stdarg.h',tool/'x86_64-w64-mingw32/include/stdarg.h',tool/'generic-w64-mingw32/include/stdarg.h'):
            if candidate.is_file():
                need(recon.file_sha(candidate) in (recon.LEGACY_HEADER_SHA,recon.LLVM_HEADER_SHA),'UNEXPECTED_VARARGS_ALIAS')
                aliases.update([candidate.as_posix(),candidate.resolve().as_posix()])
        need(aliases,'MISSING_VARARGS_ALIASES')
        overlay=out/'overlay.json'
        overlay.write_text(json.dumps({'version':0,'case-sensitive':False,'use-external-names':True,
            'roots':[{'type':'file','name':name,'external-contents':forwarder.as_posix()} for name in sorted(aliases)]}),encoding='utf8')
        env=dict(os.environ,SOURCE_DATE_EPOCH='1794700800',LC_ALL='C',PATH=str(bin)+os.pathsep+os.environ['PATH'])
        objects=out/'objects';objects.mkdir()
        replacements=[]
        for row in rows:
            item=expected[row['archive'],row['member']]
            src=source/safe(row['source'])
            need(row['source']==item['source'] and recon.file_sha(src)==item['sha256'],'CRT_SOURCE_IDENTITY')
            target=safe(row['target'])
            dest=objects/safe(row['archive'])/safe(row['member'])
            dest.parent.mkdir(exist_ok=True,parents=True)
            raw=dest.with_suffix('.unstripped.o')
            dep=dest.with_suffix('.d')
            # No shell, response files, plugin loads or externally provided
            # executable. Recipe produced by this run's reviewed configure.
            bindings={'@SOURCE@':source,'@TOOL@':tool,'@BUILD@':build,
                      '@OVERLAY@':overlay,'@OUTPUT@':raw,'@DEPFILE@':dep}
            args=[]
            need(isinstance(row['args'],list) and len(row['args'])<=100,'RECIPE_ARG_COUNT')
            for original in row['args']:
                need(isinstance(original,str) and len(original)<4096 and not any(c in original for c in ('\n','\r','\x00'))
                     and not original.startswith(('-Xclang','-fplugin','-load','--config','-wrapper','-specs','-B'))
                     and (not original.startswith('@') or any(original == token or original.startswith(token+'/') for token in bindings)),
                     'UNEXPECTED_RECIPE_ARG')
                arg=original
                for token,path in bindings.items():
                    arg=arg.replace(token,path.as_posix())
                need('@' not in arg,'UNRESOLVED_RECIPE_TOKEN')
                args.append(arg)
            need('-c' in args and '-mno-incremental-linker-compatible' in args and '-ivfsoverlay' in args
                 and args[args.index('-o')+1]==raw.as_posix() and args[args.index('-ivfsoverlay')+1]==overlay.as_posix(),
                 'RECIPE_OUTPUT_OR_OVERLAY')
            run([bin/'x86_64-w64-mingw32-clang.exe',*args],build,env,dest.with_suffix('.log'))
            need(recon.normalized_coff(raw.read_bytes())==row['normalizedSha256'],'CRT_NORMALIZED_MISMATCH: '+row['member'])
            subprocess.run([str(bin/'llvm-objcopy.exe'),'--strip-debug',str(raw),str(dest)],check=True,timeout=30)
            data=dest.read_bytes()
            need(len(data)==row['bytes'] and sha(data)==row['sha256']
                 and struct.unpack_from('<I',data,4)[0]==0,'CRT_STRIPPED_SHA_MISMATCH: '+row['member'])
            replacements.append((row,dest));evidence['matchedObjects']+=1
            save()
        print('WINDOWS_NATIVE_CRT_OBJECTS_EXACT',len(replacements),flush=True)
        lib=tool/'x86_64-w64-mingw32/lib'
        ar=bin/'llvm-ar.exe'
        for name in sorted({x['archive'] for x,_ in replacements}):
            members=[path for row,path in replacements if row['archive']==name]
            if name=='startup':
                need(len(members)==1 and members[0].name=='crt2.o','STARTUP_SET')
                shutil.copyfile(members[0],lib/'crt2.o')
            else:
                subprocess.run([str(ar),'r',str(lib/name),*map(str,members)],check=True,capture_output=True,timeout=90)
        for row,path in replacements:
            data=(lib/row['member']).read_bytes() if row['archive']=='startup' else subprocess.check_output(
                [str(ar),'p',str(lib/row['archive']),row['member']],timeout=30)
            need(sha(data)==row['sha256'],'ARCHIVE_READBACK_MISMATCH')
        ncnn=out/'ncnn-build-windows-llvm/src/libncnn.a'
        ncnn.parent.mkdir(parents=True)
        shutil.copyfile(root/'ncnn-build-windows-llvm/src/libncnn.a',ncnn)
        worker=out/'worker.exe';mapping=out/'candidate-link-map.txt';trace=out/'candidate-link-trace.txt'
        cpp=repo/'quality/native-ocr-lab.cpp'
        need(recon.file_sha(cpp)=='6e3d7e41bd4599b7f5625cd103935d1cc015295ac50b4abcfaa3d3913d5b091d','WRAPPER_IDENTITY')
        args=[bin/'x86_64-w64-mingw32-clang++.exe','-O2','-std=c++17','-static',
              f'-ffile-prefix-map={root}=/dvr-native',f'-ffile-prefix-map={repo}=/dvr-src',
              '-Wl,--no-insert-timestamp',f'-Wl,-Map,{mapping}','-v','-Wl,--verbose','-H',
              '-I'+str(root/'ncnn/src'),'-I'+str(root/'ncnn-build-windows-llvm/src'),cpp,ncnn,'-o',worker]
        run(args,root,env,trace)
        inv=invmod.inventory(out,trace,worker,mapping)
        imports=re.findall(r'DLL Name:\s*(\S+)',subprocess.check_output([str(bin/'llvm-objdump.exe'),'-p',str(worker)],text=True,timeout=30))
        actual=recon.file_sha(worker)
        evidence.update(workerSha256=actual,exactWorkerMatch=actual==cross.NEW_SHA,
                        staticMemberCount=inv['staticMemberCount'],linkSetSha256=cross.link_set(inv),imports=imports)
        save()
        need(actual==cross.NEW_SHA and inv['staticMemberCount']==640 and inv['archiveCount']==8
             and cross.link_set(inv)==cross.LINK_SET_SHA and imports
             and all(re.fullmatch(r'KERNEL32\.dll|api-ms-win-crt-[a-z0-9-]+\.dll',x) for x in imports),
             'FINAL_NATIVE_WORKER_IDENTITY')
        print('WINDOWS_NATIVE_FINAL_WORKER_EXACT',actual,'distributionReady=false',flush=True)
    except Exception as error:
        evidence['failure']=type(error).__name__+': '+str(error)[:300]
        save()
        raise

if __name__=='__main__':
    sys.dont_write_bytecode=True
    main()
