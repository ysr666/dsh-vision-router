import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverPhotoQuestionHeadings } from '../src/lib/native-ocr-question-labels.js'

function region(text,y) {
  return { text, box:[90,y,700,y+19],confidence:0.95,uncertain:false }
}
function label(text,y,confidence=0.97) {
  return {text,box:[90,y,340,y+19],confidence}
}

test('recovers supported 3, 8, 9, 10; rejects a formula stoichiometric coefficient',()=>{
  const rows=[
    region('2. 151g 苯甲酸',340),
    region('3高能燃料联氨的燃烧反应',401),
    region('4. 讨论下列各组物质',445),
    region('6. 辛烷是汽油的主要成分',649),
    region('2C8H18(l)+25O2(g)=16CO2(g)',671),
    region('7. 利用表4-1中甲醇',719),
    region('煤的气化技术是由下列热化学反应组成',762),
    region('试比较C2H2(g)、N2H4(g)和H2(g)',926),
    region('根据附录Ⅱ中标准熵的数据计算',948),
    region('已知25℃时PCl3=-287.0kJ',1062),
  ]
  const probes=[
    label('2C8H18(l)+25O2(g)',671),
    label('8. 煤的气化技术是由下列热化学反应组成',762),
    label('9. 试比较C2H2(g)、N2H4(g)和H2(g)',926),
    label('10根据附录Ⅱ中标准熵的数据计算',948),
    label('1.已知25℃时PCl3=-287.0kJ',1062),
  ]
  const out=recoverPhotoQuestionHeadings(rows,probes)
  assert.deepEqual(out.recovered,[3,8,9,10])
  assert.equal(rows[1].text,'3. 高能燃料联氨的燃烧反应')
  assert.equal(rows[4].text,'2C8H18(l)+25O2(g)=16CO2(g)')
  assert.equal(rows[6].text,'8. 煤的气化技术是由下列热化学反应组成')
  assert.equal(rows[7].text,'9. 试比较C2H2(g)、N2H4(g)和H2(g)')
  assert.equal(rows[8].text,'10. 根据附录Ⅱ中标准熵的数据计算')
  assert.equal(rows[9].text,'已知25℃时PCl3=-287.0kJ')
  assert.ok(rows[8].uncertain,'missing separator is still uncertain')
  assert.ok(out.rejected.some(x=>x.number===1))
})

test('low-confidence candidates and multiple nearby matches must not overwrite text',()=>{
  const rows=[region('1. 甲',100),region('原始段落保持不变',300),region('原始段落保持不变',301)]
  const candidates=[label('2. 原始段落保持不变',300,0.99),label('3. 原始段落保持不变',301,0.6)]
  const res=recoverPhotoQuestionHeadings(rows,candidates)
  assert.deepEqual(res.recovered,[])
  assert.equal(rows[1].text,'原始段落保持不变')
})

test('repeated question numbers, reversed order and unsupported 12->13 cannot be injected',()=>{
  const rows=[region('8. 正确题目',700),region('下一条中文内容',800),region('9. 之后题目',900)]
  const labels=[label('2. 下一条中文内容',800),label('13. 下一条中文内容',800)]
  const res=recoverPhotoQuestionHeadings(rows,labels)
  assert.equal(rows[1].text,'下一条中文内容')
  assert.deepEqual(res.recovered,[])
})

test('does not invent question marks from a standalone low-data cue',()=>{
  const rows=[region('2. 已确认的题目',100),region('文字看不清楚',150)]
  const res=recoverPhotoQuestionHeadings(rows,[label('3.',150)])
  assert.deepEqual(res.recovered,[])
  assert.equal(rows[1].text,'文字看不清楚')
})

test('recovers red-occluded two-digit heading with a single Chinese glyph disagreement, but marks uncertain',()=>{
  const rows=[
    region('9. 试比较燃料的放热量',926),
    region('10. 根据标准熵数据计算',948),
    region('已知25℃时∆fH(PCl3,g)=-287.0kJ',1062),
    region('12. 查附录Ⅱ计算标准吉布斯函数',1144),
  ]
  const out=recoverPhotoQuestionHeadings(rows,[
    label('11.己知25C时ΔfH(PCl3,g)',1062,0.93),
  ])
  assert.deepEqual(out.recovered,[11])
  assert.match(rows[2].text,/^11\. 已知25℃/)
  assert.equal(rows[2].uncertain,true)
  assert.equal(rows[2].numberRecoveryDisagreement,true)
})

test('correlates a cropped chemistry formula when exactly one numeral was lost',()=>{
  const rows=[
    region('8. 煤的气化技术',762),
    region('9. 试比较CH2(g)、N2H4(g)和H2(g)中哪一个放热量最高',926),
    region('10. 计算标准熵',948),
  ]
  const result=recoverPhotoQuestionHeadings(rows,[
    label('9. 试比较C2H2(g)、N2H4(g)',926,0.97),
  ])
  assert.deepEqual(result.formulaReconciled,[9])
  assert.match(rows[1].text,/C2H2\(g\)/)
  assert.equal(rows[1].uncertain,true)
  assert.deepEqual(rows[1].formulaRecoveryEvidence,{from:'CH2',to:'C2H2',sourceConfidence:0.97})
})

test('never substitutes a different molecular count, invents a decimal, or trusts low-confidence crop',()=>{
  const rows=[
    region('1. 正常题目',100),
    region('2. 151g 苯甲酸(C6H3COOH)与足量氧气发生反应',200),
    region('3. 下一题目',300),
  ]
  const result=recoverPhotoQuestionHeadings(rows,[
    label('2. 1.51g 苯甲酸(C6H5COOH)与足量氧气发生反应',200,0.99),
  ])
  assert.deepEqual(result.formulaReconciled,[])
  assert.equal(rows[1].text,'2. 151g 苯甲酸(C6H3COOH)与足量氧气发生反应')
  const other=[region('8. 反应条件',700),region('9. 试比较CH2(g)和其他物质',800)]
  const bad=recoverPhotoQuestionHeadings(other,[label('9. 试比较C2H2(g)和其他物质',800,0.7)])
  assert.deepEqual(bad.formulaReconciled,[])
  assert.match(other[1].text,/CH2\(g\)/)
})

test('handles JPEG-decoder-induced space between question numeral and Chinese heading',()=>{
  const rows=[
    region('2. 苯甲酸燃烧计算',350),
    region('3 高能燃料联氨的燃烧反应',405),
    region('4. 讨论下列物质的焓变',450),
    region('2 C8H18(l)+25O2(g)=16CO2(g)',680),
  ]
  const r=recoverPhotoQuestionHeadings(rows,[])
  assert.deepEqual(r.recovered,[3])
  assert.equal(rows[1].text,'3. 高能燃料联氨的燃烧反应')
  assert.equal(rows[3].text,'2 C8H18(l)+25O2(g)=16CO2(g)')
})
