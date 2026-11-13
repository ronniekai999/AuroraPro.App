// @vitest-environment jsdom
//
// The party's mini dock: a reaction, a one-line quick reply and the
// microphone, over the picture in the party's minimal face. What it sends
// is the rail's (onSendChat, onSendReaction, onToggleVoiceMute); these pin
// that it sends exactly that, and how it is drawn: an opaque raised card in
// the app's colours, with nothing violet.

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MiniDock } from './MiniDock'
import type { VoiceState } from '@/lib/voice'

const voice = (over: Partial<VoiceState> = {}) => ({ enabled: true, muted: false, ...over }) as VoiceState
const field = () => screen.getByRole('textbox', { name: 'Send a quick chat message' })
const dock = () => document.querySelector<HTMLElement>('.stage-party-minidock')!

describe('MiniDock', () => {
  it('sends the reply on Enter, trimmed, and empties the field; sends nothing blank', async () => {
    const user = userEvent.setup()
    const onSendChat = vi.fn()
    render(<MiniDock onSendChat={onSendChat} />)
    expect(field()).toHaveAttribute('placeholder', 'Reply to the party')
    expect(field()).toHaveAttribute('maxlength', '500')
    await user.type(field(), '   {Enter}')
    expect(onSendChat).not.toHaveBeenCalled()
    await user.clear(field())
    await user.type(field(), '  that ending!  {Enter}')
    expect(onSendChat).toHaveBeenCalledTimes(1)
    expect(onSendChat).toHaveBeenCalledWith('that ending!')
    expect(field()).toHaveValue('')
  })

  // Send is there only while there is something to send: a resting dock is
  // one stop shorter for the keys.
  it('offers Send only with text, and sends with it', async () => {
    const user = userEvent.setup()
    const onSendChat = vi.fn()
    render(<MiniDock onSendChat={onSendChat} />)
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
    await user.type(field(), 'brb')
    const send = screen.getByRole('button', { name: 'Send message' })
    expect(send.className.split(/\s+/)).toEqual(expect.arrayContaining(['bg-action-soft', 'w-10', 'h-10', 'stage-hit44']))
    // Hover lifts the fill a step above its resting --action-soft.
    expect(send.className.split(/\s+/)).toContain('hover:bg-[var(--action-soft-hover)]')
    await user.click(send)
    expect(onSendChat).toHaveBeenCalledWith('brb')
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
  })

  it('sends a reaction from its picker', async () => {
    const user = userEvent.setup()
    const onSendReaction = vi.fn()
    render(<MiniDock onSendChat={() => {}} onSendReaction={onSendReaction} />)
    const trigger = screen.getByRole('button', { name: 'Send a reaction' })
    expect(trigger.className.split(/\s+/)).toEqual(expect.arrayContaining(['stage-hit44', 'w-10', 'h-10']))
    // Open, the trigger keeps the fill it has under the pointer, and says
    // so where index.css looks for it (the cast card goes under the dock).
    expect(trigger.className.split(/\s+/)).toEqual(expect.arrayContaining(['stage-minidock-reaction', 'data-[open]:bg-action-soft']))
    expect(trigger).not.toHaveAttribute('data-open')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('data-open')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const group = screen.getByRole('group', { name: 'Send a reaction' })
    await user.click(group.querySelectorAll('button')[0])
    expect(onSendReaction).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('mutes and unmutes a live microphone, and says it must be joined first otherwise', () => {
    const toggle = vi.fn()
    const view = render(<MiniDock onSendChat={() => {}} voice={voice()} onToggleVoiceMute={toggle} />)
    const live = screen.getByRole('button', { name: 'Mute microphone' })
    expect(live).toHaveAttribute('aria-pressed', 'true')
    // Live is drawn in the colour for "on", in the app's tokens.
    expect(live.className.split(/\s+/)).toContain('text-ok')
    // Hover lifts its fill and keeps the colour for "on".
    expect(live.className.split(/\s+/)).toContain('hover:bg-[var(--action-soft-hover)]')
    expect(live.className).not.toMatch(/hover:text-/)
    fireEvent.click(live)
    expect(toggle).toHaveBeenCalledTimes(1)
    view.rerender(<MiniDock onSendChat={() => {}} voice={voice({ muted: true })} onToggleVoiceMute={toggle} />)
    const muted = screen.getByRole('button', { name: 'Unmute microphone' })
    expect(muted).toHaveAttribute('aria-pressed', 'false')
    expect(muted.className.split(/\s+/)).not.toContain('text-ok')
    view.rerender(<MiniDock onSendChat={() => {}} voice={voice({ enabled: false, muted: true })} onToggleVoiceMute={toggle} />)
    const out = screen.getByRole('button', { name: 'Unmute microphone' })
    expect(out).toBeDisabled()
    expect(out).toHaveAttribute('title', 'Join voice from the voice pill first')
    view.rerender(<MiniDock onSendChat={() => {}} />)
    expect(screen.queryByRole('button', { name: /microphone/ })).toBeNull()
  })

  // Opaque, in the app's colours: it sits on moving video, where a see-
  // through fill fails contrast over a bright frame.
  it('is an opaque raised card in the app\'s colours, with nothing violet or see-through', async () => {
    const user = userEvent.setup()
    render(<MiniDock onSendChat={() => {}} onSendReaction={() => {}} voice={voice()} onToggleVoiceMute={() => {}} />)
    await user.type(field(), 'x')
    const classes = dock().className.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['stage-party-minidock', 'bg-surface-raised-2', 'rounded-control', 'fixed', 'z-[67]']))
    expect(field().className.split(/\s+/)).toContain('stage-minidock-field')
    const html = dock().outerHTML
    expect(html).not.toMatch(/a855f7|7e22ce|7c3aed|violet|purple|emerald|backdrop-blur|glass|rgba\(8,6,14|rgba\(220,200,255/i)
  })
})
