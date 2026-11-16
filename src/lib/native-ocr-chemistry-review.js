/**
 * Minimal evidence-backed chemistry glyph reconciliation for photographed
 * textbook pages. Never fabricates a number or changes element stoichiometry.
 */
const normalizeSpecies = text => text.normalize('NFKC').replace(/\s+/g,'')
const speciesPattern = /([A-Z][A-Za-z0-9]{1,18})\(1\)/g

export function reviewChemicalStateGlyphs(regions) {
  const updates=[]
  const normalized=regions.map(r=>normalizeSpecies(String(r.text??'')))
  for(let i=0;i<regions.length;i++) {
    const row=regions[i]
    if(!row.text || !/[+=→]/.test(row.text))continue
    const input=normalizeSpecies(row.text)
    const matches=[...input.matchAll(speciesPattern)]
    for(const match of matches) {
      const species=match[1]
      // '1' is not a valid physical-state label. Prefer independently
      // recognized '(l)' only when the *same species* occurs elsewhere.
      const expected=species+'(l)'
      const verifiedElsewhere=normalized.some((line,j)=>j!==i && line.includes(expected))
      if(!verifiedElsewhere)continue
      const erroneous=species+'(1)'
      if(!row.text.includes(erroneous))continue
      const corrected=row.text.replace(erroneous,expected)
      if(corrected===row.text)continue
      row.text=corrected
      row.uncertain=true
      row.phaseGlyphReconciled=true
      row.phaseEvidence={before:erroneous,after:expected,
        reason:'same_species_independently_recognized_with_liquid_state'}
      updates.push({index:i,...row.phaseEvidence})
      break
    }
  }
  return {regions,updates}
}
