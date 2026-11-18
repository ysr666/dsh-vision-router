import importlib.util, pathlib, subprocess, tempfile, unittest, zipfile
spec=importlib.util.spec_from_file_location('builder',str(pathlib.Path(__file__).with_name('native-ocr-crt-reconstruct-LAB.py')))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Cases(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
    def test_coff_real_objects_different_code(self):
        result=[]
        for i in (3,7):
            p=self.root/f'f{i}.c';p.write_text(f'int f(int x){{return x+{i};}}')
            out=p.with_suffix('.o');subprocess.run(['clang','--target=x86_64-w64-windows-gnu','-O2','-c',str(p),'-o',str(out)],check=True)
            result.append(m.normalized_coff(out.read_bytes()))
        self.assertNotEqual(*result)
    def test_coff_raw_rebuild_with_same_recipe(self):
        p=self.root/'test.c';p.write_text('extern int g(int); int f(int x){return g(x)+3;}')
        obj=self.root/'a.o';rebuild=self.root/'b.o'
        subprocess.run(['clang','--target=x86_64-w64-windows-gnu','-O2','-gdwarf-4','-c',str(p),'-o',str(obj)],check=True)
        subprocess.run(['clang','--target=x86_64-w64-windows-gnu','-O2','-gdwarf-4','-c',str(p),'-o',str(rebuild)],check=True)
        self.assertEqual(m.normalized_coff(obj.read_bytes()),m.normalized_coff(rebuild.read_bytes()))
    def test_targets_match_all_reviewed_source_directories(self):
        repo=pathlib.Path(__file__).resolve().parent.parent
        rows=[x for x in m.read_ledger(repo)['sourceFiles'] if x['member'] not in ('crtbegin.o','crtend.o')]
        targets=[('lib64/' if x['archive']=='startup' else pathlib.Path(x['source']).parent.relative_to('mingw-w64-crt').as_posix()+'/')+x['member'] for x in rows]
        makefile='\n'.join(t+': source' for t in targets)
        self.assertEqual([x['target'] for x in m.find_targets(makefile,rows)],targets)
        with self.assertRaisesRegex(RuntimeError,'BAD_MAKE_TARGET'):m.find_targets(makefile.replace(targets[0]+':','../'+targets[0]+':'),rows)
        with self.assertRaisesRegex(RuntimeError,'AMBIGUOUS_MAKE_TARGET'):m.find_targets(makefile+'\nwrong/'+rows[0]['member']+':',rows)
    def test_recipe_requires_exact_sysroot(self):
        tool=self.root/'tool';src=self.root/'src';build=self.root/'build';overlay=self.root/'overlay.json';output=self.root/'output.o'
        row={'target':'lib64/crt2.o','source':'mingw-w64-crt/crt/crtexe.c'}
        line=f'x86_64-w64-mingw32-gcc -I{tool}/x86_64-w64-mingw32/include -MD -MF old.d -c source.c -o lib64/crt1.o'
        args,d=m.compile_recipe([line],row,src,tool,build,overlay,output)
        self.assertEqual(args[1:3],['-ivfsoverlay',str(overlay)]);self.assertNotIn('-I'+str(tool/'x86_64-w64-mingw32/include'),args);self.assertEqual(args[args.index('-o')+1],str(output));self.assertEqual(args[args.index('-MF')+1],str(d))
        with self.assertRaisesRegex(RuntimeError,'SYSROOT'):m.compile_recipe([line.replace(f'-I{tool}/x86_64-w64-mingw32/include','')],row,src,tool,build,overlay,output)
    def test_zip_deterministic(self):
        member={'lib/a.o':b'x','lib/b.o':b'y'};manifest=[{'archive':'lib','member':'a.o','sha256':m.sha(b'x'),'bytes':1}]
        a=self.root/'a.zip';b=self.root/'b.zip';m.deterministic_zip(a,member,manifest);m.deterministic_zip(b,dict(reversed(list(member.items()))),manifest)
        self.assertEqual(a.read_bytes(),b.read_bytes());self.assertEqual(zipfile.ZipFile(a).read('lib/a.o'),b'x')
    def test_depfile_canonicalizes_root_alias(self):
        real=self.root/'real';real.mkdir();alias=self.root/'alias';alias.symlink_to(real,target_is_directory=True)
        d=alias/'toolchain';d.mkdir();h=d/'ok.h';h.write_text('header');p=self.root/'x.d';p.write_text(f'x.o: {h}\n')
        self.assertEqual(set(m.dependencies(p,self.root,[(d,'toolchain')])),{'toolchain/ok.h'})
    def test_depfile_symlink_escape_rejected(self):
        d=self.root/'toolchain';d.mkdir();outside=self.root/'outside.h';outside.write_text('header')
        h=d/'escape.h';h.symlink_to(outside);p=self.root/'x.d';p.write_text(f'x.o: {h}\n')
        with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_DEPENDENCY_PATH'):m.dependencies(p,self.root,[(d,'toolchain')])
    def test_depfile_legacy_rejected(self):
        d=self.root/'toolchain';d.mkdir();h=d/'stdarg.h';h.write_text('header');p=self.root/'x.d';p.write_text(f'x.o: {h}\n')
        with self.assertRaisesRegex(RuntimeError,'LEGACY_STDARG'):m.dependencies(p,self.root,[(d,'toolchain')])
    def test_depfile_unexpected_license_rejected(self):
        d=self.root/'toolchain';d.mkdir();h=d/'test.h';h.write_text('GNU General Public License');p=self.root/'x.d';p.write_text(f'x.o: {h}\n')
        with self.assertRaisesRegex(RuntimeError,'UNREVIEWED_DEPENDENCY'):m.dependencies(p,self.root,[(d,'toolchain')])
    def test_depfile_outside_root_rejected(self):
        d=self.root/'toolchain';d.mkdir();h=self.root/'test.h';h.write_text('header');p=self.root/'x.d';p.write_text(f'x.o: {h}\n')
        with self.assertRaisesRegex(RuntimeError,'UNEXPECTED_DEPENDENCY_PATH'):m.dependencies(p,self.root,[(d,'toolchain')])
    def test_unpinned_stock_archive_rejected_before_extract(self):
        bad=self.root/'stock.zip';bad.write_bytes(b'not official')
        with self.assertRaisesRegex(RuntimeError,'WINDOWS_TOOLCHAIN_HASH_MISMATCH'):
            m.regenerate_stock(bad,{},self.root/'output',self.root/'not-an-executable')
        self.assertFalse((self.root/'output').exists())
if __name__=='__main__':unittest.main(verbosity=2)
