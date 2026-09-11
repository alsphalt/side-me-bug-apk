# DARKNOTE L2 Surgical Integration

- Added `.add` with phone-number normalization, real group add, and private group-invite fallback for WhatsApp privacy restrictions.
- Restored `.tagall` as a 12-member-per-card horizontal carousel with real mention metadata and the existing DARKNOTE card image.
- Removed the automatic startup/reconnect profile-picture updater. Profile-picture changes now occur only through the explicit `.pp` command.
- Hardened `.block`/`.unblock` target resolution with WhatsApp account resolution and blocklist verification while retaining the existing authenticated connection.
- Added protected command modules for `.pp`, `.antilink`, `.anticall`, `.promote`, `.demote`, `.vv`, and `.vv2`.
- Added `.conver` for automatic static-sticker-to-image and animated-sticker-to-video conversion.
- Preserved the existing Baileys implementation, auth/session, single WhatsApp connection, and single `messages.upsert` listener.


## Surgical additions in this release
- Added conversion processing reaction lifecycle to protected `.conver`.
- Added `.ss` Status Save and silent `.sss` paired-account Status Save using only media available in the quoted message.
- Added persistent `.cmdset` alias resolution through the existing command dispatcher; aliases work with protected commands without exposing or copying their implementations.
- Added persistent per-session `.stckcmd` sticker fingerprints with runtime alias resolution and normal command permissions.
- Preserved one WhatsApp connection, one auth/session system, one `messages.upsert`, and the existing Baileys dependency (`npm:levvleys`).

## Latest surgical fixes
- Protected the existing `.ss` / `.sss` status implementation using runtime hexadecimal string reconstruction and compact state dispatch; command registration/API remains unchanged.
- Removed the LID resolver's blind `sendPresenceUpdate()` call. Presence is now lifecycle-gated by the single existing socket and suppressed during close/reconnect races.
- Hardened `.block`: bare DM targets the current private chat; group usage without a target never guesses; WhatsApp blocklist verification is performed when supported.
- Centralized owner authorization through the existing `database/owner.json` store. Added owners are recognized by the existing authorization checks, including SELF mode; primary creator cannot be removed.
- Hardened animated sticker conversion FFmpeg discovery to prefer an installed `ffmpeg-static` binary, then `FFMPEG_PATH`, then system `ffmpeg`, with real internal diagnostics.
- Existing `ffmpeg-static`, `sharp`, and protobufjs install-script allowances remain explicitly present; no Baileys/package upgrade was introduced.

## Master surgical integration — 2026-09-10
- Added session-scoped persistent Antidelete / Antidelete2 / Antidelete3 settings using existing `config.json` storage.
- Integrated message retention into the existing single `messages.upsert` pipeline; no second upsert listener was added.
- Added deletion/update handling through the existing socket event system with duplicate-event suppression.
- Antidelete retains only content actually received by the current DARKNOTE session; view-once media is unwrapped and retained as normal media when a mode is enabled.
- Added owner-session isolation while preserving `database/owner.json`; legacy flat owner storage is migrated to the primary session.
- Added session-scoped command aliases; sticker triggers remain session-scoped and resolve aliases through the same dispatcher.
- Added `antidelete on|off`, `antidelete2 on|off`, and `antidelete3 <number|off>` to the command menu.
- Expanded `allmenu` with the complete registered command list so newly registered commands are visible.
- No Baileys upgrade, replacement, second socket, second `messages.upsert`, or duplicate command dispatcher was introduced.

## AI chat + interactive card repair — 2026-09-11
- Added `.ai` / `.ask` (chat with persistent session memory), `.aireset` and `.aimem`, backed by the new `lib/ai-chat.js`. Provider: `https://www.mzazi.shop/api/ai/gpt-5`.
- The provider hard-rejects any prompt above 300 characters (measured: HTTP 400 on GET and POST, for both `prompt` and `message` parameter names). Memory is therefore a budgeted context block rebuilt from `database/ai-sessions.json`, not a replayed transcript. The builder enforces a 292 character budget and always gives the live message priority.
- Session memory is keyed per member per group (`g:<group>:<number>`) and per user in DMs (`d:<number>`), persists across restarts, keeps the last 8 turns, and extracts only verifiable facts (name, age, location, work, likes, dislikes, language preference and explicit "remember X" notes). No fact is ever invented.
- Added retry/backoff for the provider's intermittent `PROVIDER_TIMEOUT` / `PROVIDER_ERROR` responses, a per-session in-flight lock against duplicate handling, corrupt-store recovery, and 30-day / 800-session bounds.
- Fixed `TypeError: Cannot read properties of undefined (reading 'create')`: added `lib/cards.js`, which prefers the protobuf `.create()` helper when the installed Baileys build exposes it and falls back to plain object literals when it does not. The song carousel, YouTube video carousel and channel button now route through the same compatibility layer.
- Member lists now paginate into horizontal carousels of exactly 15 real members per card, labelled `CARD i/N` and `Members a–b of N`, with no duplicated members, no truncation and no invented filler.
- Wired `.tagall`, `.listonline`, `.listactive`, `.listinactive`, `.groupadmins` and `.admin` to the paginated card layer. When a build cannot relay a carousel at all, the same content is delivered as paginated text pages that still carry the real `mentions` array.
- Card delivery is owner-selectable with `config.json -> "cards": { "mode": "auto" | "carousel" | "text" }`.
- Fixed a literal `\n\n` in the `.block` / `.unblock` usage text, made `.public` / `.self` write `config.json` relative to the module instead of the process working directory, and made the `.menu` ping robust when Baileys returns a protobuf Long timestamp.
- Unchanged: one WhatsApp connection, the existing `auth` session, one `messages.upsert` listener, one command dispatcher and the existing `npm:levvleys` dependency. No Baileys upgrade was required.

## Owner configuration commands — 2026-09-11
- Added `.setprefix <symbol>` (owner only) and `.setgcpp` (group admins or the owner), backed by the new `lib/config-commands.js`.
- `.setprefix` validates the input (no spaces, maximum 3 characters, `$` and `]` rejected because they collide with the dispatcher's built-in shell/eval shortcuts), persists it to `config.json` atomically and applies it immediately without a restart, since every module shares the same `config` object. Alphanumeric prefixes are accepted but the reply warns that they turn ordinary chat into commands.
- `.setgcpp` sets the current group's photo. It requires a group context, an image (replied to, or attached with the command as its caption, including wrapped view-once/ephemeral images), the sender to be a group admin or the bot owner, and DARKNOTE itself to be a group admin. The image is normalised to a 640x640 JPEG through `sharp`, uploaded with `updateProfilePicture`, and the temporary file is always removed. WhatsApp's own rejection reason is surfaced to the user and logged.
- Both commands appear in the `OWNER / MANAGEMENT` section of `allmenu` and are picked up automatically by the `.cmdset` registry scan.

## Owner is the paired number — 2026-09-11
- The linked (paired) number is now always the bot owner, without editing `config.json`. `isOwner()` and `isPrimaryCreator()` treat `conn.user.id` as the creator, in addition to `config.ownerNumber` and the stored owner list, so re-linking the bot to a different number transfers ownership automatically.
- **Latent bug fixed:** `owner-system.js` read `m.__darknoteConn` but nothing in the codebase ever assigned it, so the per-session owner store silently keyed on the literal string `"unpaired"`. `BIGBRO.js` now attaches the connection at the dispatcher entry, and legacy `"unpaired"` entries are folded into the real session key on first read so previously added owners are not lost.
- **Second latent bug fixed:** a JID is `254107287140:5@s.whatsapp.net` and `normalizeNumber()` kept the `:5` device suffix. That suffix changes on every re-link, which would both hide the bot's own number from the "cannot add yourself" guard and orphan the owner store after a re-pair. Device ids are now stripped.
- `.owner` / `.cekowner` report the actual creator (the paired number) instead of the static config value.

## Shazam — 2026-09-11
- Added `.shazam` with 5-result horizontal cards carrying `🎧 AUDIO` and `🎬 VIDEO` buttons, backed by the new `lib/shazam.js`. It identifies the replied/attached audio or video with ACRCloud, then searches YouTube with a clean `title - artists` query.
- **Credentials are read only from the environment** (`ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET`) with a dependency-free `.env` reader, so the keys never live in source. `.env.example` is provided and `.gitignore` excludes `.env` and `auth/`. The keys previously pasted into chat were confirmed still live and must be rotated.
- **Reuses the existing downloader.** `lib/ytdl.js` already ships a four-provider YouTube downloader plus two direct paths, so shazam calls `ytdlAutoBuffer` (audio) and `ytdlAutoVideoFile` (video) instead of adding a competing `ytdl-core` implementation. No exact-bitrate filter is used.
- Buttons carry only `shazam_<audio|video>_<resultIndex>_<sessionId>` — never a YouTube URL. They are dispatched through the **existing** button path (the same one `ytvideo_select_` uses); no second listener or dispatcher was added. Sessions live in memory with a 10-minute TTL, a self-clearing interval that is `unref()`ed, so nothing is left running.
- Each card uses its own YouTube thumbnail; a failed thumbnail falls back to the configured card image so a card is never dropped, which would otherwise shift the buttons onto the wrong result.
- Unique temp files under `tmp/` (`shazam-audio-<id>.mp3`, `shazam-video-<id>.mp4`) are always removed in `finally`, including on download, send, size-guard and expiry failures. An oversized video reports a clear message pointing at AUDIO.
- `config.json -> "shazam": { "maxVideoBytes": 67108864 }` bounds the video download; it is re-read on each use so an edit applies without a restart.
- Dependency added: `acrcloud@^1.4.0` (`yt-search` and `ytdl-core` were already declared). Verified against the published package that `new acrcloud({host, access_key, access_secret})` and `identify(buffer)` are the real API.
- **Known limitation:** on a Baileys build that exposes no `InteractiveMessage` at all, cards cannot be rendered, so the five results are delivered as a numbered text list and the AUDIO/VIDEO buttons are unavailable. The installed `levvleys` build does expose them, so this only affects such a build.

## Shazam: search by name, audio sub-choice, live-fix round — 2026-09-11
- **`.shazam <name>`** now searches YouTube directly, with no media and no ACRCloud call. Typed text takes priority over a replied clip; `.shazam` with neither shows usage documenting both forms.
- **AUDIO now asks before downloading.** Pressing 🎧 AUDIO shows a second choice — `🎵 AUDIO SONG` (a playable audio message) or `📁 FILE SONG` (an MP3 document). Only the chosen form is downloaded and sent. Ids are `shazam_play_<n>_<sid>` and `shazam_file_<n>_<sid>`; the pre-dispatch mapping accepts `audio|play|file|video`, all still routed through the one existing button dispatcher.
- **`config.json -> "shazam"`** now carries `results` (how many cards, 1-5) and `maxVideoBytes`, both re-read on use and both shown in the usage text.
- **Fixed: a rejected progress message aborted the whole command.** WhatsApp intermittently answers a send with `not-acceptable` — in the stack this was `assertSessions` failing inside `assertNodeErrorFree`, reached from `m.bigboreply` inside `handleShazam`. Because the flow awaited that reply, the command died with `[SHAZAM] Fatal error: Error: not-acceptable` *and* the error reply failed too. `safeReply()` now wraps every user-facing message inside shazam, so a dropped notification is logged and the real work continues.
- **Fixed: `.block <bare number>` could not be resolved and fell back to the rejectable phone-number-only form** (`[BLOCK] attempt 1/1 with {"action":"block","jid":"<pn>"} failed: bad-request (server code 400)`). The installed build implements `onWhatsApp()` as a USync query that includes the LID protocol and returns `{ jid, exists, lid }`, so `lib/block-status.js` now asks WhatsApp for the LID when the session has no local mapping. A bare number now sends the upstream-correct `<item action="block" jid="<lid>" pn_jid="<pn>"/>` in a single request.
- Live confirmation from the running bot: ACRCloud identified real tracks and the 5-result carousel sent successfully, e.g. `[SHAZAM] Nikurira Ndirarira -> session 86a9d17e36467136 -> 5 results (CAROUSEL)`. Full song identification and the carousel are therefore confirmed working end-to-end, not just in tests.

## Block hardening + Instagram stalk — 2026-09-11

### Block
- Added a **configurable protected-number guard**. `config.json -> "protectedBlockJids"` (a string or an array, numbers or JIDs) is checked before any request is sent; the bot's own number and `config.ownerNumber` are always included. Nothing is hard-coded in the command. A protected target is refused with `No, 🙂‍↕🙂‍↔` and logged.
- **Fixed: a LID target whose phone number could not be mapped was rejected outright.** The live bot logged `[BLOCK] Target resolution error: Error: Unable to resolve the target WhatsApp account`, because the code demanded a `@s.whatsapp.net` target and threw when `resolveLidEnhanced()` could not map a LID. A LID is exactly what the blocklist RPC wants, so the guard now accepts `@s.whatsapp.net` **or** `@lid`, and the PN lookup became a best-effort bonus rather than a requirement.
- The `onWhatsApp()` follow-up lookup now only runs for a phone-number target, so it can no longer overwrite a LID target with an unrelated JID.
- The guard now reads `config.json` from disk (`liveConfig()`), so an edit to `protectedBlockJids` applies immediately instead of using the load-time snapshot.
- **Verified live against real WhatsApp** (not just in tests) by running the block through the connected session for `254798608399`:
  - `onWhatsApp` returned `{"jid":"254798608399@s.whatsapp.net","exists":true,"lid":"168865615106296@lid"}`
  - `resolveIdentity` produced both identities, so the first request was `<item action="block" jid="168865615106296@lid" pn_jid="254798608399@s.whatsapp.net"/>`
  - block applied on **attempt 1**, and `fetchBlocklist()` then returned `["168865615106296@lid"]` — the block is real on the account
  - unblock applied on attempt 1 and the blocklist returned to `[]`, leaving the account exactly as it was
- Deliberately **not** added: a second blocked-user store. WhatsApp's own blocklist is the source of truth and is read back with `fetchBlocklist()`; a duplicate local list would be the "duplicate block system" the brief warns against. Nothing else is needed for "access to bot commands is restricted" either — a blocked user cannot deliver messages to the bot at all.

### Instagram
- Added `.igstalk <username>` (alias `.ig`), backed by the new `lib/instagram.js`. Usage is shown when no username is given; `@name` is accepted and the `@` stripped; URLs are refused rather than scraped.
- Uses the specified endpoint as the default (`https://aemt.me/download/igstalk?username={username}`) with `encodeURIComponent` on the user input, and is overridable with `config.json -> "instagram": { "endpoint": ... }`. The `{username}` placeholder is substituted, otherwise `?username=` / `&username=` is appended, so any provider shape can be dropped in.
- Parses several common response shapes (`result.user_info`, `result.user`, `data.user`, `user_info`, and Instagram-native `edge_followed_by.count` etc.), so replacing the provider usually needs no code change.
- Every failure is handled and reported cleanly with the real reason logged: missing fetch, network failure, timeout (20s default), HTTP error, non-JSON body, missing `user_info`. A missing or unsendable profile picture falls back to a text message instead of failing.
- **`aemt.me` is dead.** The domain returns NXDOMAIN (`Could not resolve host: aemt.me`) while general outbound HTTPS from the same host works, so the command cannot return live data until the endpoint is pointed at a working provider. Instagram's own `web_profile_info` answers `401 {"require_login":true}` without a logged-in session. See the README for the config line.
- Progress messages are wrapped (same pattern as shazam) so a rejected send cannot abort the lookup.
- No dependency added: native `fetch` is used.

## Source protection for block, shazam and ytdl — 2026-09-11
- Added `scripts/protect.js` and `npm run protect`, using the project's existing `javascript-obfuscator` devDependency (the same tooling `scripts/protect-downloader.js` already used for ytdl). It produces:
  - `lib/block-status.protected.js` — block / unblock protocol
  - `lib/shazam.protected.js` — shazam
  - `lib/ytdl.protected.js` — YouTube downloader
- The pipeline **verifies each build before writing it**: it loads the obfuscated file and asserts its export names match the readable source exactly, so a broken build can never overwrite a good one. Current results: 11 / 25 / 11 exports matched.
- `BIGBRO.js` loads these through a `requireProtected()` helper, and `lib/ytdl.js` became a loader shim (the implementation now lives in `lib/ytdl.source.js`). That is deliberate: BIGBRO and the *protected* shazam both `require('./ytdl.js')`, so routing through the shim means the protected downloader is used everywhere **without changing a single consumer**.
- Every loader falls back to the readable source when a protected build is absent, and logs loudly if one exists but fails to load — a missing file is normal, a broken file is not silent.
- Verified, not assumed: the shim really loads the obfuscated build (`ytdlAutoBuffer` source contains obfuscated identifiers), the fallback really works when the protected file is moved away, and the whole suite passes against the protected code — **179/179, 179/179, 168/168**.
- Plain-text hints eliminated from the protected builds: `blocklist` → 0, full env var names → 0, and the button-id prefix → 0. The prefix needed a source change because a **regex literal and a template string cannot be moved into an obfuscator's string array**; shazam now assembles the id root at runtime.
- **No credential value appears in any protected build** (checked for both leaked keys: 0 matches).
- HONEST SCOPE — this is **obfuscation, not cryptographic encryption**. It stops casual reading, copying and grep-ing for protocol details; it is not mathematically unrecoverable. To make it meaningful when handing the bot to somebody else, do not ship the readable sources (`block-status.js`, `shazam.js`, `ytdl.source.js`) — the trade-off is that the automatic fallback then has nothing to fall back to.
- Workflow note: always edit the readable source and re-run `npm run protect`. Never edit a `.protected.js` file, it will be overwritten.
- Not protected: `lib/instagram.js` (it was not in scope). Add `{ source: 'instagram', output: 'instagram' }` to `TARGETS` in `scripts/protect.js` to include it.
- One test-harness artefact worth recording: loading the readable source in a *test* while the dispatcher loads the protected build creates two module instances with separate session maps. Production never does this — all three shazam call sites use the same loader — but any harness must use `requireProtected` for the same module or session lookups will miss.

## Custom pairing code — 2026-09-11
- `index.js` now passes a custom pairing code to `requestPairingCode()` as its second argument. The installed levvleys fork accepts `requestPairingCode(phoneNumber, pairKey)` and this companion asserts the code during the `link_code_companion_reg` handshake, so the code printed by the bot is the one the phone must be given. The previous comment claiming a custom code was impossible was wrong for this fork and has been corrected.
- The code is configurable with `config.json -> "pairingCode"` and defaults to `DARKNOTE`. It is normalised to 8 uppercase characters because that is what the phone's entry field accepts.
- Verified live: the bot prints `🔐 DARKNOTE PAIRING CODE: DARKNOTE` and waits for the phone to enter it.

## Block / unblock repair — 2026-09-11
- **Root cause of `[BLOCK] Error: Error: bad-request`**: WhatsApp migrated accounts to LID addressing and the blocklist RPC now requires the target's LID, plus its phone-number JID when blocking:
  - `block`   -> `<item action="block" jid="<lid>" pn_jid="<pn>"/>`
  - `unblock` -> `<item action="unblock" jid="<lid>"/>`

  The installed Baileys build (`levvleys` v2.0.22) still sends the phone-number JID alone, so WhatsApp answers with an error node that Baileys surfaces as `bad-request`. Upstream Baileys resolves the LID via `signalRepository.lidMapping` before sending; this fork has no such repository.
- Added `lib/block-status.js`, which issues the correctly-shaped `blocklist` IQ directly through `conn.query` (exposed by the build) and takes the LID only from state the session already holds: the contact directory, the `conn.lidToJidMap` maintained by `lib/msg.js`, and group metadata participants. No LID is ever invented.
- The command now tries the upstream-correct form first and falls back to the legacy forms, logging every attempt with the server's numeric error code. Ten distinct outcomes are surfaced instead of a blanket failure, and the target is never reported as blocked unless `fetchBlocklist` confirms it.
- The pre-check (`already blocked` / `not blocked`) and the post-verification both accept either the LID form or the phone-number form, because the server may key the blocklist entry by either.
- Kept: the owner-only gate, the group-JID rejection, the self/sender guard (now also compared against the account's own LID), and the sanitised error output.
- Note: the LID cannot always be discovered from a bare phone number. Replying to one of the contact's messages, or mentioning them in a group, supplies the LID directly and is the reliable route; the command now says so when it has to fall back.

## Card images — 2026-09-11
- Member-list cards now carry a **media header**. A WhatsApp carousel card without media is not rendered as a real card (the client falls back to an "update WhatsApp" style placeholder), so each card header is now built with `hasMediaAttachment: true` and an `imageMessage`.
- The image is `config.json -> "cards": { "image": "./src/img/menu.jpg" }`. Relative paths resolve against the project root rather than the shell's working directory. Setting it to `false` or `""` renders text-only cards.
- The picture is downscaled to 600x600 JPEG, uploaded **once** through `prepareWAMessageMedia` with `conn.waUploadToServer`, and the prepared `imageMessage` is cached against the file's path/mtime/size so repeat sends (and all 15-member cards of one carousel) reuse the same upload instead of re-uploading.
- Every image failure path degrades safely and is logged with the real reason: unreadable file, no `waUploadToServer` on the build, no `prepareWAMessageMedia` export, or a rejected upload. The command still sends; it just sends cards without a picture.
- `cards.mode: "text"` remains the option that avoids interactive messages entirely if a client still refuses to render cards.
- Also fixed: the `allmenu` thumbnail was read from `./src/img/menu.jpg` relative to the working directory; it now resolves against the project root, so the bot no longer breaks on every command when started from another directory.
