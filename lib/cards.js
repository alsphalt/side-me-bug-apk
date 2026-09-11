'use strict'

/*
 * DARKNOTE L2 LICENSE
 * Interactive card / carousel compatibility layer.
 * © DARKNOTE L2 • Bigbrother
 *
 * WHY THIS MODULE EXISTS
 * The old member-list code called the generated protobuf helpers directly:
 *
 *     proto.Message.InteractiveMessage.Header.create({ ... })
 *
 * Those `.create()` constructors are not present in every Baileys build — the
 * installed `levvleys` fork among them — which produced:
 *
 *     TypeError: Cannot read properties of undefined (reading 'create')
 *
 * This module builds the exact same message shapes while preferring `.create()`
 * when the build exposes it and falling back to a plain protobuf object
 * literal, which `relayMessage` accepts just as well. That removes the crash
 * without upgrading or replacing Baileys.
 *
 * PAGINATION
 * Every member list is split into HORIZONTALLY SWIPABLE cards of EXACTLY 15
 * members each (the last card simply holds the remainder). Members are never
 * duplicated between cards, never truncated, and never invented to fill space.
 *
 * DELIVERY GUARANTEE
 * Mention tokens are always `@<number>` of the REAL participant JID, so the
 * WhatsApp client resolves them to the real contact. If the carousel cannot be
 * relayed by the installed build, this module degrades to paginated plain text
 * carrying the same real `mentions` array, so no member is ever lost. Owner can
 * force either behaviour with config.json -> "cards": { "mode": "auto" }.
 */

const fs = require('fs')
const path = require('path')

const PAGE_SIZE = 15

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')
const DEFAULT_CARD_IMAGE = './src/img/menu.jpg'

/**
 * Card image source, from config.json -> "cards": { "image": ... }.
 * A relative path is resolved against the project root. Set it to false or ""
 * to render text-only cards without an image.
 */
function configuredImage() {
    try {
        delete require.cache[require.resolve(CONFIG_PATH)]
        const config = require(CONFIG_PATH)
        const value = config?.cards?.image
        if (value === false || value === null || value === '') return null
        return value || DEFAULT_CARD_IMAGE
    } catch (error) {
        console.error('[CARDS] config read failed, using the default card image:', error?.message || error)
        return DEFAULT_CARD_IMAGE
    }
}

// Card images are uploaded once and reused. Re-uploading the same picture for
// every carousel send would be slow and wasteful, so the prepared protobuf
// image message is cached against the file's path/mtime/size.
let imageCache = { key: '', imageMessage: null, failed: '' }
const mediaCache = new Map()
// Remote images (YouTube thumbnails) cached per URL so repeat carousels reuse
// the same upload. Bounded, and cleared wholesale when it grows too large.
const remoteImageCache = new Map()

/** Resolve a configured path against the project root, not the shell's cwd. */
function resolveImagePath(source) {
    const raw = String(source || '')
    return path.isAbsolute(raw) ? raw : path.join(__dirname, '..', raw.replace(/^\.\//, ''))
}

async function loadImageBuffer(source) {
    const raw = await fs.promises.readFile(resolveImagePath(source))
    try {
        // Cards look best square, and a smaller upload is noticeably faster.
        const sharp = require('sharp')
        return await sharp(raw).resize(600, 600, { fit: 'cover', position: 'centre' }).jpeg({ quality: 85 }).toBuffer()
    } catch (error) {
        console.error('[CARDS] sharp unavailable, uploading the image as-is:', error?.message || error)
        return raw
    }
}

/**
 * Upload the card image once and return the reusable protobuf imageMessage.
 * Any failure logs the real reason and returns null so the cards still render
 * as text-only rather than breaking the whole command.
 */
async function resolveCardImage(conn, source) {
    if (!source) return null
    if (typeof conn?.waUploadToServer !== 'function') {
        console.error('[CARDS] this build does not expose waUploadToServer; cards will have no image')
        return null
    }

    // Remote image, typically a YouTube thumbnail from yt-search.
    if (typeof source === 'object' && source.url) {
        const url = String(source.url)
        if (!/^https?:\/\//i.test(url)) return null
        if (remoteImageCache.has(url)) return remoteImageCache.get(url)

        const remoteHelpers = baileys()
        if (typeof remoteHelpers.prepareWAMessageMedia !== 'function') {
            console.error('[CARDS] this build does not export prepareWAMessageMedia; no remote card image')
            return null
        }
        try {
            const prepared = await remoteHelpers.prepareWAMessageMedia(
                { image: { url } },
                { upload: conn.waUploadToServer, mediaCache }
            )
            const imageMessage = prepared?.imageMessage || null
            if (remoteImageCache.size > 60) remoteImageCache.clear()
            remoteImageCache.set(url, imageMessage)
            return imageMessage
        } catch (error) {
            console.error(`[CARDS] remote card image failed (${url.slice(0, 60)}):`, error?.message || error)
            if (remoteImageCache.size > 60) remoteImageCache.clear()
            remoteImageCache.set(url, null)
            return null
        }
    }

    let key
    try {
        if (Buffer.isBuffer(source)) key = `buffer:${source.length}`
        else {
            const file = resolveImagePath(source)
            const stat = await fs.promises.stat(file)
            key = `${file}:${stat.mtimeMs}:${stat.size}`
        }
    } catch (error) {
        console.error('[CARDS] card image is not readable:', error?.message || error)
        return null
    }

    if (imageCache.key === key && imageCache.imageMessage) return imageCache.imageMessage
    if (imageCache.failed === key) return null

    const helpers = baileys()
    if (typeof helpers.prepareWAMessageMedia !== 'function') {
        console.error('[CARDS] this build does not export prepareWAMessageMedia; cards will have no image')
        return null
    }

    try {
        const buffer = Buffer.isBuffer(source) ? source : await loadImageBuffer(source)
        const prepared = await helpers.prepareWAMessageMedia(
            { image: buffer },
            { upload: conn.waUploadToServer, mediaCache }
        )
        const imageMessage = prepared?.imageMessage || null
        if (!imageMessage) throw new Error('prepareWAMessageMedia returned no imageMessage')
        imageCache = { key, imageMessage, failed: '' }
        console.error('[CARDS] card image uploaded and cached')
        return imageMessage
    } catch (error) {
        console.error('[CARDS] card image upload failed, cards will render without an image:', error?.stack || error)
        imageCache = { key: '', imageMessage: null, failed: key }
        return null
    }
}

// Resolved lazily so a missing/incompatible Baileys build degrades to the text
// fallback instead of taking the whole bot down at require time.
let baileysCache = null
function baileys() {
    if (baileysCache) return baileysCache
    try {
        const mod = require('@whiskeysockets/baileys')
        baileysCache = {
            proto: mod.proto || mod.default?.proto || null,
            generateWAMessageFromContent: mod.generateWAMessageFromContent || null,
            prepareWAMessageMedia: mod.prepareWAMessageMedia || null
        }
    } catch (error) {
        console.error('[CARDS] Baileys helpers unavailable, text fallback will be used:', error?.message || error)
        baileysCache = { proto: null, generateWAMessageFromContent: null, prepareWAMessageMedia: null }
    }
    return baileysCache
}

/**
 * Prefer the generated protobuf helper, fall back to a plain object literal.
 * A helper that exists but throws (partial/mismatched build) also falls back.
 */
function safeCreate(holder, shape) {
    try {
        if (holder && typeof holder.create === 'function') return holder.create(shape)
    } catch (error) {
        console.error('[CARDS] .create() helper failed, using plain object:', error?.message || error)
    }
    return shape
}

function messages() {
    const proto = baileys().proto
    return proto?.Message?.InteractiveMessage || null
}

/* ------------------------------ pagination ------------------------------ */

function chunk(items, size = PAGE_SIZE) {
    const list = Array.isArray(items) ? items : []
    const step = Math.max(1, Number(size) || PAGE_SIZE)
    const pages = []
    for (let i = 0; i < list.length; i += step) pages.push(list.slice(i, i + step))
    return pages
}

/** Pages always carry their position so the reader knows where they are. */
function buildPages(items, size = PAGE_SIZE) {
    const groups = chunk(items, size)
    const total = groups.length
    return groups.map((groupItems, index) => ({
        index: index + 1,
        total,
        from: index * size + 1,
        to: index * size + groupItems.length,
        items: groupItems
    }))
}

/* -------------------------------- entries ------------------------------- */

function numberFromJid(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

function normalizeJid(jid) {
    // Strip the device suffix from the USER part only. Splitting on ':' before
    // the '@' used to truncate the whole JID, dropping the @s.whatsapp.net /
    // @lid domain and leaving a bare number.
    const value = String(jid || '').trim().toLowerCase()
    const at = value.indexOf('@')
    if (at === -1) return value
    return `${value.slice(0, at).split(':')[0]}${value.slice(at)}`
}

/**
 * Pick the JID WhatsApp will actually accept inside a mentions array.
 *
 * A phone-number JID (@s.whatsapp.net) is preferred, then a real @lid identity
 * (valid in modern groups). A JID is never synthesised from unrelated digits:
 * doing `numberFromJid(x) + '@s.whatsapp.net'` on an @lid participant produced a
 * mention for an account that does not exist, which is why tagging a LID-based
 * group appeared to work but never notified anybody.
 */
function mentionJid(participant) {
    const raw = [participant?.id, participant?.jid, participant?.phoneNumber, participant?.lid]
        .map(value => String(value || '').trim())
        .filter(Boolean)
    for (const value of raw) if (/@s\.whatsapp\.net$/i.test(value)) return normalizeJid(value)
    for (const value of raw) if (/@lid$/i.test(value)) return normalizeJid(value)
    for (const value of raw) if (/^\d{8,15}$/.test(value)) return `${value}@s.whatsapp.net`
    const fallback = raw[0] || ''
    return /@/.test(fallback) ? normalizeJid(fallback) : ''
}

function clean(value, max = 45) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Real push name / contact name when available, otherwise nothing. */
function displayName(conn, participant, jid) {
    for (const candidate of [participant?.notify, participant?.name, participant?.verifiedName, participant?.displayName]) {
        const name = clean(candidate)
        if (name) return name
    }
    const ids = [jid, participant?.id, participant?.jid, participant?.lid].filter(Boolean)
    for (const id of ids) {
        const contact = conn?.contacts?.[normalizeJid(id)] || conn?.contacts?.[id]
        const chat = conn?.chats?.[normalizeJid(id)] || conn?.chats?.[id]
        const name = clean(contact?.notify || contact?.name || contact?.verifiedName || chat?.name || chat?.notify)
        if (name) return name
    }
    return ''
}

function isAdmin(participant) {
    const role = String(participant?.admin || participant?.role || '').toLowerCase()
    return role === 'admin' || role === 'superadmin' || role === 'administrator' || participant?.isAdmin === true
}

function isCreator(participant) {
    const role = String(participant?.admin || participant?.role || '').toLowerCase()
    return role === 'superadmin' || participant?.isSuperAdmin === true || participant?.isCreator === true
}

/** Build one card entry from REAL group metadata. Nothing is invented. */
function participantEntry(conn, participant, extra = '') {
    // The real JID is preserved so the mentions array resolves to the real
    // account. The display number is derived from that same JID.
    const jid = mentionJid(participant)
    const number = numberFromJid(jid)
    return {
        jid,
        number,
        name: displayName(conn, participant, jid || String(participant?.id || '')),
        isAdmin: isAdmin(participant),
        isCreator: isCreator(participant),
        extra: clean(extra, 40)
    }
}

function formatEntry(entry, position) {
    // The `@<number>` token is what makes WhatsApp render a real mention. The
    // push name is kept for readability, so nothing raw is dumped on the user.
    const mention = entry.number ? `@${entry.number}` : ''
    const label = entry.name && entry.name !== entry.number
        ? `${entry.name} (${mention})`
        : (mention || entry.name || 'WhatsApp member')
    const tail = []
    if (entry.isCreator) tail.push('👑 Creator')
    else if (entry.isAdmin) tail.push('🛡️ Admin')
    if (entry.extra) tail.push(entry.extra)
    return `${position}. ${label}${tail.length ? ` — ${tail.join(' • ')}` : ''}`
}

/* ------------------------------- rendering ------------------------------ */

function pageHeader(options, page, totalMembers) {
    const heading = clean(options?.heading || 'MEMBERS', 40)
    if (page.total <= 1) return `${heading}\nMembers 1–${totalMembers}`
    return `${heading}\nCARD ${page.index}/${page.total} • Members ${page.from}–${page.to} of ${totalMembers}`
}

function pageBody(options, page, totalMembers) {
    const lines = page.items.map((entry, i) => formatEntry(entry, page.from + i))
    const note = options?.note ? `${clean(options.note, 120)}\n\n` : ''
    // Empty positions are simply left out. No filler members are ever added.
    return `${pageHeader(options, page, totalMembers)}\n\n${note}${lines.join('\n')}`
}

/** Free-text summary shown on the final page / outer card body. */
function summaryFor(options, totalMembers) {
    if (options?.summary) return String(options.summary)
    return `Total: ${totalMembers}`
}

function footerFor(page, pages) {
    if (pages <= 1) return 'DARKNOTE L2 • Bigbrother'
    return `DARKNOTE L2 • swipe → card ${page.index}/${pages}`
}

/* ------------------------------- transport ------------------------------ */

async function tryCarousel(conn, m, options, pages, totalMembers) {
    const helpers = baileys()
    const IM = messages()
    if (!IM || typeof helpers.generateWAMessageFromContent !== 'function') return false
    if (typeof conn?.relayMessage !== 'function') return false

    // A media header is what makes the cards render as real WhatsApp cards. The
    // image is uploaded once and the same prepared imageMessage is reused by
    // every card, so a large group does not trigger repeated uploads.
    const cardImage = await resolveCardImage(conn, options?.image)

    const cards = []
    for (const page of pages) {
        const header = cardImage
            ? safeCreate(IM.Header, {
                title: `CARD ${page.index}/${page.total}`,
                hasMediaAttachment: true,
                imageMessage: { ...cardImage }
            })
            : safeCreate(IM.Header, { title: `CARD ${page.index}/${page.total}`, hasMediaAttachment: false })

        const card = safeCreate(IM, {
            header,
            body: safeCreate(IM.Body, { text: pageBody(options, page, totalMembers) }),
            footer: safeCreate(IM.Footer, { text: footerFor(page, page.total) }),
            // Informational cards on purpose: mentions are delivered through the
            // real mentions array, so there are no button IDs to collide with.
            nativeFlowMessage: safeCreate(IM.NativeFlowMessage, { buttons: [], messageParamsJson: '' })
        })
        cards.push(card)
    }

    const mentions = [...new Set((options?.entries || []).map(entry => entry.jid).filter(Boolean))]
    const note = options?.note ? `${clean(options.note, 120)}\n` : ''
    const interactive = safeCreate(IM, {
        body: safeCreate(IM.Body, {
            text: `${clean(options?.heading || 'MEMBERS', 40)}\n${note}Swipe horizontally through ${pages.length} card${pages.length === 1 ? '' : 's'} (${totalMembers} member${totalMembers === 1 ? '' : 's'}).\n${summaryFor(options, totalMembers)}`
        }),
        footer: safeCreate(IM.Footer, { text: clean(options?.footer || 'DARKNOTE L2 • Bigbrother', 60) }),
        carouselMessage: safeCreate(IM.CarouselMessage, { cards }),
        contextInfo: { mentionedJid: mentions }
    })

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: interactive
            }
        }
    }

    const built = helpers.generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, quoted: m })
    await conn.relayMessage(m.chat, built.message, { messageId: built.key.id })
    return true
}

async function sendTextPages(conn, m, options, pages, totalMembers) {
    const entries = options?.entries || []
    const mentions = [...new Set(entries.map(entry => entry.jid).filter(Boolean))]
    const closing = `\n\n${summaryFor(options, totalMembers)}`

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i]
        const isLast = i === pages.length - 1
        const text = `${pageBody(options, page, totalMembers)}${isLast ? closing : ''}`
        await conn.sendMessage(m.chat, { text, mentions }, { quoted: i === 0 ? m : undefined })
    }
    return true
}

/**
 * Send a member list as 15-per-card horizontal carousel pages.
 * Falls back to paginated text with the same real mentions when the installed
 * Baileys build cannot relay an interactive carousel.
 */
async function sendMemberPages(conn, m, options = {}) {
    const entries = (Array.isArray(options.entries) ? options.entries : [])
        .filter(entry => entry && (entry.jid || entry.number || entry.name))
    const reply = typeof options.reply === 'function' ? options.reply : null

    if (!entries.length) {
        const message = options.emptyMessage || 'ℹ️ No members were found.'
        if (reply) await reply(message)
        return { ok: false, code: 'NO_ENTRIES', members: 0 }
    }

    const pages = buildPages(entries, PAGE_SIZE)
    const totalMembers = entries.length
    const mode = String(options.mode || 'auto').toLowerCase()
    // An explicit per-call source wins; otherwise use the configured card image.
    const imageSource = options.image !== undefined ? options.image : configuredImage()

    if (mode !== 'text') {
        try {
            const sent = await tryCarousel(conn, m, { ...options, entries, image: imageSource }, pages, totalMembers)
            if (sent) return { ok: true, code: 'CAROUSEL', pages: pages.length, members: totalMembers }
        } catch (error) {
            console.error('[CARDS] carousel relay failed, using text pages:', error?.stack || error)
        }
    }

    try {
        await sendTextPages(conn, m, { ...options, entries }, pages, totalMembers)
        return { ok: true, code: 'TEXT_PAGES', pages: pages.length, members: totalMembers }
    } catch (error) {
        console.error('[CARDS] text page send failed:', error?.stack || error)
        if (reply) await reply(options.failureMessage || '❌ Failed to send the member list. Please try again.')
        return { ok: false, code: 'SEND_FAILED', reason: error?.message || String(error), members: totalMembers }
    }
}

/* --------------------- generic result card carousel --------------------- */

/** Like clean() but keeps intentional line breaks (card bodies are multi-line). */
function cleanMulti(value, max = 500) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max)
}

/**
 * One card per result, each with its own image and its own buttons.
 * The card order always mirrors the results order, and the caller puts the
 * result index inside the button id, so a failed thumbnail can never shift a
 * button onto the wrong result.
 */
async function tryCardCarousel(conn, m, options) {
    const helpers = baileys()
    const IM = messages()
    if (!IM || typeof helpers.generateWAMessageFromContent !== 'function') return false
    if (typeof conn?.relayMessage !== 'function') return false

    const cards = []
    for (const item of options.cards) {
        const wanted = item.image !== undefined ? item.image : options.defaultImage
        let imageMessage = await resolveCardImage(conn, wanted)
        // Never drop a card. If its own thumbnail fails, fall back to the default
        // card image; if that fails too, send it without media. Dropping a card
        // would renumber the results and break the button mapping.
        if (!imageMessage && wanted !== options.defaultImage) {
            console.error('[CARDS] card thumbnail failed, falling back to the default card image')
            imageMessage = await resolveCardImage(conn, options.defaultImage)
        }

        const headerShape = {
            title: clean(item.title || 'Result', 60),
            hasMediaAttachment: !!imageMessage
        }
        if (imageMessage) headerShape.imageMessage = { ...imageMessage }

        const buttons = (Array.isArray(item.buttons) ? item.buttons : []).map(button => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: clean(button.displayText, 24),
                id: String(button.id)
            })
        }))

        cards.push(safeCreate(IM, {
            header: safeCreate(IM.Header, headerShape),
            body: safeCreate(IM.Body, { text: cleanMulti(item.body, 400) }),
            footer: safeCreate(IM.Footer, { text: clean(item.footer || options.footer || 'DARKNOTE L2 • Bigbrother', 60) }),
            nativeFlowMessage: safeCreate(IM.NativeFlowMessage, { buttons, messageParamsJson: '' })
        }))
    }

    if (!cards.length) return false

    const interactive = safeCreate(IM, {
        body: safeCreate(IM.Body, { text: cleanMulti(options.heading || 'RESULTS', 200) }),
        footer: safeCreate(IM.Footer, { text: clean(options.footer || 'Swipe → choose', 60) }),
        carouselMessage: safeCreate(IM.CarouselMessage, { cards })
    })

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: interactive
            }
        }
    }

    const built = helpers.generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, quoted: m })
    await conn.relayMessage(m.chat, built.message, { messageId: built.key.id })
    return true
}

/**
 * Send a generic horizontally swipable card carousel (one card per result, with
 * buttons). Falls back to a single numbered text list when the build cannot
 * relay a carousel, so the user still gets the results.
 */
async function sendCardCarousel(conn, m, options = {}) {
    const items = (Array.isArray(options.cards) ? options.cards : []).filter(Boolean)
    const reply = typeof options.reply === 'function' ? options.reply : null

    if (!items.length) {
        if (reply) await reply(options.emptyMessage || 'ℹ️ Nothing to show.')
        return { ok: false, code: 'NO_CARDS', cards: 0 }
    }

    const mode = String(options.mode || 'auto').toLowerCase()
    const defaultImage = options.image !== undefined ? options.image : configuredImage()

    if (mode !== 'text') {
        try {
            const sent = await tryCardCarousel(conn, m, { ...options, cards: items, defaultImage })
            if (sent) return { ok: true, code: 'CAROUSEL', cards: items.length }
        } catch (error) {
            console.error('[CARDS] card carousel relay failed, using text fallback:', error?.stack || error)
        }
    }

    try {
        const lines = items.map((item, index) => {
            const body = cleanMulti(item.body, 200).split('\n').filter(Boolean).map(line => `   ${line}`).join('\n')
            return `*${index + 1}.* ${clean(item.title, 80)}${body ? `\n${body}` : ''}`
        })
        const hint = options.fallbackHint ? `\n\n${cleanMulti(options.fallbackHint, 200)}` : ''
        const text = `${cleanMulti(options.heading || 'RESULTS', 100)}\n\n${lines.join('\n\n')}${hint}`
        await conn.sendMessage(m.chat, { text }, { quoted: m })
        return { ok: true, code: 'TEXT', cards: items.length }
    } catch (error) {
        console.error('[CARDS] card fallback send failed:', error?.stack || error)
        if (reply) await reply(options.failureMessage || '❌ Failed to send the results.')
        return { ok: false, code: 'SEND_FAILED', reason: error?.message || String(error), cards: items.length }
    }
}

/**
 * Standalone message with quick_reply buttons (no carousel). Uses the same
 * nativeFlowMessage format as the carousels, so the existing button dispatcher
 * picks it up with no extra listener. Returns ok:false when the build cannot
 * render buttons, and the caller decides the fallback.
 */
async function sendChoiceButtons(conn, m, options = {}) {
    const buttons = (Array.isArray(options.buttons) ? options.buttons : []).filter(button => button && button.id)
    if (!buttons.length) return { ok: false, code: 'NO_BUTTONS' }

    const helpers = baileys()
    const IM = messages()
    if (!IM || typeof helpers.generateWAMessageFromContent !== 'function' || typeof conn?.relayMessage !== 'function') {
        return { ok: false, code: 'NO_BUTTONS', reason: 'This build cannot relay interactive messages.' }
    }

    try {
        const interactive = safeCreate(IM, {
            body: safeCreate(IM.Body, { text: cleanMulti(options.heading || '', 500) }),
            footer: safeCreate(IM.Footer, { text: clean(options.footer || 'DARKNOTE L2 • Bigbrother', 60) }),
            nativeFlowMessage: safeCreate(IM.NativeFlowMessage, {
                buttons: buttons.map(button => ({
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: clean(button.displayText, 24),
                        id: String(button.id)
                    })
                })),
                messageParamsJson: ''
            })
        })

        const content = {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: interactive
                }
            }
        }

        const built = helpers.generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, quoted: m })
        await conn.relayMessage(m.chat, built.message, { messageId: built.key.id })
        return { ok: true, code: 'BUTTONS' }
    } catch (error) {
        console.error('[CARDS] choice buttons could not be relayed:', error?.stack || error)
        return { ok: false, code: 'NO_BUTTONS', reason: error?.message || String(error) }
    }
}

module.exports = {
    PAGE_SIZE,
    safeCreate,
    interactiveMessage: messages,
    configuredImage,
    resolveCardImage,
    cleanMulti,
    sendCardCarousel,
    sendChoiceButtons,
    chunk,
    buildPages,
    participantEntry,
    formatEntry,
    pageBody,
    summaryFor,
    sendMemberPages,
    numberFromJid,
    displayName
}
