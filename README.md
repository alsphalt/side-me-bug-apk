# DARKNOTE L2

Existing DARKNOTE WhatsApp bot. This release contains surgical feature integrations only.

## Protected command implementation

The requested command implementations are isolated in protected modules with runtime string reconstruction and compact control-flow dispatch. This is JavaScript source protection/obfuscation, not cryptographic secrecy.

## Runtime architecture

- One WhatsApp connection
- Existing `auth` multi-file session
- One `messages.upsert` listener
- Existing central command dispatcher
- Existing Baileys dependency preserved as `npm:levvleys`

## New surgical additions

- `.conver` now shows an in-place processing reaction (`⏳`) and removes it when conversion completes/fails.
- `.ss` saves an accessible quoted WhatsApp Status image/video into the current chat.
- `.sss` silently saves an accessible quoted Status image/video into the paired DARKNOTE account's own private/self chat.
- `.cmdset <command> <alias>` persists aliases in the existing `config.json` settings object and resolves them through the existing dispatcher.
- `.stckcmd <command>` persists sticker fingerprints per paired account and routes matching stickers through the existing dispatcher.
- Sticker triggers never bypass the target command's normal permission checks.
- The existing single `messages.upsert` pipeline remains the only message event entry point.

## AI chat with memory (`lib/ai-chat.js`)

- `.ai <message>` — chat with the AI. Memory is kept per session.
- `.ai` as a reply to any message — the quoted text becomes the prompt.
- `.aireset` — clear the memory for the current session.
- `.aimem` — show exactly what the bot remembers.

Provider: `https://www.mzazi.shop/api/ai/gpt-5`. The endpoint is **stateless** and
**hard-rejects any prompt longer than 300 characters** (HTTP 400, measured against
both GET and POST). Memory is therefore stored in
`database/ai-sessions.json` and rebuilt into a compact context block on every
turn, capped at 292 characters so the live message always survives the budget.

Sessions are scoped per member per group (`g:<group>:<number>`) and per user in
direct chats (`d:<number>`), so two people in the same group never share a memory.
Facts are extracted only from what the user actually wrote (name, age, location,
work, likes, dislikes, language preference, plus explicit "remember X" notes).

Endpoint, key, timeout and retry count are overridable in `config.json`:

```json
{
  "ai": {
    "enabled": true,
    "endpoint": "https://www.mzazi.shop/api/ai/gpt-5",
    "apikey": "your-key",
    "timeoutMs": 90000,
    "retries": 4
  }
}
```

## Source protection (`npm run protect`)

The sensitive command modules are obfuscated with `javascript-obfuscator` — the
same tooling the project already used for ytdl:

| Readable source | Protected build |
|---|---|
| `lib/block-status.js` | `lib/block-status.protected.js` |
| `lib/shazam.js` | `lib/shazam.protected.js` |
| `lib/ytdl.source.js` | `lib/ytdl.protected.js` |

`BIGBRO.js` loads the protected build through `requireProtected()` and falls back
to the readable source if it is missing. `lib/ytdl.js` is a loader shim, so every
existing `require('./ytdl.js')` automatically gets the protected downloader.

Each build is verified before it is written — the script loads the obfuscated file
and checks its exports match the source, so a broken build can never replace a
good one.

**This is obfuscation, not encryption.** It stops casual reading and copying; it is
not mathematically unrecoverable. If you hand the bot to somebody else and want
the protection to mean anything, don't ship the readable sources — the trade-off
is losing the fallback.

After editing any protected module, run `npm run protect`. Always edit the
readable source, never the `.protected.js` file. Add a module by appending to
`TARGETS` in `scripts/protect.js`.

## Shazam (`lib/shazam.js`)

Two ways in:

- `.shazam` — **reply to (or attach) an audio or video**. ACRCloud identifies the
  track, then up to 5 unique YouTube results appear as horizontally swipable cards.
- `.shazam <name>` — **search by name**, e.g. `.shazam Burna Boy Last Last`.
  No media and no ACRCloud call.

Cards carry `🎧 AUDIO` and `🎬 VIDEO`. VIDEO downloads and sends the video
straight away. AUDIO first **asks how to send it**:

- `🎵 AUDIO SONG` — a playable audio message
- `📁 FILE SONG` — a downloadable MP3 document

Only the option you pick is downloaded and sent.

Credentials are read **only** from the environment — never from source:

```bash
cp .env.example .env       # then fill in your own keys
ACRCLOUD_HOST=identify-ap-southeast-1.acrcloud.com
ACRCLOUD_ACCESS_KEY=...
ACRCLOUD_ACCESS_SECRET=...
```

Rotate any key that has been shared in a chat or in public.

Downloads reuse the project's existing multi-provider downloader (`lib/ytdl.js`),
so no competing `ytdl-core` code path is added. Buttons carry only
`shazam_<audio|video>_<resultIndex>_<sessionId>` — not a YouTube URL — and are
dispatched through the existing button handler. Card sessions expire after 10
minutes. Temporary files under `tmp/` are always deleted, on success and failure.

```json
{ "shazam": { "results": 5, "maxVideoBytes": 67108864 } }
```

`results` is how many cards to show (1-5); `maxVideoBytes` bounds the video
download. Both are re-read on use, so an edit applies without a restart, and both
are shown in the `.shazam` usage text.

An oversized video returns a clear message pointing at the AUDIO button.

## Instagram stalk (`lib/instagram.js`)

`.igstalk <username>` (alias `.ig`) sends the profile picture with the profile
information as its caption. A leading `@` is accepted; a URL is refused.

> **The default API is dead.** `aemt.me` no longer resolves at all (NXDOMAIN), so
> the command returns `❌ Instagram user information could not be retrieved.`
> until you point it at a working provider. Instagram's own endpoint requires a
> logged-in session (`401 require_login`).

Point it anywhere with `config.json`:

```json
{
  "instagram": {
    "endpoint": "https://your-provider.example/ig?username={username}",
    "timeoutMs": 20000
  }
}
```

The literal `{username}` is replaced with the encoded username; without a
placeholder, `?username=` (or `&username=`) is appended. Several common response
shapes are understood, so most providers work unchanged. A missing or unsendable
profile picture falls back to a plain text message.

## Blocking

`.block` / `.unblock` accept a replied message, a mention (`@number`) or a bare
number, are owner-only, and verify the result against WhatsApp's real blocklist
before reporting success.

Numbers that can never be blocked are configured — never hard-coded:

```json
{ "protectedBlockJids": ["2547XXXXXXXX"] }
```

The bot's own number and `config.ownerNumber` are always protected. Targets are
resolved by LID (which is what the blocklist RPC requires); a number's LID is
looked up through the session, group metadata, and WhatsApp's `onWhatsApp()`. The
result is read back with `fetchBlocklist()`, so no separate local block store is
kept — WhatsApp's blocklist is the single source of truth.

## Ownership

The number the bot is paired to is **always** the owner and creator, regardless of
`config.ownerNumber`. Re-linking to a different number transfers ownership
automatically. Additional owners are stored per session in `database/owner.json`
and managed with `.addowner` / `.delowner`.

## Owner configuration (`lib/config-commands.js`)

- `.setprefix <symbol>` — owner only. Changes the command prefix (max 3 characters,
  no spaces; `$` and `]` are rejected because the dispatcher reserves them for the
  shell and eval shortcuts). Persisted to `config.json` and applied immediately,
  no restart needed.
- `.setgcpp` — sets the current group's photo. Group only. Reply to an image, or
  send an image with `setgcpp` as the caption. Requires group-admin (or owner)
  permission and DARKNOTE must itself be a group admin. The image is normalised to
  a 640x640 JPEG before upload and the temp file is always cleaned up.

## Interactive member cards (`lib/cards.js`)

Member lists render as horizontally swipable carousels of **exactly 15 real
members per card**, each labelled with its position (`CARD 2/3`, `Members 16–30 of 31`).
Members are never duplicated between cards, never truncated, and never invented to
fill a card. Applies to `tagall`, `listonline`, `listactive`, `listinactive`,
`groupadmins` and `admin`.

`lib/cards.js` also fixes the `Cannot read properties of undefined (reading 'create')`
crash: it prefers the generated protobuf `.create()` helper when the installed
Baileys build exposes it and falls back to plain object literals when it does not.
If a build cannot relay a carousel at all, the same content is sent as paginated
text pages that still carry the real `mentions` array.

Each card also carries a **media header** taken from
`config.json -> "cards": { "image": "./src/img/menu.jpg" }` (a carousel card with
no media is not rendered as a real card). The picture is downscaled to 600x600
JPEG, uploaded once, and cached against the file's path/mtime/size, so a whole
carousel and every later send reuse that single upload. Relative paths resolve
against the project root, not the shell's working directory. Set the value to
`false` or `""` for text-only cards; any image failure is logged and the command
still sends.

Delivery mode is owner-selectable:

```json
{ "cards": { "mode": "auto", "image": "./src/img/menu.jpg" } }
```

`auto` tries the carousel and falls back to text, `carousel` only uses cards,
`text` forces the guaranteed-mention text pages (and never triggers an
"update WhatsApp" placeholder, because no interactive message is sent).

`cmdset` accepts the new `.ss`, `.sss`, `.cmdset`, and `.stckcmd` commands as well as existing/protected commands. The native `.ss` Status Save behavior keeps priority when `.ss` is used as a reply to an accessible Status, allowing the documented `.cmdset vv ss` fallback behavior without replacing the native Status Save command.
