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

  it('reduces pasted profile URLs to the handle', () => {
    expect(normalizeHandleInput('https://x.com/ronnie_k', net('social_x'))).toBe('ronnie_k')
    // Legacy domain still pastes fine.
    expect(normalizeHandleInput('https://www.twitter.com/ronnie_k', net('social_x'))).toBe('ronnie_k')
    expect(normalizeHandleInput('https://www.instagram.com/ronnie.k/', net('social_instagram'))).toBe('ronnie.k')
    expect(normalizeHandleInput('snapchat.com/add/ronniek', net('social_snapchat'))).toBe('ronniek')
  })

  it('drops query and fragment tails', () => {
    expect(normalizeHandleInput('https://instagram.com/ronnie.k?igsh=abc#top', net('social_instagram'))).toBe('ronnie.k')
  })

  it('does not validate shape — that is the server contract', () => {
    // A slash-bearing paste that matches no known prefix reduces to its
    // first segment; the server rejects it if it is not a valid handle.
    expect(normalizeHandleInput('facebook.com/pages/whatever', net('social_facebook'))).toBe('pages')
  })
})

describe('socialUrl', () => {
  it('builds against the fixed base with encoding', () => {
    expect(socialUrl(net('social_x'), 'ronnie_k')).toBe('https://x.com/ronnie_k')
    expect(socialUrl(net('social_snapchat'), 'ronnie.k')).toBe('https://snapchat.com/add/ronnie.k')
  })
})
