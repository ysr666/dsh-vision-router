import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'audit', Path(__file__).with_name('native-ocr-widl-coff-differential.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class Cases(unittest.TestCase):
    def test_selects_only_ten_exact_msxml_dependent_objects(self):
        keys = [f'libx.a/object{i}.o' for i in range(68)]
        per = {key: {'normalizedSha256': f'sha{i}', 'dependencies':
                        [audit.MSXML] if i < 10 else ['toolchain/x.h']}
               for i, key in enumerate(keys)}
        recipes = [{'archive': 'libx.a', 'member': f'object{i}.o',
                    'normalizedSha256': f'sha{i}', 'args': ['-c', 'x.c', '-o', '@OUTPUT@', '-MF', '@DEPFILE@']}
                   for i in range(68)]
        evidence = {'sourceRevision': audit.REVISION, 'exactStrippedObjectReplayMatches': 68,
                    'distributionReady': False, 'perObject': per}
        recipe = {'schemaVersion': 1, 'sourceRevision': audit.REVISION,
                  'distributionReady': False, 'recipes': recipes}
        self.assertEqual(len(audit.select_rows(evidence, recipe)), 10)
        per[keys[10]]['dependencies'] = [audit.MSXML]
        with self.assertRaisesRegex(ValueError, 'UNEXPECTED_MSXML_OBJECT_COUNT'):
            audit.select_rows(evidence, recipe)
        per[keys[10]]['dependencies'] = ['toolchain/x.h']
        recipe['distributionReady'] = True
        with self.assertRaisesRegex(ValueError, 'WRONG_COMPILE_RECIPE'):
            audit.select_rows(evidence, recipe)

    def test_expands_only_declared_source_tokens(self):
        values = {'source': Path('/source'), 'tool': Path('/tool'), 'build': Path('/build'),
                  'overlay': Path('/overlay'), 'out': Path('/out.o'), 'dep': Path('/out.d')}
        result = audit.substitute(['-I@SOURCE@/headers', '-ivfsoverlay', '@OVERLAY@',
                                   '-c', '@SOURCE@/x.c', '-o', '@OUTPUT@',
                                   '-MF', '@DEPFILE@'], values)
        self.assertEqual(result[-3:], ['-o', '/out.o', '-MF', '/out.d'][-3:])
        self.assertEqual(result[0], '-I/source/headers')
        with self.assertRaisesRegex(ValueError, 'UNRESOLVED_COMPILE_TOKEN'):
            audit.substitute(['-c', '@UNKNOWN@/x.c', '-o', '@OUTPUT@',
                              '-MF', '@DEPFILE@'], values)


if __name__ == '__main__':
    unittest.main()
