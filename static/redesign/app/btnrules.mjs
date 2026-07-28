import postcss from 'postcss'
import fs from 'fs'
const css = fs.readFileSync(process.argv[2],'utf8')
const root = postcss.parse(css)
const hits = []
root.walkRules(rule => {
  // split selector list, keep parts referencing button as a type selector
  const parts = rule.selector.split(/,(?![^()\[\]]*[)\]])/).map(s=>s.trim())
  const matched = parts.filter(p => /(^|[\s>+~(])button\b(?![-\w])/.test(p))
  if (matched.length) {
    let at = []
    let p = rule.parent
    while (p && p.type !== 'root') { at.push(p.name+' '+p.params); p = p.parent }
    hits.push({sel: matched.join(', '), at: at.join(' | '), decls: rule.nodes.filter(n=>n.type==='decl').map(d=>`${d.prop}: ${d.value}${d.important?' !important':''}`)})
  }
})
console.log(`total button-referencing rules: ${hits.length}`)
for (const h of hits) console.log(`\n--- ${h.sel}${h.at? '   @['+h.at+']':''}\n    ${h.decls.join('\n    ')}`)
