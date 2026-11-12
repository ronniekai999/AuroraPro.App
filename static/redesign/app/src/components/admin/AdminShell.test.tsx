// @vitest-environment jsdom

import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ADMIN_GROUPS, ADMIN_SECTIONS, AdminShell, adminSectionLabel, type AdminSection } from './AdminShell'

function Page({ start = 'dashboard' }: { start?: AdminSection }) {
  const [section, setSection] = useState<AdminSection>(start)
  return <AdminShell current={section} onSection={setSection}><p>content of {section}</p></AdminShell>
}

describe('the admin page\'s menu', () => {
  it('lists every section once, under the group it belongs to', () => {
    render(<Page />)
    const nav = screen.getByRole('navigation', { name: 'Admin sections' })
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual([
      'Overview',
      'Users', 'Requests', 'Rooms',
      'Libraries', 'Flagged items',
      'Active streams', 'Playback health',
      'Activity', 'Logs', 'Server settings', 'AI providers', 'Sign-in providers', 'Backup and restore',
    ])
    const group = (name: string) => within(within(nav).getByRole('group', { name })).getAllByRole('button').map(b => b.textContent)
    expect(group('People')).toEqual(['Users', 'Requests', 'Rooms'])
    expect(group('Library')).toEqual(['Libraries', 'Flagged items'])
    expect(group('Playback')).toEqual(['Active streams', 'Playback health'])
    expect(group('System')).toEqual(['Activity', 'Logs', 'Server settings', 'AI providers', 'Sign-in providers', 'Backup and restore'])
    // One list of sections behind the groups: no id twice, none missing.
    const ids = ADMIN_SECTIONS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(ADMIN_GROUPS.reduce((n, g) => n + g.sections.length, 0))
  })

  it('opens on the overview, marks the open section, and names the section it shows', () => {
    render(<Page />)
    const nav = screen.getByRole('navigation', { name: 'Admin sections' })
    expect(within(nav).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getAllByRole('button').filter(b => b.hasAttribute('aria-current'))).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument()
    const section = screen.getByRole('region', { name: 'Overview' })
    expect(section).toHaveTextContent('content of dashboard')
  })

  it('shows the section whose name is pressed, one at a time', () => {
    render(<Page />)
    const nav = screen.getByRole('navigation', { name: 'Admin sections' })
    fireEvent.click(within(nav).getByRole('button', { name: 'AI providers' }))
    expect(within(nav).getByRole('button', { name: 'AI providers' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('button', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('region', { name: 'AI providers' })).toHaveTextContent('content of llm')
    expect(screen.queryByText('content of dashboard')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'AI providers' })).toBeInTheDocument()
  })

  it('tells the page which section was asked for, and does not switch by itself', () => {
    const onSection = vi.fn()
    render(<AdminShell current="users" onSection={onSection}><p>users</p></AdminShell>)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    expect(onSection).toHaveBeenCalledWith('logs')
    expect(screen.getByRole('button', { name: 'Users' })).toHaveAttribute('aria-current', 'page')
  })

  // No entry carries a count. The one number the page had to hand for
  // Requests counts requests already sent on to be downloaded, not the ones
  // waiting for an answer here, and it was read only by the overview.
  it('names every entry by its section alone', () => {
    render(<Page />)
    const names = within(screen.getByRole('navigation', { name: 'Admin sections' })).getAllByRole('button').map(b => b.textContent)
    expect(names).toEqual(ADMIN_SECTIONS.map(s => s.label))
  })

  it('names each section the way its menu entry does', () => {
    expect(adminSectionLabel('sessions')).toBe('Active streams')
    expect(adminSectionLabel('llm')).toBe('AI providers')
    expect(adminSectionLabel('oauth')).toBe('Sign-in providers')
    expect(adminSectionLabel('dashboard')).toBe('Overview')
  })
})
