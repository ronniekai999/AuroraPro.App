# Audit 34 (2026-02-26) - iPad Responsiveness & Video Player Fullscreen

## Scope
Audited changes to `static/aurora_pro.html` for iPad responsiveness and video player fullscreen fixes.

## Findings (3 HIGH, 1 MEDIUM, 3 LOW) - ALL HIGH FIXED

### 1. HIGH: safe-area-inset-left/right swapped in nav padding (FIXED)
CSS `padding` shorthand is `top right bottom left`. Code had `safe-area-inset-left` in the right position and vice versa.
- **Before**: `padding: 0 max(24px, env(safe-area-inset-left)) 0 max(24px, env(safe-area-inset-right))`
- **After**: `padding: 0 max(24px, env(safe-area-inset-right)) 0 max(24px, env(safe-area-inset-left))`

### 2. HIGH: overflow:hidden on .nav clips notification badge and active-link underline (FIXED)
Badge uses `top:-2px`, active underline uses `bottom:-4px`. Both overflow nav bounds and get clipped.
- **Fix**: Changed `overflow: hidden` to `overflow-x: clip; overflow-y: visible`
- `overflow-x: clip` prevents horizontal overflow without creating vertical clipping context
- Server panel and notification panel are siblings of nav (not children) so unaffected

### 3. HIGH: toggleFullscreen missing vendor-prefix fallback for iPad Safari 12-16.3 (FIXED)
Only checked `document.fullscreenEnabled` (unprefixed). iPad Safari 12-16.3 has `webkitFullscreenEnabled` + `webkitRequestFullscreen` but not unprefixed versions. Old code sent these iPads to native video fullscreen unnecessarily.
- **Fix**: Check `document.fullscreenEnabled || document.webkitFullscreenEnabled`, use `requestFullscreen || webkitRequestFullscreen`, `exitFullscreen || webkitExitFullscreen`

### 4. MEDIUM: webkit-media-controls CSS comment misleading (FIXED)
Comment said "we provide our own overlay" but during iOS native fullscreen (webkitEnterFullscreen), system controls always show regardless of CSS. Updated comment to clarify suppression is for inline playback only.

### 5. LOW: webkit-playsinline attribute redundant but harmless
`playsinline` (standard, no prefix) is the correct attribute for iOS 10+. `webkit-playsinline` is pre-iOS-10 era, ignored by modern Safari.

### 6. LOW: flex-shrink:0 on nav-right with overflow
Math works for standard device widths (375px+). Only breaks below ~350px. Fixed by finding #2 (overflow-x: clip).

### 7. LOW: webkitendfullscreen empty handler was dead code (FIXED)
Added `showPlayerControls()` call so custom controls are visible after exiting iOS native fullscreen.

## Key Patterns
37. **CSS padding shorthand order**: `padding: top right bottom left`. When using `env(safe-area-inset-*)`, the right value gets `safe-area-inset-right` and the left value gets `safe-area-inset-left`.
38. **`overflow: hidden` clips absolutely-positioned children**: Elements with `position: absolute` and negative offsets (top:-2px, bottom:-4px) extending beyond an `overflow:hidden` parent get clipped. Use `overflow-x: clip; overflow-y: visible` to prevent horizontal overflow without creating a vertical clipping context. Supported Safari 16+, Chrome 90+, Firefox 81+.
39. **Safari fullscreen API vendor prefixes**: iPad Safari 12-16.3 has `webkitFullscreenEnabled`/`webkitRequestFullscreen`/`webkitExitFullscreen` but NOT unprefixed versions. Always check both. iPad Safari 16.4+ and iPhone Safari (never) support unprefixed. Native video fullscreen (`webkitEnterFullscreen`) is the last resort when no div fullscreen is available.
40. **webkitendfullscreen handler**: When users exit iOS native video fullscreen, playback continues inline but custom controls may be hidden. Always call `showPlayerControls()` in the `webkitendfullscreen` handler.
