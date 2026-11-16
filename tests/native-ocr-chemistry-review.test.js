import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewChemicalStateGlyphs } from '../src/lib/native-ocr-chemistry-review.js'

const item=(text)=>({text,uncertain:false})

test('corrects OCR liquid l/1 ambiguity only when same molecule is independently visible',()=>{
  const rows=[
    item('N2H4(g)+O2(g) → 2H2O(1)+N2(g)'),
    item('(1) 2C2H2(g)+5O2(g) → 4CO2(g)+2H2O(l)'),
  ]
  const result=reviewChemicalStateGlyphs(rows)
  assert.deepEqual(result.updates,[{
    index:0,before:'H2O(1)',after:'H2O(l)',
    reason:'same_species_independently_recognized_with_liquid_state',
  }])
  assert.equal(rows[0].text,'N2H4(g)+O2(g) → 2H2O(l)+N2(g)')
  assert.equal(rows[0].uncertain,true)
  assert.equal(rows[1].text,'(1) 2C2H2(g)+5O2(g) → 4CO2(g)+2H2O(l)')
})

test('without corroboration never turns footnote (1) or isolated identifier into a phase',()=>{
  const rows=[item('水H2O(1)的方程'),item('H2O(1)')];
  const out=reviewChemicalStateGlyphs(rows)
  assert.deepEqual(out.updates,[])
  assert.deepEqual(rows.map(x=>x.text),['水H2O(1)的方程','H2O(1)'])
})

test('does not change valid gaseous state or alter chemical coefficient',()=>{
  const rows=[
    item('2H2O(g)+O2(g)=2H2O(1)'),
    item('H2O(g) is vapor'),
  ]
  const out=reviewChemicalStateGlyphs(rows)
  assert.deepEqual(out.updates,[])
  assert.equal(rows[0].text,'2H2O(g)+O2(g)=2H2O(1)')
})
