# Web redesign: known open items

Gaps that the web app's redesign (pull request #558) knowingly leaves, by
screen. Each was found by an independent review or by the builders, judged
acceptable for it, and left as described; where an item is
older than the redesign, or needs server work, it says so. What could not be
checked at all in the build environment is in
[`redesign-device-checks.md`](redesign-device-checks.md).

Fix or file each item, and delete it here when it is no longer true.

- Tonight: a touch or screen-reader viewer is not counted as "in the hero"
  until they press something in it, so for them a Continue Watching answer
  that arrives after the four-second wait can change the hero's title between
  aiming and pressing. A session whose restriction is not yet known asks for
  the recommender's rails, which it may then never be shown (a model build on
  the server for nothing). A limit lifted on another device, without a switch,
  leaves no recommender rails until the next full load. The calmer page's last
  line prints the limit as stored. The phone-hero audit reads the real class
  lists and the built stylesheet but copies the hero's nesting by hand, so an
  element added to the hero is invisible to it until a probe is added.
- Navigation: browser text zoom in the top bar was not exercised.
- Library: the server's title sort has no tiebreaker, so paging can repeat or
  skip equal-titled items (server, older than the redesign).
- Together: a room made while the first read of the rooms is still out can
  vanish until the next read. A reorder of the rooms with a focused button
  inside could drop focus (the order is stable today). The page's own requests
  (rooms, people, the feed) have no guard against an answer for a profile
  another tab has just bound, the gap the app already documents for requests
  of this kind.
- Admin: accepting an AI suggestion removes the item locally, and a read
  already in flight can put it back until the next read (older than the
  redesign); on a title page the two reads after a close mid-match are ordered
  only within that close, so a close, an immediate reopen and a confirmed
  match can show the older details for a moment; the rule that hands focus to
  the list relies on React rendering after the read's answer, which no test
  pins. Playback health cannot tell a playback whose page the browser set
  aside from one that ended well, nor a window where nothing was watched from
  a measured 0% of buffering; it says so, and the missing denominators are
  server work. A restore runs as a job on the server and the page follows it
  through a status route, but that route sits behind the admin guards, which
  read the session from the database the restore is replacing: from the wipe
  until the restore commits it cannot be read (the page says so), and after a
  restore that failed past the wipe it cannot be read until the server
  restarts, which forgets the outcome, so then only the server's log says
  what happened. A successful restore ends every session, so the admin is
  told after signing in again (not checked: whether signing in works before
  the restart the restore asks for), and only when the restored data has the
  same account id. The status is kept in the server's memory; a restart loses
  it. A restore still running when a server stop's wait (4 minutes) or the
  updater's drain (5 minutes) runs out is stopped and can leave the database
  empty (server: making the restore atomic would remove that). On the Admin
  page, an answer that lands after its section has been left is said nowhere, except
  a restore's outcome and the AI settings' restart notice (shown when that
  section is opened again). The server's approve checks a request's status and
  then writes it with nothing atomic between, so two approves of one request
  at once could both pass and send it to the downloader twice (server, older
  than the redesign); the page no longer sends a second approve while one is
  out.
- Report a bug: a pick from the picker that an unreadable startup binding
  opens is not counted as a switch, so a dialog opened in that moment stays
  open across it; a remembered title page that the profile may no longer see
  redirects, and the dialog opens over wherever the tab ends up; the page to
  return to is kept in memory, so after a reload on Me the dialog opens over
  Me; with the player minimised the entry is reachable and a capture includes
  the mini player; the identity panel is one row taller, so at 1024x768 with
  four profiles and the admin rows Sign out is reached by scrolling. A refusal
  repeated word for word is announced by emptying the alert for one frame; in
  a background tab the repeat waits until the tab is shown again; the optional
  name's placeholder is about 3.2:1 while a report is being sent.
- Connect your TV: after a gateway error during a server restart the approval
  never arrived and the code was wiped, so the later "not found" is worded as
  the TV being probably signed in when it is not (the TV says its code
  expired); a quick new lookup that finds the TV still waiting forgets the
  unknown outcome, though a slow approval may still land; the sign-out advice
  needs this browser's own session to be live; "Profiles with a PIN still ask
  for it there" reads the app's profile list, which another device can
  outdate; the page's call site has no app-level test.
- Phone companion and party times: "sent" means the socket took the message;
  the server acknowledges none, so a half-open connection can lose one.
  "Starts …" becomes "Was planned for …" only when the page next draws, so a
  page left open across the planned time can keep "Starts" for a few minutes.
  The lobby card says "Starting…" for as long as a planned start is overdue,
  also while the server is waiting for the host or for guests to be ready
  (older than the redesign; the card is not told why). In the code field, a
  paste of any text holding six letters or numbers replaces a complete code,
  and a bare code pasted at the end of an incomplete one is mixed with it.
- Onboarding: in the recovery a pick that is still allowed can be dropped (one
  made from "More like your picks", or a tie at a page's edge), and the person
  is told how many went; a refusal under a limit set from another device
  meanwhile gets the generic retry; a build that timed out and was not
  superseded still sends its picks when its write lands, so "Your picks can
  wait" can be shown after they were saved; a build superseded while its picks
  request is out still warms the rails; back in the details while a first
  write is still out, an age changed to one that sets no limit is refused on
  every Try again once that write lands (Skip works; older than the redesign).
- Error screen and the bug report form: a capture ("Capture this page") is
  drawn without the app's fonts, so a large heading can wrap onto the text
  under it (older than the redesign, on every page), and from the crash
  screen's panel on a phone the lower part of the picture can be blank; the
  note under the button says so, and a fix is suggested as its own change. "A
  report is sent from that account" does not name the account.
- Signed out, toasts and My Library writes: a My Library write that comes due
  after a switch to a profile with a content limit is refused by the server
  and lost with nothing said (after a switch to a profile without one it is
  taken). The owner checks now move in the switch's own commit, which no test
  can pin (a press or an answer cannot be landed inside that one task in
  jsdom). When a removal and its Undo are both refused, the title comes back
  and "Couldn't put … back" is still said. The read that ends a failed queue
  can drop another title's save that landed in the same moment (not observed;
  the startup read has the same race). Nothing checks the pages' list of the
  server's refusal sentences against the server, so a reworded one falls back
  to the general line. With the player in the window a toast can lie over the
  party's chat ticker for its few seconds. Two frame-timing fixes (the card
  menu and Undo read through layout-effect mirrors) have no deterministic
  test.
- Mini dock and cast card: under 640px with the party rail open the card is
  under the rail, as before. Beside the open rail the toasts and the notice
  end 16px left of it, so at 640px they are 250px wide: a long message wraps
  tall, and a stack of them with the notice can run off the top. With the dock
  up in a short landscape window, the notice and two or three toasts can run
  off the top. The card's height is a fixed figure, so with a minimum font
  size near 17px, or text scaled to about 150%, a toast can meet it (computed,
  not run). The written position leaves the card while the receiver buffers.
  While the picker is open the chat ticker can be drawn over the card. No real
  cast session was rendered.
- Motion: a waiting open is dropped by the app's Back, a destination or Play,
  but not by the browser's own Back, Resume on a card or a profile switch
  inside the one frame before it lands. A poster inside a rail's faded edge
  travels without the fade. The motion audit cannot see a guard that asks the
  wrong way round, an alias, or a later rule that restores an animation. App's
  wiring of the travel has no test (jsdom has no view transitions), and
  Firefox and Safari were not run.
- Failure words: a step back can still be taken twice in the few milliseconds
  between a press on Back and the browser applying it. A request already out
  when a session ends still completes, and a toast it raises is shown to the
  next session on the tab (as before the redesign). The clear of an open
  question in `resetUserState` is not pinned on its own: both of its callers
  also sign the tab out, which runs the signed-out effect, whose clear is
  pinned. The native-box test matches written forms, so it does not see a
  box reached by another route: an alias of `window` or of the function
  (`const w = window`, a destructured name, `.bind`, `(0, alert)`), a
  computed key or `Reflect.get`, a cast whose type has parentheses, a name
  built at run time, or a call hidden behind JSX text that contains `//` (to
  the end of its line) or `/*` (to the next `*/`). That its comment scanner
  blanks no code is checked against TypeScript's own comment ranges over
  today's sources; JSX text holding `//` or `/*` added later fails that
  check. Ask Previously's Retry after the conversation was cleared fails
  each time (it resends a request id the server refused for good); asking
  the question again works. A party socket's error frames are still the
  server's bare strings (they carry no status or reason to word them by).
- Session expiry (older than the redesign): a session that expires signs the
  tab out without the reset an explicit sign-out runs. On an account with
  profiles the profile going away runs the switch's resets; while the app
  knows no profile for the account, only Home's rails, the notification count
  and, now, Tonight's hero and Continue Watching are cleared. What else the
  tab keeps for the previous user on that path (the browse grids and their
  totals, which Tonight's closing line falls back to until its own count
  answers; an open title) was not audited in the redesign.
- Share image (server, older than the redesign, found by reading and not
  reproduced): the server builds a TMDB address from a party's stored poster
  path assuming it starts with a slash, and the web app stores it without one,
  so the share image of a party started from the web app is composed without
  its poster. Server code, so not changed in the redesign.
- Search: a description search cannot tell "nothing found" from "not set up on
  this server" (the server does not say), so the page says either may be the
  case. The results held while the next words are out keep their headings. On
  My requests a denial is recognised by the server's wording. A 4K request for
  a kind whose own 4K downloader is missing can fall back to the ordinary one.
  After a sign-out in one tab, another open tab of the account can write its
  recent list back if a result is opened there before its own sign-out lands.
  When a description search finds no title and a collection matches by its
  words, the collection is shown and nothing says the description search found
  nothing.
- Player: in the party's minimal face, in a window under about 356px high with
  a two-row transport, "Tap for sound" and the voice pill can still meet, and
  a three-line title bar touches the party chip's row at 640px and wider; the
  icon-only "Tap for sound" has a smaller target than the worded one; the lane
  audit takes the timeline's height in a short window as a constant.
- Profiles: deleting a profile can change the colour of a later profile whose
  first-choice colour had been taken (documented and pinned).
- Settings: whether a limit change "loosens" is judged against a list read
  just before the save, so a change made on another device between that read
  and the write is still missed (closing it needs the server to accept the
  limit the client judged against); "already saved from this device" can be
  said when it was another device that set the same limit (wording only;
  nothing is saved either way); `/settings/` with an unknown section shows
  Playback and keeps the address; the profile cap is reported, not prevented.
- Title page: the contrast guarantee is a geometric bound (the text block's
  height under about 0.87 of its width; the audit fails past 0.8, measured on
  the laid-out block, but cannot see an element added to the hero and not to
  its model); over a very pale picture the backing is visible as a soft dark
  oval; at 1024 the text block is most of the window, so only about a third of
  the picture's brightness is kept beside it; Cmd/Ctrl+K does nothing while
  the trailer is open.
