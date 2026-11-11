// @vitest-environment jsdom
//
// The reaction picker's row of emoji leaves the document when it closes. If
// one of its buttons had focus, focus must go back to the trigger, not fall
// to <body>.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactionPicker } from './ReactionOverlay'

afterEach(cleanup)

const trigger = () => screen.getByRole('button', { name: 'Send a reaction' })
const emoji = () => screen.getAllByRole('button', { name: /^React with / })

describe('ReactionPicker', () => {
  it('returns focus to the trigger when Escape closes it from inside the row', () => {
    render(<ReactionPicker onSend={() => {}} />)
    fireEvent.click(trigger())
    emoji()[2].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: /^React with / })).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('returns focus to the trigger after a pick made from the keyboard', () => {
    const onSend = vi.fn()
    render(<ReactionPicker onSend={onSend} />)
    fireEvent.click(trigger())
    const first = emoji()[0]
    first.focus()
    fireEvent.click(first)
    expect(onSend).toHaveBeenCalledOnce()
    expect(trigger()).toHaveFocus()
  })

  it('leaves focus alone when it was somewhere else', () => {
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    render(<ReactionPicker onSend={() => {}} />)
    fireEvent.click(trigger())
    elsewhere.focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: /^React with / })).toBeNull()
    expect(elsewhere).toHaveFocus()
    elsewhere.remove()
  })

  it('keeps Escape from the app, and only while it is open', () => {
    render(<ReactionPicker onSend={() => {}} />)
    const appHandler = vi.fn()
    window.addEventListener('keydown', appHandler)
    fireEvent.click(trigger())
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(appHandler).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(appHandler).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', appHandler)
  })
})
