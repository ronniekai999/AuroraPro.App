/** The page's text as a reader gets it: one text node after another, with a
 *  space between. `textContent` runs neighbours together, so the last card's
 *  year and the line under the rails ("2020", then "37 titles in your
 *  library") read as "202037 titles", and a count that is looked for at a
 *  word boundary is missed, or found inside another number. */
export function pageText(root: Node = document.body): string {
  const out: string[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.nodeValue ?? '')
  return out.join(' ').replace(/\s+/g, ' ')
}
