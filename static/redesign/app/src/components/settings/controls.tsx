// The pieces every Settings pane is made of: a titled section, a row with
// its control on the right, a switch, and the one dropdown.

import { useId, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'

export function PaneSection({ title, note, children }: {
  title: string
  /** One line under the title: where the section's choices are kept, or what
   *  they cannot do. */
  note?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="mb-10 last:mb-0">
      <h2 id={id} className="font-display text-[22px] font-semibold leading-tight text-ink">{title}</h2>
      {note && <p className="mt-1.5 max-w-[62ch] text-[13px] leading-snug text-ink-2">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** A label and its explanation on the left, the control on the right; the
 *  control drops under the text when the row is too narrow for both. */
export function SettingRow({ label, desc, htmlFor, labelId, descId, children }: {
  label: ReactNode
  desc?: ReactNode
  /** The id of the form control this row labels (a select, an input). */
  htmlFor?: string
  /** For a control labelled by reference instead (a switch, a group). */
  labelId?: string
  descId?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line py-4 first:border-t-0 first:pt-1">
      <div className="min-w-0 flex-1 basis-[16rem]">
        {htmlFor
          ? <label htmlFor={htmlFor} className="block text-[15px] font-semibold text-ink">{label}</label>
          : <p id={labelId} className="text-[15px] font-semibold text-ink">{label}</p>}
        {desc && <p id={descId} className="mt-0.5 max-w-[56ch] text-[13px] leading-snug text-ink-2">{desc}</p>}
      </div>
      {children && <div className="flex flex-none flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

/** An on/off switch. The button is 48 by 44 so a thumb can hit it; the track
 *  inside it is the picture. */
export function SettingSwitch({ checked, onChange, labelledBy, describedBy, disabled }: {
  checked: boolean
  onChange: (next: boolean) => void
  labelledBy: string
  describedBy?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="grid h-11 w-12 flex-none place-items-center rounded-control disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span aria-hidden="true" className={`toggle ${checked ? 'active' : ''}`}><span className="toggle-handle" /></span>
    </button>
  )
}

export interface SelectOption {
  value: string
  label: string
}

/** The dropdown. A native <select>, so a phone shows its own picker and a
 *  keyboard gets type-ahead; only the box is drawn here. */
export function SettingSelect({ id, value, onChange, options, disabled, wide = false, ...aria }: {
  id?: string
  value: string
  onChange: (value: string) => void
  options: readonly SelectOption[]
  disabled?: boolean
  /** Room for a long option ("Up to PG-13 and TV-14"). */
  wide?: boolean
  'aria-label'?: string
  'aria-describedby'?: string
}) {
  return (
    <span className={`relative inline-block max-w-full ${wide ? 'w-64' : 'w-60'}`}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="h-11 w-full appearance-none truncate py-0 pl-3 pr-9 text-[14px] disabled:cursor-not-allowed disabled:opacity-60"
        {...aria}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon name="chevronDown" size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2" />
    </span>
  )
}

/** A line of plain words in place of controls a session is not offered. */
export function PaneNote({ children }: { children: ReactNode }) {
  return <p className="rounded-control bg-surface-raised px-4 py-3 text-[14px] leading-snug text-ink-2">{children}</p>
}
