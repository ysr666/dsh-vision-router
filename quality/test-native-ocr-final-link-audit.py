import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('final_link', Path(__file__).with_name('native-ocr-final-link-audit.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Cases(unittest.TestCase):
    def test_imports_and_cbrt_observations(self):
        data = '''Import {
  Name: KERNEL32.dll
  Symbol: ExitProcess (123)
}
Import {
  Name: api-ms-win-crt-math-l1-1-0.dll
  Symbol: cbrt (1)
  Symbol: pow (2)
}'''
        imports = m.parse_imports(data)
        evidence = m.cephes_symbols(imports, ' address symbol __imp_cbrt\n address cbrtf\n address notcbrt\n')
        self.assertEqual(evidence['importSymbols'], [{'dll': 'api-ms-win-crt-math-l1-1-0.dll', 'symbol': 'cbrt'}])
        self.assertEqual(evidence['linkMapSymbolTokens'], ['__imp_cbrt', 'cbrtf'])
        with self.assertRaisesRegex(ValueError, 'UNREVIEWED_IMPORT_DLL'):
            m.parse_imports(data.replace('KERNEL32.dll', 'unreviewed.dll'))
        with self.assertRaisesRegex(ValueError, 'EMPTY_IMPORT_TABLE'):
            m.parse_imports('no imports')

    def test_exact_member_sets_not_just_counts(self):
        rows = [{'archive': a, 'selectedStaticMembers': [f'obj{i}.o' for i in range(n)]} for a,n in [
            ('libncnn.a',534), ('libc++.a',35), ('libunwind.a',3), ('libclang_rt.builtins-x86_64.a',1),
            ('libmingw32.a',16), ('libmingwex.a',38), ('libmsvcrt.a',13), ('libkernel32.a',0)]]
        startup = [{'name': n} for n in ('crt2.o','crtbegin.o','crtend.o')]
        inv = {'archives': rows, 'startupObjects': startup, 'archiveCount': 8, 'staticMemberCount': 640}
        def ledger(family, revision):
            return {'sourceRevision': revision, 'sourceFiles': [{'archive': a['archive'], 'member': name}
                for a in rows if a['archive'] in family for name in a['selectedStaticMembers']]}
        llvm = ledger(m.LLVM, '7a941dfb2877a0b8cf30323fefa85ad019e0b0f5')
        mingw = ledger(m.MINGW, '0d6dfbc348dfad714761c0a7151615767f96bcb5')
        mingw['sourceFiles'] += [{'archive':'startup','member':x['name']} for x in startup]
        self.assertTrue(m.member_coverage(inv, llvm, mingw)['allSelectedStaticFamiliesAccountedFor'])
        self.assertFalse(m.member_coverage(inv, llvm, mingw)['fullPreprocessorClosureVerified'])
        llvm['sourceFiles'][0]['member'] = 'unexpected.o'
        with self.assertRaisesRegex(ValueError, 'LLVM_SOURCE_MEMBER_MISMATCH'):
            m.member_coverage(inv, llvm, mingw)


if __name__ == '__main__':
    unittest.main(verbosity=2)
