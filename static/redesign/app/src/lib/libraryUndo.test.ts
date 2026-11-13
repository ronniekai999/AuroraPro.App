import { describe, expect, it } from 'vitest'
import { undoMayRestore } from './libraryUndo'

const PARENT = 'aurora_my_library:1:1'
const KID = 'aurora_my_library:1:2'
const OTHER_ACCOUNT = 'aurora_my_library:2:1'

describe('whether Undo may put a removed title back', () => {
  it('may, on the list it was removed from, while the title is not in it', () => {
    expect(undoMayRestore(PARENT, PARENT, [], 7)).toBe(true)
    expect(undoMayRestore(PARENT, PARENT, [{ id: 3 }, { id: 9 }], 7)).toBe(true)
  })

  it('may not when the title is in the list: there is nothing to undo', () => {
    expect(undoMayRestore(PARENT, PARENT, [{ id: 7 }], 7)).toBe(false)
    expect(undoMayRestore(PARENT, PARENT, [{ id: 3 }, { id: 7 }], 7)).toBe(false)
  })

  it('may not on another profile\'s list, another account\'s, or with nobody signed in', () => {
    expect(undoMayRestore(KID, PARENT, [], 7)).toBe(false)
    expect(undoMayRestore(OTHER_ACCOUNT, PARENT, [], 7)).toBe(false)
    expect(undoMayRestore(null, PARENT, [], 7)).toBe(false)
    // A removal made with no list on screen undoes into none.
    expect(undoMayRestore(null, null, [], 7)).toBe(false)
    expect(undoMayRestore(PARENT, null, [], 7)).toBe(false)
  })
})
