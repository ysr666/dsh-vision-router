import argparse, hashlib,json,re,tarfile
from pathlib import Path
REV='0d6dfbc348dfad714761c0a7151615767f96bcb5'
PFX='mingw-w64-'+REV+'/'
CRT='mingw-w64-crt/'
GROUPS={
 'libmingw32.a': {'crt':'CRT_fp10 _newmode cinitexe dllargv gccmain merr mingw_helpers natstart pseudo-reloc-list pseudo-reloc tlssup usermatherr wildcard xncommod xthdloc xtxtmode'},
 'libmingwex.a': {'misc':'btowc fegetround fesetround mingw_controlfp mingw_matherr mingw_setfp mingw_wcstold wcstof wcstold wctob','gdtoa':'dmisc g__fmt gdtoa gethex gmisc hd_init hexnan misc smisc strtodg strtodnrp strtof strtopx sum','stdio':'mingw_fprintf mingw_pformat mingw_sformat mingw_snprintf mingw_sscanf mingw_swprintf mingw_vfprintf mingw_vsnprintf mingw_vsscanf mingw_vswprintf mingw_wpformat','cfguard':'mingw_cfguard_support','cfguard:S':'guard_dispatch','crt:S':'loadcfg'},
 'libmsvcrt.a':{'misc':'__initenv __p___initenv ucrt__getmainargs ucrt_amsg_exit','math':'sincosf','stdio':'ucrt___local_stdio_printf_options ucrt___local_stdio_scanf_options ucrt_fprintf ucrt_fscanf ucrt_ms_fwprintf ucrt_snprintf ucrt_sscanf ucrt_vfprintf'},
}
def sha(b):return hashlib.sha256(b).hexdigest()
def gitblob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--source',type=Path,required=True)
 parser.add_argument('--runtime-notice',type=Path,required=True)
 parser.add_argument('--report',type=Path,required=True)
 parser.add_argument('--link-inventory',type=Path,required=True)
 parser.add_argument('--notice-out',type=Path,required=True)
 args=parser.parse_args()
 link=json.loads(args.link_inventory.read_text(encoding='utf-8-sig'))
 selected={r['archive']:set(r['selectedStaticMembers']) for r in link['archives'] if r['archive'] in GROUPS}
 expected={}
 for lib, folders in GROUPS.items():
  prefix='lib64_libucrt_extra_a-' if lib=='libmsvcrt.a' else 'lib64_'+lib[:-2]+'_a-'
  expected[lib]={prefix+n+'.o' for names in folders.values() for n in names.split()}
 if selected!=expected or {r['name'] for r in link['startupObjects']}!={'crt2.o','crtbegin.o','crtend.o'}:
  raise RuntimeError('MINGW_SELECTED_MEMBERS_CHANGED: update source mapping after review')
 with tarfile.open(args.source,'r:gz') as archive:
  def read(p):
   m=archive.getmember(PFX+p)
   if not m.isfile() or m.size>2*1024*1024: raise RuntimeError('INVALID_SOURCE_MEMBER '+p)
   return archive.extractfile(m).read()
  runtime=read('COPYING.MinGW-w64-runtime/COPYING.MinGW-w64-runtime.txt')
  if runtime!=args.runtime_notice.read_bytes() or gitblob(runtime)!='776d5f1034240f6dae0ce59d592f9c6f4ad29e7d': raise RuntimeError('RUNTIME_NOTICE_IDENTITY')
  disclaimer=read('DISCLAIMER.PD')
  make=read(CRT+'Makefile.am').decode()
  data=[]
  attribution={}
  for lib,folders in list(GROUPS.items())+[('startup',{'crt':'crtexe crtbegin crtend'})]:
   for folder,names in folders.items():
    if ':' in folder: folder,extension=folder.split(':',1)
    else: extension='c'
    for name in names.split():
     path=CRT+folder+'/'+name+'.'+extension
     if path[len(CRT):] not in make: raise RuntimeError('MAKEFILE_NOT_FOUND '+path)
     raw=read(path); text=raw.decode('utf-8',errors='replace')
     # record source-specific clues, without assigning clearance automatically
     comments=re.findall(r'/\*[\s\S]*?\*/|(?m:^[ \t]*//[^\n]*)',text)
     notices=[c for c in comments if re.search(r'copyright|public domain|permission to use|redistribute|license|licence|disclaimer\.pd|all rights reserved',c,re.I)]
     for notice in notices:
      attribution.setdefault(notice,[]).append(path)
     flags=[x.strip()[:240] for x in text.splitlines() if re.search(r'\bcephes\b|\bmoshier\b|GNU (?:Lesser |Library )?General Public License|SPDX-License-Identifier:\s*(?:\(?GPL|\(?LGPL)|\bLGPL\b',x,re.I)]
     if re.search('public domain|not copyrighted',text[:3000],re.I): hint='public-domain declaration'
     elif re.search('Lucent Technologies|David M[.] Gay',text[:4000],re.I): hint='gdtoa / Lucent / David M. Gay notice'
     elif re.search('permission to use|redistribution and use|permission is hereby granted',text[:5000],re.I): hint='specific permissive grant text'
     elif re.search('copyright|license|licence',text[:2500],re.I): hint='source-specific notice: review'
     else: hint='no prominent source grant; repository COPYING applies subject to exceptions'
     object_name=('crt2.o' if name=='crtexe' else name+'.o') if lib=='startup' else ('lib64_libucrt_extra_a-' if lib=='libmsvcrt.a' else 'lib64_'+lib[:-2]+'_a-')+name+'.o'
     data.append({'archive':lib,'member':object_name,'source':path,'gitBlobSha1':gitblob(raw),'sha256':sha(raw),'bytes':len(raw),'noticeHint':hint,'noticeCount':len(notices),'riskText':flags})
  # Preserve original upstream terms and all identified notice-bearing comments.
  # This supplemental record is not a blanket grant for unexamined components.
  notice_text=['MinGW-w64 supplemental source attribution','Source revision: '+REV,'Source: https://github.com/mingw-w64/mingw-w64/tree/'+REV,'Selected translation-unit notices; complements, not replaces, MINGW-RUNTIME-COPYING.txt.','', 'Upstream COPYING:',read('COPYING').decode('utf-8'), 'Upstream DISCLAIMER.PD:',disclaimer.decode('utf-8')]
  for comment, paths in sorted(attribution.items(),key=lambda x:x[1][0]):
   notice_text += ['','Source files: '+', '.join(sorted(paths)),comment]
  args.notice_out.write_bytes(('\n'.join(notice_text)+'\n').encode('utf-8'))
  result={'worker':link['worker'],'linkedArchives':[r for r in link['archives'] if r['archive'] in GROUPS],'startupObjects':link['startupObjects'],'supplementalNoticeSha256':sha(args.notice_out.read_bytes()),'sourceRevision':REV,'sourceArchiveSha256':sha(args.source.read_bytes()),'runtimeNoticeSha256':sha(runtime),'runtimeNoticeGitBlob':gitblob(runtime),'disclaimerSha256':sha(disclaimer),'sourceFiles':data,'scope':'Exact translation-unit source paths for observed local Windows selected MinGW members and startup objects; excludes transitive includes and other compiler/runtime components; not legal clearance.','distributionReady':False}
  args.report.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
  print('MINGW_SOURCE_FILES',len(data))
  for x in data:
   print(x['source'],x['noticeHint'],'flags='+str(len(x['riskText'])))
   for flag in x['riskText']: print('  ',flag)
  print('DISCLAIMER_SHA256',result['disclaimerSha256'])
if __name__=='__main__':main()
