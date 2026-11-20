import copy
import importlib.util
import pathlib
import unittest
spec=importlib.util.spec_from_file_location('labels',pathlib.Path(__file__).with_name('native-ocr-canonical-labels.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

WINDOWS=b'7767517\n5 6\nInput  input 0 1 in0 0=2\nSplit s 1 2 in0 a b\nReLU one 1 1 b c 0=0.2\nReLU two 1 1 a d\nBinaryOp end 2 1 c d out0 0=0\n'
MAC=b'7767517\n5 6\nInput m_0 0 1 in0 0=2\nSplit m_s 1 2 in0 x y\nReLU m_1 1 1 x z 0=0.2\nReLU m_2 1 1 y w\nBinaryOp m_3 2 1 z w out0 0=0\n'
def ident(b):return {'bytes':len(b),'sha256':m.sha(b)}

class Test(unittest.TestCase):
    def setUp(self):
        self.fingerprint=m.parse(WINDOWS)['fingerprint']
        self.recipe=m.make_labels(WINDOWS,ident(WINDOWS),self.fingerprint)
    def test_roundtrip_and_split_alias_permutation(self):
        self.assertEqual(m.parse(MAC)['fingerprint'],self.fingerprint)
        self.assertEqual(m.rebuild(MAC,self.recipe,ident(MAC),ident(WINDOWS),self.fingerprint),WINDOWS)
        for entry in self.recipe['labels']:
            self.assertEqual(set(entry),{'name','outputs','splitAliases','spacing'})
    def test_reject_operator_change_even_with_matching_input_hash(self):
        bad=MAC.replace(b'0=0.2',b'0=0.3')
        with self.assertRaisesRegex(ValueError,'RECIPE_IDENTITY'):
            m.rebuild(bad,self.recipe,ident(bad),ident(WINDOWS),self.fingerprint)
    def test_reject_altered_label_or_layout_or_alias(self):
        for key,val in [('name','tampered'),('splitAliases',[999]),('spacing',['x'])]:
            bad=copy.deepcopy(self.recipe)
            bad['labels'][2][key]=val
            with self.assertRaises(ValueError):m.rebuild(MAC,bad,ident(MAC),ident(WINDOWS),self.fingerprint)
    def test_reject_wrong_native_input_or_target(self):
        with self.assertRaisesRegex(ValueError,'PARAM_IDENTITY'):
            m.rebuild(MAC+b' ',self.recipe,ident(MAC),ident(WINDOWS),self.fingerprint)
        with self.assertRaisesRegex(ValueError,'RECIPE_IDENTITY'):
            m.rebuild(MAC,self.recipe,ident(MAC),ident(MAC),self.fingerprint)
if __name__=='__main__':unittest.main(verbosity=2)
