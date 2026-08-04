import { describe, expect, it } from 'vitest'
import { SOCIAL_NETWORKS, normalizeHandleInput, socialUrl, type SocialNetwork } from './socialLinks'

const net = (key: SocialNetwork['key']): SocialNetwork => {
  const n = SOCIAL_NETWORKS.find(n => n.key === key)
  if (!n) throw new Error(`unknown network ${key}`)
  return n
}

describe('normalizeHandleInput', () => {
  it('leaves bare handles alone', () => {
    expect(normalizeHandleInput('ronnie_k', net('social_x'))).toBe('ronnie_k')
  })

  it('strips a leading @ and padding', () => {
    expect(normalizeHandleInput('  @ronnie_k ', net('social_x'))).toBe('ronnie_k')
  })

  it('empty input means clear', () => {
    expect(normalizeHandleInput('   ', net('social_x'))).toBe('')
  })

  it('reduces pasted profile URLs to the handle', () => {
    expect(normalizeHandleInput('https://x.com/ronnie_k', net('social_x'))).toBe('ronnie_k')
    // Legacy + mobile domains still paste fine.
    expect(normalizeHandleInput('https://www.twitter.com/ronnie_k', net('social_x'))).toBe('ronnie_k')
    expect(normalizeHandleInput('m.facebook.com/ronnie.k', net('social_facebook'))).toBe('ronnie.k')
    expect(normalizeHandleInput('https://www.instagram.com/ronnie.k/', net('social_instagram'))).toBe('ronnie.k')
    expect(normalizeHandleInput('snapchat.com/add/ronniek', net('social_snapchat'))).toBe('ronniek')
  })

  it('drops query and fragment tails', () => {
    expect(normalizeHandleInput('https://instagram.com/ronnie.k?igsh=abc#top', net('social_instagram'))).toBe('ronnie.k')
  })

  // PR-428 review: these shapes used to reduce to segments that PASS the
  // server's shape regexes while linking to the wrong place ("profile.php",
  // "intent", "m.facebook.com"). The server checks shape, not intent — the
  // refusal has to happen here.
  it('refuses URL shapes whose handle cannot honestly be derived', () => {
    expect(normalizeHandleInput('facebook.com/profile.php?id=123', net('social_facebook'))).toBeNull()
    expect(normalizeHandleInput('https://x.com/intent/follow?screen_name=x', net('social_x'))).toBeNull()
    expect(normalizeHandleInput('facebook.com/pages/whatever', net('social_facebook'))).toBeNull()
    expect(normalizeHandleInput('unknownsite.com/name', net('social_x'))).toBeNull()
    expect(normalizeHandleInput('unknownsite.com/', net('social_instagram'))).toBeNull()
    expect(normalizeHandleInput('instagram.com/', net('social_instagram'))).toBeNull()
  })
})

describe('socialUrl', () => {
  it('builds against the fixed base with encoding', () => {
    expect(socialUrl(net('social_x'), 'ronnie_k')).toBe('https://x.com/ronnie_k')
    expect(socialUrl(net('social_snapchat'), 'ronnie.k')).toBe('https://snapchat.com/add/ronnie.k')
  })
})
