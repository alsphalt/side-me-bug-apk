'use strict'

/*
 * DARKNOTE L2 LICENSE
 * .shazam — identify a song from a replied audio/video, then offer 5 YouTube
 * results as swipeable cards with AUDIO / VIDEO buttons.
 * © DARKNOTE L2 • Bigbrother
 *
 * CREDENTIALS
 * ACRCloud keys are read ONLY from the environment:
 *   ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET
 * A tiny dependency-free .env reader is included so the owner can keep the keys
 * in a file that is not source code. Keys are never logged and never sent to
 * WhatsApp. Any key that has been pasted into a chat must be treated as
 * compromised and rotated.
 *
 * DOWNLOADS
 * The project already ships a multi-provider YouTube downloader in lib/ytdl.js
 * (four providers plus two direct paths), so this module reuses it instead of
 * adding a competing ytdl-core implementation.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { ytdlAutoBuffer, ytdlAutoVideoFile, extractYouTubeId } = require('./ytdl.js')

const SESSION_TTL_MS = 10 * 60 * 1000
const MAX_MEDIA_BYTES = 15 * 1024 * 1024
const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_VIDEO_BYTES = 64 * 1024 * 1024
const MAX_RESULTS = 5
const TMP_DIR = path.join(__dirname, '..', 'tmp')
const REQUEST_TIMEOUT_MS = 60000

/* ------------------------------ credentials ------------------------------ */

let envLoaded = false

/** Minimal .env reader: KEY=VALUE, # comments, no expansion, never overrides. */
function loadDotEnv() {
    if (envLoaded) return
    envLoaded = true
    try {
        const file = path.join(__dirname, '..', '.env')
        if (!fs.existsSync(file)) return
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const at = trimmed.indexOf('=')
            if (at < 1) continue
            const key = trimmed.slice(0, at).trim()
            let value = trimmed.slice(at + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
            }
            if (key && !(key in process.env)) process.env[key] = value
        }
    } catch (error) {
        console.error('[SHAZAM] .env could not be read:', error?.message || error)
    }
}

function credentials() {
    loadDotEnv()
    const host = process.env.ACRCLOUD_HOST
    const accessKey = process.env.ACRCLOUD_ACCESS_KEY
    const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET
    return { host, accessKey, accessSecret, ready: Boolean(host && accessKey && accessSecret) }
}

/** Build the ACRCloud client, or explain precisely why it is unavailable. */
function acrClient() {
    const { host, accessKey, accessSecret, ready } = credentials()
    if (!ready) {
        return {
            ok: false,
            code: 'NO_CREDENTIALS',
            reason: 'ACRCloud credentials are missing. Set ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY and ACRCLOUD_ACCESS_SECRET (or add them to .env).'
        }
    }
    let Acrcloud
    try {
        Acrcloud = require('acrcloud')
    } catch (error) {
        return { ok: false, code: 'NO_PACKAGE', reason: `The acrcloud package is not installed: ${error?.message || error}` }
    }
    const Ctor = Acrcloud?.default || Acrcloud
    try {
        return { ok: true, client: new Ctor({ host, access_key: accessKey, access_secret: accessSecret }) }
    } catch (error) {
        return { ok: false, code: 'NO_CLIENT', reason: `The ACRCloud client could not be created: ${error?.message || error}` }
    }
}

/**
 * A SPECIFIC explanation for an unavailable song identifier.
 *
 * "Shazam is not configured correctly on this bot" is not actionable: it does not
 * name the missing piece, so it cannot be fixed without reading the source. The
 * only thing actually absent is the ACRCloud CREDENTIAL - the `acrcloud` package
 * is installed and the client builds correctly - so the exact variable names are
 * named here.
 *
 * The name-search path needs none of this, so it is offered instead of leaving
 * the user at a dead end.
 */
function describeUnavailable(acr, prefix = '.') {
    if (acr?.code === 'NO_CREDENTIALS') {
        return [
            '❌ *Song identification is not switched on for this bot yet.*',
            '',
            '*Missing*: ACRCloud credentials.',
            '• ACRCLOUD_HOST',
            '• ACRCLOUD_ACCESS_KEY',
            '• ACRCLOUD_ACCESS_SECRET',
            '',
            '*What DOES work right now* — search by song name, no credentials needed:',
            `• ${prefix}shazam <song name>`,
            `• for example: ${prefix}shazam ruger`
        ].join('\n')
    }
    return [
        '❌ *Song identification is unavailable.*',
        '',
        `Reason (${acr?.code || 'UNKNOWN'}): ${acr?.reason || 'no reason was reported'}`,
        '',
        `*What DOES work right now*: ${prefix}shazam <song name>`
    ].join('\n')
}

/* -------------------------------- sessions ------------------------------- */

const sessions = new Map()

function createSession(chat, sender, query, results) {
    const sessionId = crypto.randomBytes(8).toString('hex')
    sessions.set(sessionId, {
        chat: String(chat || ''),
        sender: String(sender || ''),
        query,
        results,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS
    })
    return sessionId
}

function getSession(sessionId) {
    const session = sessions.get(String(sessionId || ''))
    if (!session) return null
    if (Date.now() > session.expiresAt) {
        sessions.delete(String(sessionId))
        return null
    }
    return session
}

function cleanExpiredSessions(now = Date.now()) {
    let removed = 0
    for (const [id, session] of sessions) {
        if (now > session.expiresAt) { sessions.delete(id); removed++ }
    }
    return removed
}

// unref() so this timer never keeps the process alive on its own.
const sessionTimer = setInterval(cleanExpiredSessions, 60 * 1000)
if (typeof sessionTimer.unref === 'function') sessionTimer.unref()

/* ------------------------------- utilities ------------------------------- */

function safeFileName(name) {
    return String(name || 'shazam')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'shazam'
}

function tempPath(prefix, extension) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    return path.join(TMP_DIR, `${prefix}-${crypto.randomBytes(8).toString('hex')}${extension}`)
}

/**
 * A progress/notification message must never abort the command.
 * WhatsApp intermittently answers a send with "not-acceptable" (an assertSessions
 * failure), and because the flow awaited that reply the whole command used to die
 * with "[SHAZAM] Fatal error" before it had sent anything. Wrapping the reply
 * means a dropped notification is logged and the real work continues.
 */
function safeReply(reply) {
    if (typeof reply !== 'function') return async () => null
    return async (text) => {
        try {
            return await reply(text)
        } catch (error) {
            console.error('[SHAZAM] message could not be delivered:', error?.message || error)
            return null
        }
    }
}

async function removeQuietly(file) {
    if (!file) return
    try { await fs.promises.rm(file, { force: true }) } catch (error) {
        console.error('[SHAZAM] Temp cleanup failed:', error?.message || error)
    }
}

// The id root is assembled at runtime rather than written as one literal. A
// regex literal and a template string cannot be moved into the obfuscator's
// string array, so writing them whole left the button-id shape readable in the
// protected build; splitting the root keeps it out of the bundle's plain text.
const ID_ROOT = 'sha' + 'zam'

/** 1-based index is what the button carries, so card N always maps to result N. */
function buttonIdFor(kind, index, sessionId) {
    return `${ID_ROOT}_${kind}_${index}_${sessionId}`
}

// audio = open the audio choice menu, play = playable audio message,
// file = MP3 document, video = video.
const SELECTION_RE = new RegExp(`^${ID_ROOT}_(audio|play|file|video)_(\\d+)_([a-z0-9]+)$`, 'i')

function parseButtonId(id) {
    const match = String(id || '').match(SELECTION_RE)
    if (!match) return null
    const index = Number(match[2])
    if (!Number.isInteger(index) || index < 1 || index > MAX_RESULTS) return null
    return { kind: match[1].toLowerCase(), index, sessionId: match[3] }
}

/**
 * Find the replied/quoted audio or video (or the media the command is attached
 * to), and report its type so the caller can reject a non-media message.
 */
function resolveMediaTarget(m) {
    const candidates = []
    if (m?.quoted) candidates.push({ node: m.quoted, source: 'quoted' })
    candidates.push({ node: m, source: 'attached' })

    for (const candidate of candidates) {
        const node = candidate.node
        const mtype = String(node?.mtype || '')
        if (!mtype) continue
        const media = node?.msg || node?.message?.[mtype]
        const mimetype = String(media?.mimetype || node?.mimetype || '')
        const isAudio = mtype === 'audioMessage' || /^audio\//i.test(mimetype)
        const isVideo = mtype === 'videoMessage' || /^video\//i.test(mimetype)
        if (!isAudio && !isVideo) continue
        if (typeof node.download !== 'function') continue
        // Audio documents are accepted too, as long as they look like audio.
        return { node, mtype, mimetype, kind: isVideo ? 'video' : 'audio', source: candidate.source }
    }
    return null
}

function pickCover(thumbnail) {
    if (!thumbnail) return null
    // yt-search returns an array of thumbnails.
    if (Array.isArray(thumbnail)) {
        const best = thumbnail[thumbnail.length - 1]
        return best?.url ? { url: best.url } : null
    }
    if (typeof thumbnail === 'string' && /^https?:\/\//i.test(thumbnail)) return { url: thumbnail }
    if (typeof thumbnail === 'object' && thumbnail.url) return { url: thumbnail.url }
    return null
}

/* ----------------------------- identification ---------------------------- */

function extractSong(music) {
    const artists = Array.isArray(music?.artists)
        ? music.artists.map(artist => artist?.name).filter(Boolean).join(', ')
        : (music?.artists ? String(music.artists) : '')
    const genres = Array.isArray(music?.genres)
        ? music.genres.map(genre => genre?.name).filter(Boolean).join(', ')
        : (music?.genres ? String(music.genres) : '')
    return {
        title: music?.title || 'Unknown',
        artists,
        album: music?.album?.name || '',
        genres,
        releaseDate: music?.release_date || ''
    }
}

function formatIdentification(song) {
    const lines = [
        '╭────────────────────╮',
        '│ *✞* `SHAZAM RESULT`',
        '╰────────────────────╯',
        '',
        `🎵 *Title:* ${song.title}`
    ]
    if (song.artists) lines.push(`👤 *Artist:* ${song.artists}`)
    if (song.album) lines.push(`💿 *Album:* ${song.album}`)
    if (song.genres) lines.push(`🎼 *Genre:* ${song.genres}`)
    if (song.releaseDate) lines.push(`📅 *Release:* ${song.releaseDate}`)
    return lines.join('\n')
}

/** Clean search query: never the whole formatted Shazam reply. */
function buildSearchQuery(song) {
    return [song.title, song.artists].filter(Boolean).join(' - ').trim()
}

async function searchYouTube(query, limit = MAX_RESULTS) {
    const ytSearch = require('yt-search')
    const call = typeof ytSearch === 'function' ? ytSearch : ytSearch?.default
    if (typeof call !== 'function') throw new Error('yt-search is unavailable')

    const searchResult = await call(query)
    const all = Array.isArray(searchResult?.videos) ? searchResult.videos : []
    const picked = []
    const seen = new Set()

    for (const video of all) {
        const url = video?.url || (video?.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : '')
        if (!url || seen.has(url)) continue
        if (!extractYouTubeId(url)) continue
        seen.add(url)
        picked.push({ ...video, url })
        if (picked.length >= limit) break
    }
    return picked
}

/* ------------------------------- downloads ------------------------------- */

/** Audio, via the project's existing multi-provider downloader. */
async function downloadShazamAudio(url, destination) {
    const result = await ytdlAutoBuffer(url, 'audio')
    if (!result?.status || !Buffer.isBuffer(result.buffer) || !result.buffer.length) {
        throw new Error(result?.error || 'The downloader returned no audio data')
    }
    if (result.buffer.length > MAX_AUDIO_BYTES) throw new Error('AUDIO_TOO_LARGE')
    await fs.promises.writeFile(destination, result.buffer)
    return { title: result.title || 'audio', mimetype: 'audio/mpeg', size: result.buffer.length }
}

/** Video, via the project's existing ytdlAutoVideoFile helper. */
async function downloadShazamVideo(url, destination, maxBytes) {
    const result = await ytdlAutoVideoFile(url, destination, '720', maxBytes)
    if (!result?.status) throw new Error(result?.error || 'The video downloader failed')
    const stat = await fs.promises.stat(destination).catch(() => null)
    if (!stat?.size) throw new Error('The downloaded video is empty')
    if (stat.size > maxBytes) throw new Error('VIDEO_TOO_LARGE')
    return { title: result.title || 'video', size: stat.size }
}

/* ------------------------------- card build ------------------------------ */

function buildShazamCards(results, sessionId) {
    return results.map((video, index) => {
        const number = index + 1
        const channel = video.author?.name || video.author || 'YouTube'
        const duration = video.timestamp || 'Unknown'
        return {
            title: `🎵 ${number}. ${video.title || `Result ${number}`}`,
            body: `👤 ${channel}\n⏱ ${duration}`,
            image: pickCover(video.thumbnail),
            buttons: [
                { displayText: '🎧 AUDIO', id: buttonIdFor('audio', number, sessionId) },
                { displayText: '🎬 VIDEO', id: buttonIdFor('video', number, sessionId) }
            ]
        }
    })
}

/* ------------------------------ main command ----------------------------- */

/**
 * .shazam — identify the replied/quoted audio or video and offer 5 results.
 * Never throws: every failure path returns a code and a user-facing message.
 */
/** Usage / help, including the live settings. */
function usageText(prefix = '.') {
    const settings = shazamSettings()
    return [
        '╭────────────────────╮',
        '│ *✞* `SHAZAM`',
        '╰────────────────────╯',
        '',
        'Identify a song, or search one by name:',
        `• ${prefix}shazam — reply to an audio or video`,
        `• ${prefix}shazam <name> — search by name`,
        '',
        `Returns up to ${settings.results} YouTube results as swipeable cards.`,
        'Tap 🎧 AUDIO to pick a playable audio song or an MP3 file,',
        'or 🎬 VIDEO for the video.'
    ].join('\n')
}

/** Open a session and send the result cards (shared by both entry paths). */
async function deliverResults({ conn, m, reply, cards, results, title, query }) {
    const sessionId = createSession(m.chat, m.sender, query, results)
    const cardList = buildShazamCards(results, sessionId)

    const sent = await cards.sendCardCarousel(conn, m, {
        heading: `🎵 *SHAZAM — CHOOSE A RESULT*\n\nFound ${results.length} matching results for *${title}*.\nSwipe the cards and tap 🎧 AUDIO or 🎬 VIDEO.`,
        footer: 'DARKNOTE L2 • Shazam',
        cards: cardList,
        mode: cardsMode(),
        fallbackHint: `Send ${(m.prefix || '.')}shazam again to refresh these results.`,
        failureMessage: '❌ Failed to send the Shazam results.',
        reply
    })

    if (!sent.ok) {
        console.error(`[SHAZAM] results could not be sent: ${sent.code} ${sent.reason || ''}`)
        return { ok: false, code: sent.code }
    }
    console.error(`[SHAZAM] ${title} -> session ${sessionId} -> ${results.length} results (${sent.code})`)
    return { ok: true, code: sent.code, sessionId, results: results.length }
}

async function handleShazam({ conn, m, reply, cards, query }) {
    // A dropped progress message must not abort the whole command.
    reply = safeReply(reply)
    try {
        const prefix = String(m?.prefix || '.')
        const searchText = String(query || '').trim()
        const settings = shazamSettings()

        // ---- Path 1: search by name. Needs no media and no ACRCloud. ----
        if (searchText) {
            if (searchText.length > 120) {
                await reply('❌ That search is too long. Please use a shorter song name.')
                return { ok: false, code: 'QUERY_TOO_LONG' }
            }
            await reply(`🔎 Searching YouTube for *${searchText}*...`)

            let results
            try {
                results = await searchYouTube(searchText, settings.results)
            } catch (error) {
                console.error('[SHAZAM] YouTube search failed:', error?.stack || error)
                await reply('❌ The YouTube search failed. Please try again.')
                return { ok: false, code: 'SEARCH_FAILED', query: searchText }
            }
            if (!results.length) {
                await reply(`❌ No YouTube results found for *${searchText}*.`)
                return { ok: false, code: 'NO_RESULTS', query: searchText }
            }

            const outcome = await deliverResults({ conn, m, reply, cards, results, title: searchText, query: searchText })
            return { ...outcome, query: searchText }
        }

        // ---- Path 2: identify the replied / attached media. ----
        const target = resolveMediaTarget(m)
        if (!target) {
            await reply(usageText(prefix))
            return { ok: false, code: 'NO_MEDIA' }
        }

        const acr = acrClient()
        if (!acr.ok) {
            console.error(`[SHAZAM] ${acr.code}: ${acr.reason}`)
            // Names the exact missing piece and the path that still works,
            // rather than a generic "not configured" line.
            await reply(describeUnavailable(acr, prefix))
            return { ok: false, code: acr.code }
        }

        await reply('🔎 Identifying the song...')

        let buffer
        try {
            buffer = await target.node.download()
        } catch (error) {
            console.error('[SHAZAM] Media download failed:', error?.stack || error)
            await reply('❌ The media file could not be downloaded.')
            return { ok: false, code: 'MEDIA_DOWNLOAD_FAILED' }
        }
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
            await reply('❌ The media file could not be downloaded.')
            return { ok: false, code: 'MEDIA_EMPTY' }
        }
        if (buffer.length > MAX_MEDIA_BYTES) {
            await reply('❌ The media file is too large.\nPlease use a smaller audio/video clip.')
            return { ok: false, code: 'MEDIA_TOO_LARGE' }
        }

        let result
        try {
            result = await acr.client.identify(buffer)
        } catch (error) {
            console.error('[SHAZAM] ACRCloud request failed:', error?.stack || error)
            await reply('❌ Song identification failed. Please try again.')
            return { ok: false, code: 'ACRCLOUD_ERROR' }
        }

        const status = result?.status
        const music = result?.metadata?.music?.[0]
        if (!status || status.code !== 0 || !music) {
            console.error(`[SHAZAM] Not identified: ${status?.code ?? 'no status'} ${status?.msg || ''}`)
            await reply("❌ I couldn't identify this audio.\nTry a clearer or longer clip.")
            return { ok: false, code: 'NOT_IDENTIFIED', acrStatus: status?.code }
        }

        const song = extractSong(music)
        const searchQuery = buildSearchQuery(song)
        await reply(`${formatIdentification(song)}\n\n⏳ Searching YouTube for ${settings.results} results...`)

        let results
        try {
            results = await searchYouTube(searchQuery, settings.results)
        } catch (error) {
            console.error('[SHAZAM] YouTube search failed:', error?.stack || error)
            await reply('❌ I identified the song, but the YouTube search failed.')
            return { ok: false, code: 'SEARCH_FAILED', song }
        }
        if (!results.length) {
            await reply(`❌ I identified *${song.title}*, but couldn't find matching YouTube results.`)
            return { ok: false, code: 'NO_RESULTS', song }
        }

        const outcome = await deliverResults({ conn, m, reply, cards, results, title: song.title, query: searchQuery })
        return { ...outcome, song }
    } catch (error) {
        console.error('[SHAZAM] Fatal error:', error?.stack || error)
        try { await reply('❌ An error occurred while processing Shazam.\nPlease try again.') } catch (reportError) {
            console.error('[SHAZAM] Could not report the error:', reportError?.message || reportError)
        }
        return { ok: false, code: 'FATAL', reason: error?.message || String(error) }
    }
}

/* ----------------------------- button handling --------------------------- */

function cardsMode() {
    try {
        delete require.cache[require.resolve(path.join(__dirname, '..', 'config.json'))]
        const config = require(path.join(__dirname, '..', 'config.json'))
        const mode = String(config?.cards?.mode || 'auto').toLowerCase()
        return ['auto', 'text', 'carousel'].includes(mode) ? mode : 'auto'
    } catch { return 'auto' }
}

/** Live settings from config.json -> "shazam". Re-read so edits apply at once. */
function shazamSettings() {
    const configPath = path.join(__dirname, '..', 'config.json')
    let config = {}
    try {
        delete require.cache[require.resolve(configPath)]
        config = require(configPath) || {}
    } catch (error) {
        console.error('[SHAZAM] config read failed, using defaults:', error?.message || error)
    }
    const maxVideo = Number(config?.shazam?.maxVideoBytes)
    const results = Number(config?.shazam?.results)
    return {
        maxVideoBytes: Number.isFinite(maxVideo) && maxVideo > 0 ? maxVideo : DEFAULT_MAX_VIDEO_BYTES,
        results: Number.isFinite(results) && results >= 1 ? Math.min(MAX_RESULTS, Math.floor(results)) : MAX_RESULTS
    }
}
function maxVideoBytes() { return shazamSettings().maxVideoBytes }

/** Resolve a button's session + result, or explain why it cannot be used. */
function resolveSelection(sessionId, index) {
    const session = getSession(sessionId)
    if (!session) return { error: 'SESSION_EXPIRED' }
    const video = session.results[index - 1]
    if (!video?.url || !extractYouTubeId(video.url)) return { error: 'INVALID_RESULT' }
    return { session, video }
}

/**
 * Pressing AUDIO first asks how the song should be sent:
 *   play -> a playable audio message
 *   file -> a downloadable MP3 document
 * Nothing is downloaded until one of the two is chosen.
 */
async function handleAudioChoiceMenu({ conn, m, reply, cards, index, sessionId }) {
    reply = safeReply(reply)
    const { video, error } = resolveSelection(sessionId, index)
    if (error === 'SESSION_EXPIRED') {
        await reply('❌ This Shazam result has expired. Run `.shazam` again.')
        return { ok: false, code: error }
    }
    if (error) {
        console.error(`[SHAZAM] Invalid result ${index} in session ${sessionId}`)
        await reply('❌ That result is not available any more. Run `.shazam` again.')
        return { ok: false, code: error }
    }

    const label = safeFileName(video.title)
    const shown = await cards.sendChoiceButtons(conn, m, {
        heading: `🎧 *AUDIO — ${label}*\n\nHow should I send this song?`,
        footer: 'DARKNOTE L2 • Shazam',
        buttons: [
            { displayText: '🎵 AUDIO SONG', id: buttonIdFor('play', index, sessionId) },
            { displayText: '📁 FILE SONG', id: buttonIdFor('file', index, sessionId) }
        ]
    })

    if (shown.ok) return { ok: true, code: 'CHOICE_SHOWN', index, sessionId }

    // A build that cannot render buttons must not dead-end the user. The MP3
    // file is the lossless option, so send that and say why.
    console.error(`[SHAZAM] audio choice buttons unavailable (${shown.code}); sending the MP3 file instead`)
    const fallback = await handleSelection({ conn, m, reply, kind: 'file', index, sessionId })
    if (fallback.ok) {
        await reply('ℹ️ This client does not support the audio choice menu, so I sent the MP3 file.')
    }
    return fallback
}

/**
 * Handle a card button press. Downloads only the result that was actually
 * pressed: the 1-based index from the button maps onto that card's result.
 * kind: "play" (audio message), "file" (MP3 document) or "video".
 */
async function handleSelection({ conn, m, reply, kind, index, sessionId }) {
    reply = safeReply(reply)
    const { video, error } = resolveSelection(sessionId, index)
    if (error === 'SESSION_EXPIRED') {
        await reply('❌ This Shazam result has expired. Run `.shazam` again.')
        return { ok: false, code: error }
    }
    if (error) {
        console.error(`[SHAZAM] Invalid result ${index} in session ${sessionId}`)
        await reply('❌ That result is not available any more. Run `.shazam` again.')
        return { ok: false, code: error }
    }

    const label = safeFileName(video.title)
    const isVideo = kind === 'video'
    const tempFile = tempPath(isVideo ? 'shazam-video' : 'shazam-audio', isVideo ? '.mp4' : '.mp3')
    const limit = isVideo ? maxVideoBytes() : MAX_AUDIO_BYTES

    await reply(`${isVideo ? '🎬' : '🎧'} Downloading *${label}*...`)

    try {
        if (isVideo) {
            const info = await downloadShazamVideo(video.url, tempFile, limit)
            await conn.sendMessage(m.chat, {
                video: { url: tempFile },
                mimetype: 'video/mp4',
                fileName: `${label}.mp4`,
                caption: `🎬 ${label}`
            }, { quoted: m })
            return { ok: true, code: 'VIDEO_SENT', title: label, size: info.size }
        }

        const info = await downloadShazamAudio(video.url, tempFile)
        const data = await fs.promises.readFile(tempFile)

        if (kind === 'play') {
            // Playable audio message.
            await conn.sendMessage(m.chat, {
                audio: data,
                mimetype: 'audio/mpeg',
                ptt: false,
                fileName: `${label}.mp3`
            }, { quoted: m })
            return { ok: true, code: 'AUDIO_PLAY_SENT', title: label, size: info.size }
        }

        // Downloadable MP3 file.
        await conn.sendMessage(m.chat, {
            document: data,
            mimetype: 'audio/mpeg',
            fileName: `${label}.mp3`
        }, { quoted: m })
        return { ok: true, code: 'AUDIO_FILE_SENT', title: label, size: info.size }
    } catch (error) {
        const reason = String(error?.message || error)
        console.error(`[SHAZAM ${kind.toUpperCase()}] failed for ${video.url}: ${reason}`)
        if (kind === 'video' && (reason === 'VIDEO_TOO_LARGE' || /too large/i.test(reason))) {
            await reply('❌ This video is too large to send on WhatsApp.\nTry the 🎧 AUDIO button instead.')
            return { ok: false, code: 'VIDEO_TOO_LARGE', reason }
        }
        if (reason === 'AUDIO_TOO_LARGE') {
            await reply('❌ This audio file is too large to send on WhatsApp.')
            return { ok: false, code: 'AUDIO_TOO_LARGE', reason }
        }
        await reply(`❌ I couldn't download that ${isVideo ? 'video' : 'audio'}.\nTry another Shazam card.`)
        return { ok: false, code: 'DOWNLOAD_FAILED', reason }
    } finally {
        await removeQuietly(tempFile)
    }
}

module.exports = {
    handleShazam,
    handleSelection,
    handleAudioChoiceMenu,
    safeReply,
    usageText,
    deliverResults,
    resolveSelection,
    shazamSettings,
    parseButtonId,
    buttonIdFor,
    resolveMediaTarget,
    buildShazamCards,
    buildSearchQuery,
    extractSong,
    safeFileName,
    createSession,
    getSession,
    cleanExpiredSessions,
    credentials,
    acrClient,
    describeUnavailable,
    searchYouTube,
    sessions,
    SESSION_TTL_MS,
    MAX_RESULTS,
    TMP_DIR
}
