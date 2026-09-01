import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

function read(file) {
  return readFileSync(file, 'utf8')
}

function write(file, value) {
  writeFileSync(file, value)
}

function replaceOnce(file, search, replacement, label) {
  const source = read(file)
  const first = source.indexOf(search)
  if (first === -1) throw new Error(`${label}: source pattern not found in ${file}`)
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`${label}: source pattern matched more than once in ${file}`)
  }
  write(file, source.slice(0, first) + replacement + source.slice(first + search.length))
}

function replaceRegexOnce(file, pattern, replacement, label) {
  const source = read(file)
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))]
  if (matches.length !== 1) throw new Error(`${label}: expected one match in ${file}, got ${matches.length}`)
  write(file, source.replace(pattern, replacement))
}

// The alpha.1 Settings IA is the final rendered settings component. It must
// own depth strategy + independent call-cap semantics directly instead of
// relying on a React interception shim from the turn-budget prelude.
replaceOnce(
  'lib/settings-ia-client-prelude.js',
  "        if(key==='visionDepth')return raw==='fast'||raw==='standard'||raw==='deep'||raw==='custom'?{value:raw}:undefined;",
  "        if(key==='visionDepth')return raw==='fast'||raw==='standard'||raw==='deep'?{value:raw}:undefined;",
  'final IA rejects new legacy custom strategy values',
)

const strategyPage = `      function strategyPage(){
        var structured=toggleValue('structuredVisionBootstrap',false);
        var rawDepth=String(value('visionDepth','standard')||'standard');
        var depth=rawDepth==='fast'||rawDepth==='deep'?rawDepth:'standard';
        var rows=guidanceRows();
        var rawCap=Number(value('visionDepthMaxCalls',0));
        var capEnabled=Number.isInteger(rawCap)&&rawCap>=1&&rawCap<=100;
        var capValue=capEnabled?rawCap:4;
        function setCapEnabled(enabled){setValue('visionDepthMaxCalls',enabled?capValue:0);}
        function setCapValue(event){var text=event.target.value;setValue('visionDepthMaxCalls',text===''?'':Number(text));}
        return h(React.Fragment,null,
          title(tx('识图策略','Vision strategy'),tx('只有想改变识图方式或质量时才需要来这里。','Change these only when you want different vision behavior or quality.')),
          card([
            toggle('tool',tx('Agent 按需使用识图工具','Let the agent use vision tools on demand'),tx('允许聊天模型根据任务继续细看、OCR、定位、裁剪和比较图片。建议开启。','Lets the chat model inspect, OCR, locate, crop, and compare images as needed. Recommended on.')),
            toggle('structuredVisionBootstrap',tx('结构化预识别（1+x）','Structured pre-scan (1+x)'),tx('先获取一次全局视觉基线，再针对当前任务继续取证。','Gets a global visual baseline first, then gathers task-specific evidence.'))
          ]),
          structured?card([
            h('div',{className:'vr-field',key:'depth'},
              fieldHead('visionDepth',tx('看图深度','Vision depth')),
              h('select',{
                className:'vr-input vr-select',
                'data-vr-depth-strategy':'1',
                value:depth,
                disabled:!writable||saving,
                onChange:function(event){setValue('visionDepth',event.target.value);}
              },
                h('option',{value:'fast'},tx('快速（优先整体判断）','Quick (overall-first)')),
                h('option',{value:'standard'},tx('标准（按需查证，默认）','Standard (evidence as needed, default)')),
                h('option',{value:'deep'},tx('细致（主动交叉验证）','Thorough (proactive cross-checking)'))
              ),
              h('p',{className:'vr-hint'},tx('看图深度只决定识图策略，不限制调用次数。','Vision depth chooses the inspection strategy; it does not limit call count.'))
            ),
            h('div',{className:'vr-field',key:'guidance'},
              fieldHead('guidanceOverrides',tx('自定义识图引导','Custom vision guidance')),
              h('p',{className:'vr-hint'},tx('通常无需设置。','Usually unnecessary.')),
              rows.map(function(row,index){return h('div',{className:'vr-chain-row',key:index},
                h('input',{className:'vr-input',placeholder:'document',value:row.kind||'',disabled:!writable||saving,onChange:function(event){var copy=rows.map(function(item){return Object.assign({},item);});copy[index]={kind:event.target.value,text:row.text||''};setGuidanceDraft(copy);}}),
                h('input',{className:'vr-input',placeholder:tx('重点关注合同条款和签名','Focus on clauses and signatures'),value:row.text||'',disabled:!writable||saving,onChange:function(event){var copy=rows.map(function(item){return Object.assign({},item);});copy[index]={kind:row.kind||'',text:event.target.value};setGuidanceDraft(copy);}}),
                h('button',{type:'button',className:'vr-reset',disabled:!writable||saving,onClick:function(){var copy=rows.filter(function(_,i){return i!==index;});setGuidanceDraft(copy.length?copy:[{kind:'',text:''}]);}},tx('移除','Remove'))
              );}),
              h('button',{type:'button',className:'vr-btn',disabled:!writable||saving,onClick:function(){setGuidanceDraft(rows.concat([{kind:'',text:''}]))}},tx('+ 添加自定义引导','+ Add custom guidance'))
            )
          ]):null,
          card([
            h('div',{className:'vr-field',key:'depth-cap','data-vr-depth-cap':'1'},
              h('div',{className:'vr-ia-toggle-row'},
                h('div',{className:'vr-ia-grow'},
                  fieldHead('visionDepthMaxCalls',tx('限制深挖次数','Limit deep-dive calls')),
                  h('p',{className:'vr-hint'},tx('默认关闭，不限制视觉证据调用次数。启用后只统计成功且产生有效证据的深挖调用；bootstrap、失败或空证据调用不占次数。','Off by default, so visual evidence calls are unlimited. When enabled, only successful deep-dive calls that produce usable evidence count; bootstrap, failed, and empty-evidence calls do not.'))
                ),
                h('input',{
                  type:'checkbox',
                  'data-vr-depth-cap-toggle':'1',
                  checked:capEnabled,
                  disabled:!writable||saving,
                  onChange:function(event){setCapEnabled(event.target.checked);}
                })
              ),
              capEnabled?h('div',{className:'vr-field'},
                h('span',{className:'vr-label'},tx('最多深挖次数','Maximum deep-dive calls')),
                h('input',{
                  className:'vr-input',type:'number',min:1,max:100,step:1,
                  'data-vr-depth-cap-value':'1',
                  value:rawCap,
                  disabled:!writable||saving,
                  onChange:setCapValue
                }),
                invalidKeys.includes('visionDepthMaxCalls')?h('p',{className:'vr-failed'},tx('请输入 1–100 之间的整数。','Enter an integer from 1 to 100.')):null
              ):null
            )
          ])
        );
      }
      function localProviderCard`

replaceRegexOnce(
  'lib/settings-ia-client-prelude.js',
  /      function strategyPage\(\)\{[\s\S]*?\n      function localProviderCard/,
  strategyPage,
  'final IA first-class depth strategy and cap controls',
)

// Keep the old-Host fallback semantically aligned: strategy/guidance remain
// conditional on 1+x, but the explicit call cap is a global safety valve.
replaceOnce(
  'lib/client.js',
  `                    ])),\n                    depthCapField(),\n                    guidanceOverridesEditor(),`,
  `                    ])),\n                    guidanceOverridesEditor(),`,
  'legacy client removes cap from structured-only group',
)
replaceOnce(
  'lib/client.js',
  `                : null,\n              // Local vision is a primary capability. Keep the heavy editors`,
  `                : null,\n              depthCapField(),\n              // Local vision is a primary capability. Keep the heavy editors`,
  'legacy client renders independent call cap globally',
)

// The real lifecycle assertion belongs on the final IA's Vision strategy page,
// not on General and not merely in a source-string test.
replaceOnce(
  'tests/alpha1-browser-lifecycle-integration.test.js',
  `  const depthSelect = findNode(generalTree, (node) => node.props?.['data-vr-depth-strategy'] === '1')\n  assert.ok(depthSelect, 'real client bundle must own the depth strategy selector')\n  assert.equal(depthSelect.props.value, 'standard')\n  assert.deepEqual(\n    childrenOf(depthSelect.props.children).map((option) => option.props?.value),\n    ['fast', 'standard', 'deep'],\n  )\n  const depthCap = findNode(generalTree, (node) => node.props?.['data-vr-depth-cap'] === '1')\n  assert.ok(depthCap, 'real client bundle must own the independent depth-call cap')\n  const depthCapToggle = findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-toggle'] === '1')\n  assert.ok(depthCapToggle)\n  assert.equal(depthCapToggle.props.checked, false)\n  assert.equal(findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-value'] === '1'), undefined)`,
  `  React.setSettingsPage('strategy')\n  const strategyTree = section.component(props)\n  const depthSelect = findNode(strategyTree, (node) => node.props?.['data-vr-depth-strategy'] === '1')\n  assert.ok(depthSelect, 'final Settings IA must own the depth strategy selector')\n  assert.equal(depthSelect.props.value, 'standard')\n  assert.deepEqual(\n    childrenOf(depthSelect.props.children).map((option) => option.props?.value),\n    ['fast', 'standard', 'deep'],\n  )\n  const depthCap = findNode(strategyTree, (node) => node.props?.['data-vr-depth-cap'] === '1')\n  assert.ok(depthCap, 'final Settings IA must own the independent depth-call cap')\n  const depthCapToggle = findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-toggle'] === '1')\n  assert.ok(depthCapToggle)\n  assert.equal(depthCapToggle.props.checked, false)\n  assert.equal(findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-value'] === '1'), undefined)`,
  'alpha lifecycle validates final strategy page ownership',
)

// Add a static ownership fence too: the final IA must not regress to producing
// a new legacy custom strategy even if the old schema keeps accepting it.
replaceOnce(
  'tests/depth-tier.test.js',
  `  const prelude = readFileSync(new URL('../lib/vision-turn-budget-client-prelude.js', import.meta.url), 'utf8')\n  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)`,
  `  const prelude = readFileSync(new URL('../lib/vision-turn-budget-client-prelude.js', import.meta.url), 'utf8')\n  const ia = readFileSync(new URL('../lib/settings-ia-client-prelude.js', import.meta.url), 'utf8')\n  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)`,
  'depth-tier reads final IA source',
)
replaceOnce(
  'tests/depth-tier.test.js',
  `  assert.doesNotMatch(prelude, /DEPTH_CAP_FIELD|makeDepthCapCard|stripLegacyCustomOption|projectStrategySnapshot|visionDepthFast/)\n})`,
  `  assert.doesNotMatch(prelude, /DEPTH_CAP_FIELD|makeDepthCapCard|stripLegacyCustomOption|projectStrategySnapshot|visionDepthFast/)\n  assert.match(ia, /data-vr-depth-strategy/)\n  assert.match(ia, /data-vr-depth-cap-toggle/)\n  assert.match(ia, /Limit deep-dive calls/)\n  assert.doesNotMatch(ia, /raw==='fast'\\|\\|raw==='standard'\\|\\|raw==='deep'\\|\\|raw==='custom'/)\n})`,
  'depth-tier final IA ownership fence',
)

for (const [file, required] of [
  ['lib/settings-ia-client-prelude.js', ['data-vr-depth-strategy', 'data-vr-depth-cap-toggle', 'Limit deep-dive calls']],
  ['lib/client.js', ['data-vr-depth-strategy', 'data-vr-depth-cap-toggle']],
]) {
  const source = read(file)
  for (const token of required) {
    if (!source.includes(token)) throw new Error(`required P2 ownership token missing in ${file}: ${token}`)
  }
}

unlinkSync('.github/scripts/p2-depth-settings-ia-migrate.mjs')
