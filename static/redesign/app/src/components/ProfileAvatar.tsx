import { NebulaAvatar, parseNebula } from './NebulaAvatar'
import { personColor, personInitial } from '@/lib/personColor'

interface ProfileAvatarProps {
  /** A profile's avatar_url: a "nebula:<id>" id, an http(s) image URL, or empty. */
  avatarUrl?: string | null
  /** Name used for the initial when there is no nebula or image. */
  name?: string
  /** What picks the disc's colour when there is no nebula or image: the
   *  profile's or member's id where the caller has one, so the same profile
   *  is the same colour on every screen. Falls back to the name. */
  colorKey?: number | string
  /** Diameter in px (default 40). */
  size?: number
  className?: string
}

/**
 * ProfileAvatar renders a profile's avatar in one place: the animated nebula
 * orb for a "nebula:<id>" value, an <img> for an http(s) URL (an OAuth photo),
 * or the name's initial on a disc of that profile's own colour, so profiles
 * without a chosen avatar are still told apart at a glance.
 */
export function ProfileAvatar({ avatarUrl, name, colorKey, size = 40, className = '' }: ProfileAvatarProps) {
  const nb = parseNebula(avatarUrl)
  if (nb) return <NebulaAvatar nebula={nb} size={size} className={className} />

  const isUrl = !!avatarUrl && (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://'))
  return (
    // aria-hidden on the whole box. The avatar is decorative in every call
    // site: the name it stands for is always rendered as real text beside it
    // or carried by the control's own label.
    //
    // It matters because of the initial-letter branch: unlike the <img>
    // (alt="") and NebulaAvatar (already aria-hidden), a bare text node IS
    // announced. A profile called Alice with no nebula read as "A, Alice,
    // Default": the initial spoken as a word before the name it abbreviates.
    <span
      aria-hidden="true"
      data-profile-avatar={isUrl ? 'image' : 'initial'}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-display font-bold text-action-on ${className}`}
      style={{
        width: size,
        height: size,
        // Never below the 12px floor, however small the disc.
        fontSize: Math.max(12, Math.round(size * 0.42)),
        background: isUrl ? 'var(--surface-raised-2)' : personColor(colorKey ?? name ?? ''),
      }}
    >
      {isUrl ? <img src={avatarUrl!} alt="" className="h-full w-full object-cover" /> : personInitial(name)}
    </span>
  )
}
