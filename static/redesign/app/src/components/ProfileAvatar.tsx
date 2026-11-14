import { nebulaFill, parseNebula } from './NebulaAvatar'
import { personColor, personInitial } from '@/lib/personColor'
import { useProfileColorKey } from '@/lib/profileColors'

interface ProfileAvatarBase {
  /** A profile's avatar_url: a "nebula:<id>" id, an http(s) image URL, or empty. */
  avatarUrl?: string | null
  /** Name whose initial is drawn when there is no image (on a nebula's
   *  gradient, or on the profile's own colour). */
  name?: string
  /** Diameter in px (default 40). */
  size?: number
  className?: string
}
// One key or the other, never both: both are numbers, and a member's user id
// passed as a profile's would be looked up among the account's profiles and
// quietly coloured as one of them.
type ProfileAvatarProps = ProfileAvatarBase & ({
  /** A PROFILE's id (or, with none, nothing: the name is used). It picks the
   *  disc's colour when there is no nebula or image, from the account's own
   *  set (lib/profileColors), so no two profiles on one account share a
   *  colour and a profile is the same colour on every screen. */
  colorKey?: number | string
  memberKey?: undefined
} | {
  /** A MEMBER's user id, for another account's avatar. Used as it is, which
   *  is also that person's colour in a watch party's roster and chat. */
  memberKey: number
  colorKey?: undefined
})

/**
 * ProfileAvatar renders a profile's avatar in one place: the name's initial on
 * the chosen nebula's gradient for a "nebula:<id>" value, an <img> for an
 * http(s) URL (an OAuth photo), or the initial on a disc of that profile's own
 * colour, so profiles without a chosen avatar are still told apart at a
 * glance.
 */
export function ProfileAvatar({ avatarUrl, name, colorKey, memberKey, size = 40, className = '' }: ProfileAvatarProps) {
  const profileSlot = useProfileColorKey(typeof colorKey === 'number' ? colorKey : undefined)
  const nb = parseNebula(avatarUrl)
  const isUrl = !nb && !!avatarUrl && (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://'))
  return (
    // aria-hidden on the whole box. The avatar is decorative in every call
    // site: the name it stands for is always rendered as real text beside it
    // or carried by the control's own label.
    //
    // It matters because of the initial: unlike the <img> (alt=""), a bare
    // text node IS announced. A profile called Alice read as "A, Alice,
    // Default": the initial spoken as a word before the name it abbreviates.
    <span
      aria-hidden="true"
      data-profile-avatar={nb ? 'nebula' : isUrl ? 'image' : 'initial'}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-display font-bold text-action-on ${className}`}
      style={{
        width: size,
        height: size,
        // Never below the 12px floor, however small the disc.
        fontSize: Math.max(12, Math.round(size * 0.42)),
        background: nb ? nebulaFill(nb)
          : isUrl ? 'var(--surface-raised-2)'
          : personColor(memberKey ?? profileSlot ?? colorKey ?? name ?? ''),
      }}
    >
      {isUrl ? <img src={avatarUrl!} alt="" className="h-full w-full object-cover" /> : personInitial(name)}
    </span>
  )
}
