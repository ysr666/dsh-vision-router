/**
 * Conservative question-heading recovery for photographed Chinese textbooks.
 * Runs only on OCR observations: no image-specific expected answers are injected.
 */
const chinese = String.raw`\\p{Script=Han}`;
const headingPattern = /^\s*(1[0-2]|[1-9])[.．、]\s*(?=\S)/u;
const attachedPattern = /^\s*(1[0-2]|[1-9])\s*(\p{Script=Han}.{3,})/u;
const marginPattern = /^\s*(1[0-2]|[1-9])([.．、]?)\s*(\p{Script=Han}.{3,})/u;
const compact = (s) => s.normalize('NFKC').replace(/∆/gu,'Δ')
  .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const midpoint = (box) => (box[1] + box[3]) / 2;
function oneCharacterDisagreement(a,b) {
  if (a.length < 5 || b.length < 5) return false
  const n = Math.min(7,a.length,b.length)
  let edits=0
  for(let i=0;i<n;i++) if(a[i]!==b[i]) edits++
  return edits===1
}

function prefixEditDistance(a,b) {
  const n=Math.min(7,Array.from(a).length,Array.from(b).length)
  const x=Array.from(a).slice(0,n), y=Array.from(b).slice(0,n)
  const dist=Array.from({length:y.length+1},(_,i)=>i)
  for(const c of x) {
    const next=[dist[0]+1]
    for(let j=0;j<y.length;j++) {
      next.push(Math.min(next[j]+1,dist[j+1]+1,dist[j]+(c===y[j]?0:1)))
    }
    for(let j=0;j<next.length;j++)dist[j]=next[j]
  }
  return dist.at(-1)
}
function anchorNumber(region) {
  const m = String(region.text ?? '').match(headingPattern);
  return m ? Number(m[1]) : null;
}

function isSandwichedBetweenConsecutiveHeadings(regions,target,n) {
  const y=midpoint(target.box)
  return regions.some(r=>midpoint(r.box)<y-8 && anchorNumber(r)===n-1) &&
         regions.some(r=>midpoint(r.box)>y+8 && anchorNumber(r)===n+1)
}
function sequentiallyPlausible(regions, target, value) {
  const y = midpoint(target.box);
  const earlier = regions.filter(r => r !== target && midpoint(r.box) < y - 8)
    .map(anchorNumber).filter(Number.isFinite);
  const later = regions.filter(r => r !== target && midpoint(r.box) > y + 8)
    .map(anchorNumber).filter(Number.isFinite);
  const previous = earlier.length ? Math.max(...earlier) : null;
  const next = later.length ? Math.min(...later) : null;
  // Do not manufacture a number from an isolated OCR hallucination.
  // Require a preceding observed heading, then strictly increasing order.
  return previous !== null && value > previous &&
    (next === null || value < next) &&
    (next === null || value - previous <= 3);
}

function reconcileOneMissingFormulaDigit(row,n,marginBody,label) {
  // Only a single missing digit may be inserted into an observed chemical
  // formula. Never invent a decimal point or substitute an uncertain digit.
  if(label.confidence < 0.95 || row.confidence < 0.90) return false
  const alternatives=marginBody.match(/[A-Z]\d+[A-Z]\d+(?:[A-Z]\d*)*/g) ?? []
  for(const observed of alternatives) {
    if(row.text.includes(observed)) continue
    for(let k=0;k<observed.length;k++) {
      if(!/[0-9]/.test(observed[k]))continue
      const missing=observed.slice(0,k)+observed.slice(k+1)
      const occurrence=row.text.indexOf(missing)
      if(occurrence<0 || row.text.indexOf(missing,occurrence+1)>=0)continue
      const proposed=row.text.slice(0,occurrence)+observed+row.text.slice(occurrence+missing.length)
      const reference=compact(n+'. '+marginBody)
      if(reference.length < 10 || !compact(proposed).startsWith(reference.slice(0,Math.min(15,reference.length)))) continue
      row.text=proposed
      row.uncertain=true
      row.formulaDigitReconciled=true
      row.formulaRecoveryEvidence={from:missing,to:observed,sourceConfidence:label.confidence}
      return true
    }
  }
  return false
}
export function recoverPhotoQuestionHeadings(regions, leftMarginLabels = []) {
  const recovered = [];
  const rejected = [];
  const byY = [...leftMarginLabels].sort((a, b) => midpoint(a.box) - midpoint(b.box));

  // Recover a missing separator only when digit + Chinese text are already
  // present in the main OCR line and surrounding headings agree.
  for (const row of regions) {
    if (anchorNumber(row) !== null) continue;
    const m = String(row.text ?? '').match(attachedPattern);
    if (!m) continue; // 2C8H18 is a chemical coefficient, NOT question 2
    const n = Number(m[1]);
    if (!sequentiallyPlausible(regions, row, n)) {
      rejected.push({ number: n, reason: 'heading_sequence_conflict' });
      continue;
    }
    row.text = n + '. ' + m[2];
    row.uncertain = true;
    row.numberRecovered = true;
    row.numberRecoveryMethod = 'inline_digit_context';
    recovered.push(n);
  }

  for (const label of byY) {
    if (!Number.isFinite(label?.confidence) || label.confidence < 0.85 ||
      !Array.isArray(label.box) || label.box.length !== 4) continue;
    const m = String(label.text ?? '').match(marginPattern);
    if (!m) continue;
    const n = Number(m[1]);
    const fragment = compact(m[3]).slice(0, 7);
    if (fragment.length < 4) continue;
    const y = midpoint(label.box);
    const hits = regions.filter(row => {
      if (!Array.isArray(row.box) || row.box.length !== 4) return false;
      if (Math.abs(midpoint(row.box) - y) > 14) return false;
      const body = compact(row.text).replace(/^\d{1,2}/, '');
      return body.startsWith(fragment.slice(0, 4)) ||
        body.includes(fragment.slice(0, 6)) ||
        (row.confidence >= 0.85 && (
          oneCharacterDisagreement(body,fragment) ||
          (isSandwichedBetweenConsecutiveHeadings(regions,row,n) &&
            prefixEditDistance(body,fragment)<=2)
        ));
    });
    if (hits.length !== 1) continue;
    const target = hits[0];
    const existing = anchorNumber(target);
    if (existing === n) continue;
    if (existing !== null) {
      target.uncertain = true;
      rejected.push({ number: n, reason: 'observed_number_conflict' });
      continue;
    }
    if (!sequentiallyPlausible(regions, target, n)) {
      rejected.push({ number: n, reason: 'heading_sequence_conflict' });
      continue;
    }
    // A number without a printed/recognized period can be accepted only
    // with monotonic neighboring evidence, and remains uncertain.
    const original = target.text;
    const fuzzyUsed = !compact(original).replace(/^\d{1,2}/,'')
      .startsWith(fragment.slice(0,4));
    target.text = n + '. ' + original.trim();
    target.uncertain = target.uncertain || !m[2] || fuzzyUsed;
    target.numberRecoveryDisagreement = fuzzyUsed;
    target.numberRecovered = true;
    target.numberRecoveryMethod = 'margin_correlated';
    target.numberRawEvidence = label.text;
    recovered.push(n);
  }
  const formulaReconciled=[]
  // Compare the beginning of a line with the independent high-resolution
  // left-margin view, including lines whose heading was already present.
  for(const label of byY) {
    const m=String(label.text??'').match(marginPattern)
    if(!m)continue
    const n=Number(m[1]),y=midpoint(label.box)
    const hits=regions.filter(row=>anchorNumber(row)===n &&
      Math.abs(midpoint(row.box)-y)<=14)
    if(hits.length!==1)continue
    if(reconcileOneMissingFormulaDigit(hits[0],n,m[3],label)){
      formulaReconciled.push(n)
    }
  }
  return { regions, recovered, rejected, formulaReconciled };
}
