import { NebulaAvatar, parseNebula } from './NebulaAvatar'

interface ProfileAvatarProps {
  /** A profile's avatar_url: a "nebula:<id>" id, an http(s) image URL, or empty. */
  avatarUrl?: string | null
  /** Name used for the initial fallback when there's no nebula/image. */
  name?: string
  /** Diameter in px (default 40). */
  size?: number
  className?: string
}

/**
 * ProfileAvatar renders the correct visual for a profile's avatar in one place:
 * the animated nebula orb for a "nebula:<id>" value, an <img> for an http(s)
 * URL (e.g. an OAuth photo), or the name's initial on a purple gradient. Used by
 * the top-bar account menu and the profile switcher so they stay consistent.
 */
export function ProfileAvatar({ avatarUrl, name, size = 40, className = '' }: ProfileAvatarProps) {
  const nb = parseNebula(avatarUrl)
  if (nb) return <NebulaAvatar nebula={nb} size={size} className={className} />

  const isUrl = !!avatarUrl && (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://'))
  const initial = (name?.trim()?.[0] ?? 'U').toUpperCase()
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-purple-500 to-purple-700 font-bold text-white ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {isUrl ? <img src={avatarUrl!} alt="" className="h-full w-full object-cover" /> : initial}
    </span>
  )
}
