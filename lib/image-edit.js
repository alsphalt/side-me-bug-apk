'use strict'

/*
 * DARKNOTE SMART IMAGE & STICKER RE-EDIT  (`.edit`)
 * ------------------------------------------------
 * A reusable media pipeline, not a one-off command. The stages are deliberately
 * separate so each can be tested and replaced:
 *
 *   reply -> resolve media -> download -> analyse reference -> build prompt
 *         -> generate -> retrieve -> post-process -> send
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONEST CAPABILITY STATEMENT — READ THIS BEFORE CHANGING THE BACKEND
 * ─────────────────────────────────────────────────────────────────────────────
 * This was measured against the live API, not assumed:
 *
 *   GET /api/image/animagine?prompt=&apikey=      -> 200, works. TEXT-TO-IMAGE.
 *   GET /api/imageToImage/gpt-image-2             -> 404 ENDPOINT_DISABLED
 *   GET /api/imageToImage/seedream                -> 404 ENDPOINT_DISABLED
 *   GET /api/fluxv2                               -> 200, works. TEXT-TO-IMAGE.
 *   (no vision / image-description endpoint exists)
 *
 * animagine was also called WITH an extra `image=` parameter. The response was
 * byte-identical to the call without it, i.e. the parameter is IGNORED. So there
 * is NO genuine pixel-level image-to-image on this plan, and this module does
 * NOT pretend otherwise.
 *
 * What it does instead is the closest thing the backend can actually do, and
 * says so to the owner:
 *
 *   The replied photo/sticker IS processed - it is downloaded and analysed to
 *   extract a real reference description (shape, aspect ratio, transparency,
 *   dominant colours) which is combined with the user's instruction to drive
 *   generation. The result is a REGENERATION guided by the original, not an
 *   edit of its pixels. Pixel-preserving edits require the imageToImage
 *   endpoints above; when they are enabled this module uses them automatically
 *   (see probeCapabilities / generate) with no other change.
 *
 * Secrets: the API key is read from the environment and is never logged, never
 * returned to a user, and never placed in a message.
 */

const path = require('path')
const { fileTypeFromBuffer } = require('file-type')

const aiConfig = require('../ai/config')
const provider = require('../ai/provider')
const language = require('../ai/language')

const BASE_URL = 'https://www.mzazi.shop'
const IMAGE_ENDPOINT = '/api/image/animagine'
// Checked in order. All currently report ENDPOINT_DISABLED; the first one that
// answers becomes the editing backend automatically.
const IMAGE_TO_IMAGE_ENDPOINTS = [
    '/api/imageToImage/gpt-image-2',
    '/api/imageToImage/seedream'
]
const REQUEST_TIMEOUT_MS = 120000
const GENERATION_ATTEMPTS = 4
// Retry only on conditions that are actually transient. A bad key or a disabled
// endpoint is permanent and must fail fast.
const RETRYABLE = /RATE_LIMITED|PROVIDER_TIMEOUT|PROVIDER_ERROR|timeout|ECONNRESET|ENOTFOUND|socket hang up|fetch failed|502|504/i

/* --------------------------------- errors -------------------------------- */

/*
 * Every failure carries a stable code and a short, non-technical sentence. The
 * sentence is what a user sees; the code and the real error go to the panel log.
 * Nothing here ever embeds a key, a URL or a stack.
 */
const FAILURES = {
    no_media: 'Reply to a photo or sticker with what you want changed.',
    unsupported_media: "I can only re-edit photos and stickers.",
    invalid_media: "That media couldn't be read. Try sending it again.",
    download_failed: "I couldn't download that media. Please try again.",
    empty_instruction: 'Tell me what to change, e.g. .edit make the background a beach',
    generate_failed: 'The image service is busy right now. Please try again in a moment.',
    rate_limited: 'The image service is rate limited. Please try again in a minute.',
    no_image_returned: "The image service didn't return a picture. Please try again.",
    build_failed: "I couldn't turn that into an edit. Try describing the change differently.",
    sticker_failed: "I made the picture but couldn't convert it to a sticker. Sending it as an image instead."
}

class EditError extends Error {
    constructor(code, detail) {
        super(FAILURES[code] || FAILURES.generate_failed)
        this.code = code
        /*
         * A failure detail is the raw reason, which may quote a URL that carries
         * the api key (a fetch error message can contain the full request URL).
         * It is scrubbed HERE, at construction, so no code path can put a key
         * into a returned object or a log line by forgetting to scrub later.
         */
        this.detail = detail ? scrub(String(detail)).slice(0, 300) : ''
    }
}

/* -------------------------------- helpers -------------------------------- */

// Strip anything that looks like a key or an internal URL out of text bound for
// a log line or a user.
function scrub(text) {
    return String(text || '')
        .replace(/mzazi_[A-Za-z0-9_-]+/g, 'mzazi_***')
        .replace(/apikey=[^\s&"']+/gi, 'apikey=***')
}

function log(message, error) {
    console.log(`[EDIT] ${message}${error ? ` :: ${scrub(error?.message || error)}` : ''}`)
}

function logErr(message, error) {
    console.error(`[EDIT] ${message}`, error?.stack ? scrub(error.stack) : scrub(error))
}

function apiKey() {
    aiConfig.loadEnvOnce()
    // A dedicated image key wins; the shared key is the fallback so an existing
    // install keeps working with no new configuration.
    return String(process.env.MZAZI_API_KEY_IMAGE || process.env.MZAZI_API_KEY || '').trim()
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/* ---------------------------- capability probe --------------------------- */

// Cached so the probe runs once per process rather than on every .edit.
let capability = null

/**
 * Work out whether a REAL image-to-image backend is available.
 *
 * Called once and cached. Until an endpoint stops returning ENDPOINT_DISABLED
 * this will always report false, and generate() uses text-to-image with a
 * reference-derived prompt instead. No behaviour is faked either way.
 */
async function probeCapabilities(force = false) {
    if (capability && !force) return capability
    const key = apiKey()
    const result = { imageToImage: null, textToImage: Boolean(key), checkedAt: Date.now() }
    if (!key) {
        capability = result
        return capability
    }
    for (const endpoint of IMAGE_TO_IMAGE_ENDPOINTS) {
        try {
            const response = await fetch(`${BASE_URL}${endpoint}?prompt=probe&apikey=${encodeURIComponent(key)}`, {
                signal: AbortSignal.timeout(30000)
            })
            const body = await response.json().catch(() => ({}))
            // ENDPOINT_DISABLED / ENDPOINT_NOT_FOUND mean "not on this plan".
            if (response.ok && body?.status !== false) {
                result.imageToImage = endpoint
                log(`real image-to-image available at ${endpoint}`)
                break
            }
            log(`image-to-image not available at ${endpoint}: ${body?.error || response.status}`)
        } catch (error) {
            log(`image-to-image probe failed for ${endpoint}`, error)
        }
    }
    capability = result
    return capability
}

function capabilities() {
    return capability || { imageToImage: null, textToImage: Boolean(apiKey()), checkedAt: 0 }
}

/* ------------------------------ media intake ----------------------------- */

function mediaOf(quoted) {
    const type = String(quoted?.mtype || quoted?.type || '')
    if (/sticker/i.test(type)) return 'sticker'
    if (/image/i.test(type)) return 'image'
    return ''
}

/**
 * Download the replied media.
 *
 * Uses the same `quoted.download()` path the existing `.sticker` and `.vv`
 * commands already use, so there is one media-download mechanism in the project.
 */
async function resolveMedia(m, opts = {}) {
    const quoted = m?.quoted
    if (!quoted) throw new EditError('no_media')

    let kind = mediaOf(quoted)
    // .editphoto / .editsticker are explicit: an unsupported target is an error
    // rather than a silent fallback to the other kind.
    if (opts.requireKind && kind !== opts.requireKind) throw new EditError('unsupported_media')
    if (!kind) throw new EditError('unsupported_media')

    let buffer
    try {
        buffer = await quoted.download()
    } catch (error) {
        logErr('media download failed', error)
        throw new EditError('download_failed', error?.message)
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new EditError('download_failed')
    if (buffer.length > 25 * 1024 * 1024) throw new EditError('unsupported_media', 'media too large')

    const type = await fileTypeFromBuffer(buffer).catch(() => null)
    const mime = type?.mime || (kind === 'sticker' ? 'image/webp' : 'image/jpeg')
    if (!/^image\//.test(mime)) throw new EditError('invalid_media', `mime ${mime}`)

    return { buffer, kind, mime, bytes: buffer.length }
}

/* --------------------------- reference analysis --------------------------- */

/*
 * Everything this backend can genuinely learn from the original. It cannot see
 * the picture, so it contributes the facts that ARE available - geometry, shape,
 * transparency - which is what keeps composition and framing close to the
 * original. Shared with the prompt builder, and reported by `.editstatus`.
 */
async function analyseReference(media) {
    const facts = { width: 0, height: 0, ratio: '', transparent: false, colours: [] }
    try {
        const sharp = require('sharp')
        const image = sharp(media.buffer, { animated: false })
        const meta = await image.metadata()
        facts.width = Number(meta.width) || 0
        facts.height = Number(meta.height) || 0
        facts.transparent = Boolean(meta.hasAlpha)
        facts.animated = Boolean(meta.pages && meta.pages > 1)

        if (facts.width && facts.height) {
            const r = facts.width / facts.height
            // A short, human-readable framing hint for the prompt.
            if (r > 1.6) facts.ratio = 'wide landscape'
            else if (r > 1.15) facts.ratio = 'landscape'
            else if (r < 0.62) facts.ratio = 'tall portrait'
            else if (r < 0.87) facts.ratio = 'portrait'
            else facts.ratio = 'square'
        }

        // Dominant colours give the prompt a real anchor to the original's
        // palette, which is what keeps the result recognisably related.
        try {
            const stats = await sharp(media.buffer).resize(64, 64, { fit: 'inside' }).stats()
            facts.colours = (stats.dominant || {})
                ? [stats.dominant]
                    .filter(Boolean)
                    .map(c => `#${[c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`)
                : []
        } catch { /* colour stats are a bonus, never a requirement */ }
    } catch (error) {
        // A failed analysis must not stop the edit - it only makes the prompt
        // less specific.
        log('reference analysis skipped', error)
    }
    return facts
}

/* ------------------------------ prompt build ----------------------------- */

/*
 * The instruction may be English, Swahili or mixed. The existing AI router
 * translates intent into a single English generation prompt, because the image
 * endpoint only understands English prompts.
 *
 * The preservation rules from the brief are encoded in the directive: keep the
 * subject, pose, composition and style; change ONLY what was asked.
 */
const PRESERVE_DIRECTIVE = [
    'Rewrite the instruction as ONE English text-to-image prompt.',
    'Keep the same main subject, pose, framing and overall style unless the instruction asks to change them.',
    'Change ONLY what is requested; do not redesign the whole image.',
    'Do not mention editing, photoshop, AI or the original file. Output the prompt text only, no quotes, no preamble.'
].join(' ')

const STICKER_DIRECTIVE =
    'The subject is a cartoon sticker character: keep it flat, bold, simple and clearly readable at small size.'

/*
 * SWAHILI MARKERS.
 *
 * The shared ai/language.js detector returns "auto" for Swahili - it is built for
 * the chatbot's mirror-the-user behaviour, not for identifying the language, so
 * it cannot be relied on here. Without this, a Swahili instruction would be sent
 * to an English-only image endpoint with no translation hint at all.
 *
 * These are common Swahili instruction words. A match does not have to be
 * perfect: the worst case is an extra "translate this" line on an English
 * prompt, which changes nothing.
 */
const SWAHILI_HINT = /\b(badilisha|ongeza|ondoa|mfanye|mfunge|fanya|iwe|kuwa|nguo|rangi|nyeusi|nyeupe|weka|picha|kwa|na|ziwe|acheke|tabasamu|miwani|kofia|nywele|usoni|mandhari|kubwa|ndogo|nyingine|mpya|hiyo|hii|ya|yaani|kama|sana|kidogo)\b/i

const SWAHILI_DIRECTIVE =
    'The request is written in Swahili. Translate it to English first, then write the image prompt in English.'

async function buildGenerationPrompt(instruction, reference, media, settings) {
    const text = String(instruction || '').trim().slice(0, 500)
    if (!text) throw new EditError('empty_instruction')

    const detected = language.detect(text)
    // The shared detector is kept for its English/Swahili-ish signal, but the
    // explicit marker list is what actually guarantees a Swahili instruction gets
    // translated rather than passed through untouched.
    const isSwahili = SWAHILI_HINT.test(text)
    const code = isSwahili ? 'sw' : (detected.code || 'en')

    const shape = [
        reference.ratio ? `framing: ${reference.ratio}` : '',
        reference.transparent ? 'has a transparent background' : '',
        reference.colours.length ? `dominant colour ${reference.colours[0]}` : '',
        media.kind === 'sticker' ? 'it is a WhatsApp sticker' : ''
    ].filter(Boolean).join(', ')

    const prompt = [
        'You convert edit requests for an image into a single generation prompt.',
        PRESERVE_DIRECTIVE,
        media.kind === 'sticker' ? STICKER_DIRECTIVE : '',
        isSwahili ? SWAHILI_DIRECTIVE : '',
        `The original image: ${shape || 'unknown shape'}.`,
        `Requested change${code !== 'en' ? ' (translate it to English first)' : ''}: ${text}`
    ].filter(Boolean).join('\n')

    // Reuse the project's existing AI router rather than calling an endpoint
    // directly - one place for provider selection, keys, health and fallback.
    let expanded = ''
    try {
        const result = await provider.ask(prompt, settings, { originalMessage: text })
        if (result?.ok && result.answer) {
            expanded = String(result.answer)
                .replace(/^```[\s\S]*?```$/g, '')
                .replace(/^["'\s]+|["'\s]+$/g, '')
                .split('\n')[0]
                .trim()
                .slice(0, 300)
        } else {
            log(`prompt expansion unavailable: ${result?.code || 'unknown'}`)
        }
    } catch (error) {
        logErr('prompt expansion threw', error)
    }

    /*
     * If the model is unavailable the raw instruction is used directly. That is
     * a genuine fallback, not a fake: a Swahili instruction still reaches the
     * image endpoint, and the owner sees in the log that expansion was skipped.
     */
    if (!expanded) {
        expanded = [media.kind === 'sticker' ? 'cartoon sticker character,' : '', text].filter(Boolean).join(' ')
    }

    return {
        prompt: expanded,
        original: text,
        language: code,
        swahili: isSwahili,
        expanded: Boolean(expanded !== text),
        reference: shape
    }
}

/* -------------------------------- generate ------------------------------- */

/**
 * Call the image backend.
 *
 * When a real image-to-image endpoint is configured the original buffer is sent
 * as the reference and the instruction is applied to it. Otherwise the
 * text-to-image endpoint is used with the reference-derived prompt. Both paths
 * return the same shape, so nothing downstream changes.
 */
async function generate(prompt, media, opts = {}) {
    const key = apiKey()
    if (!key) throw new EditError('generate_failed', 'no image API key configured')

    const caps = await probeCapabilities()
    const endpoint = caps.imageToImage || IMAGE_ENDPOINT
    const isImageToImage = Boolean(caps.imageToImage)

    const params = new URLSearchParams({ prompt, apikey: key })
    if (opts.ratio) params.set('ratio', opts.ratio)
    if (isImageToImage) {
        // Only sent to an endpoint that genuinely consumes it. Sending it to
        // animagine would be theatre: that endpoint ignores it.
        params.set('image', media.buffer.toString('base64'))
    }

    let lastError = null
    for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(`${BASE_URL}${endpoint}?${params.toString()}`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            })
            const body = await response.json().catch(() => ({}))

            if (response.ok && body?.status !== false) {
                const url = body?.result?.cdn_url || body?.result?.url || body?.result?.image || ''
                if (url) {
                    return { url, endpoint, mode: isImageToImage ? 'image-to-image' : 'text-to-image', attempts: attempt }
                }
                throw new EditError('no_image_returned', 'response had no image url')
            }

            const code = String(body?.error || response.status)
            if (/RATE_LIMIT/i.test(code)) throw new EditError('rate_limited', code)
            if (/API_KEY|AUTH|FORBIDDEN/i.test(code)) {
                // Permanent — retrying a bad key just wastes time.
                throw new EditError('generate_failed', code)
            }
            if (!RETRYABLE.test(code) && !RETRYABLE.test(String(body?.message || ''))) {
                throw new EditError('generate_failed', code)
            }
            lastError = new Error(code)
            log(`generation attempt ${attempt} failed: ${code}`)
        } catch (error) {
            if (error instanceof EditError && !RETRYABLE.test(String(error.detail || ''))) throw error
            lastError = error
            log(`generation attempt ${attempt} threw`, error)
        }
        /*
         * Two different waits, because the two failures need different patience.
         *
         * MEASURED: this endpoint rate-limits CONSECUTIVE calls. Two generations
         * back to back fail with RATE_LIMITED, while the same request succeeds
         * first time after a ~60s gap. The old flat ladder topped out at 12s, so a
         * rate-limited request burned all four attempts inside the window and
         * reported a failure that would have succeeded seconds later.
         *
         * A rate limit therefore gets a long ladder; a transient timeout or
         * provider error keeps the short one, so a genuinely dead request still
         * fails reasonably fast instead of hanging for minutes.
         */
        const rateLimited = lastError?.code === 'rate_limited' || /RATE_LIMIT/i.test(String(lastError?.message || ''))
        if (attempt < GENERATION_ATTEMPTS) {
            await sleep(rateLimited ? 20000 * attempt : Math.min(12000, 2000 * attempt))
        }
    }
    throw new EditError('generate_failed', lastError?.message || 'all attempts failed')
}

/* -------------------------------- retrieve ------------------------------- */

/*
 * MEASURED QUIRK OF THIS CDN.
 *
 * The API returns e.g. https://tmpfiles.org/dl/<id>/<name>.png. That URL ALWAYS
 * 302s to an HTML preview page - with or without a browser User-Agent - and the
 * page body is HTML, not an image. The real file is a timestamped URL listed
 * inside that page:
 *
 *   https://tmpfiles.org/dl/1789148945.<hash>/<id>/<name>.png
 *
 * So: try the URL, and if the bytes are not an image, read the preview page and
 * follow the link it advertises. The extension is also unreliable (this backend
 * returns JPEG bytes under a .png name), which is why the type is taken from the
 * magic bytes and never from the filename.
 */
const IMAGE_MAGIC = [
    { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
    { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
    { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] }
]

/**
 * Identify an image from its magic bytes.
 *
 * Returns '' for anything that is not a non-empty Buffer. Callers use this on
 * values which may be undefined - a send that never happened, a reply that
 * carried no media - and reading `buffer[0]` on undefined threw a TypeError
 * instead of simply answering "not an image".
 */
function sniff(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return ''
    for (const candidate of IMAGE_MAGIC) {
        if (candidate.magic.every((byte, index) => buffer[index] === byte)) return candidate.mime
    }
    return ''
}

function directLinksFrom(html, base) {
    const found = new Set()
    const pattern = /https?:\/\/[^\s"'<>\\]+/g
    let match
    while ((match = pattern.exec(html))) {
        const url = match[0]
        // The real download path carries a timestamp.id prefix segment.
        if (/\/dl\/\d{6,}[.\w]*\//.test(url)) found.add(url)
    }
    try {
        const relative = /href="(\/dl\/\d{6,}[^"]+)"/g
        while ((match = relative.exec(html))) found.add(new URL(match[1], base).toString())
    } catch { /* malformed hrefs are skipped */ }
    return [...found]
}

async function fetchImage(url, depth = 0) {
    if (!url || depth > 2) throw new EditError('no_image_returned')
    let response
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
        logErr('generated image download failed', error)
        throw new EditError('no_image_returned', error?.message)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (sniff(buffer)) return { buffer, mime: sniff(buffer) }

    // Not an image: this is the CDN's preview page. Follow the real link.
    const html = buffer.toString('utf8')
    const links = directLinksFrom(html, url)
    if (!links.length) throw new EditError('no_image_returned', `body was not an image (${buffer.length} bytes)`)
    log(`cdn served a preview page; following ${links.length} direct link(s)`)
    for (const link of links) {
        try {
            return await fetchImage(link, depth + 1)
        } catch (error) {
            log(`direct link failed: ${scrub(error?.message || '')}`)
        }
    }
    throw new EditError('no_image_returned')
}

/* ------------------------------ post-process ----------------------------- */

const WANTS_STICKER = /\b(sticker|stiker|sticka)\b/i
const WANTS_IMAGE = /\b(image|photo|picture|picha)\b/i

/**
 * Decide the output type.
 *
 *  - explicit "make this a sticker" always wins
 *  - an explicit image request from a sticker gives an image
 *  - otherwise sticker in -> sticker out, photo in -> photo out
 */
function decideOutput(instruction, media, override) {
    if (override) return override
    const text = String(instruction || '')
    if (WANTS_STICKER.test(text)) return 'sticker'
    if (WANTS_IMAGE.test(text) && media.kind === 'sticker') return 'image'
    return media.kind === 'sticker' ? 'sticker' : 'image'
}

/**
 * Convert the generated picture into a real WhatsApp sticker.
 *
 * Reuses lib/StickerMaker.js (writeExif) so sticker output goes through exactly
 * the same WebP/EXIF path as the existing `.sticker` command - correct
 * dimensions, transparency preserved, reasonable size.
 */
async function toSticker(buffer, mime) {
    const { writeExif } = require('./StickerMaker.js')
    try {
        const sticker = await writeExif(buffer, {
            packname: 'DARKNOTE',
            author: 'Bigbrother',
            cropToSquare: false
        })
        if (!Buffer.isBuffer(sticker) || !sniff(sticker)) throw new Error('conversion produced no webp')
        return Buffer.from(sticker)
    } catch (error) {
        logErr('webp sticker conversion failed', error)
        throw new EditError('sticker_failed', error?.message)
    }
}

/**
 * Re-encode the generated picture as a normal image for sending.
 *
 * The backend returns JPEG bytes under a .png name, which a JPEG-based
 * re-encode normalises so WhatsApp always renders it.
 */
async function toImage(buffer, mime) {
    if (mime === 'image/png' || mime === 'image/webp') return { buffer, mime }
    try {
        const sharp = require('sharp')
        const out = await sharp(buffer).jpeg({ quality: 92 }).toBuffer()
        return { buffer: out, mime: 'image/jpeg' }
    } catch (error) {
        logErr('image re-encode failed (sending the original bytes)', error)
        return { buffer, mime }
    }
}

/* --------------------------------- send ---------------------------------- */

function readiness(conn) {
    // Same rule the rest of the project uses: never touch a socket that is not
    // open, or the send races the startup/reconnect.
    return !conn?.__darknoteConnectionState || conn.__darknoteConnectionState === 'open'
}

/* ------------------------------ the pipeline ----------------------------- */

/*
 * One in-flight edit per chat. A double-fire of .edit would otherwise generate
 * twice and post two different pictures for one instruction.
 */
const inFlight = new Set()

/**
 * Run the whole pipeline for one `.edit`.
 *
 * `reply` is the command's own reply function. Returns a result object; it never
 * throws, so the dispatcher cannot be taken down by a failed edit.
 */
async function reedit(conn, m, instruction, opts = {}) {
    const chat = String(m?.chat || '')
    const key = `${chat}:${opts.forceKind || 'auto'}`
    if (inFlight.has(key)) {
        log(`ignored duplicate .edit for ${chat}`)
        return { ok: false, code: 'duplicate' }
    }
    inFlight.add(key)

    const settings = aiConfig.getAiSettings()
    try {
        if (!instruction && !opts.allowEmpty) throw new EditError('empty_instruction')

        const media = await resolveMedia(m, { requireKind: opts.forceKind })
        log(`media: ${media.kind} ${media.mime} ${media.bytes}b`)

        const reference = await analyseReference(media)
        const built = await buildGenerationPrompt(instruction, reference, media, settings)
        log(`mode=${capabilities().imageToImage ? 'image-to-image' : 'text-to-image'} prompt="${built.prompt.slice(0, 90)}"`)

        const generated = await generate(built.prompt, media, { ratio: opts.ratio })
        const fetched = await fetchImage(generated.url)

        const output = decideOutput(instruction, media, opts.output)
        const result = { ok: true, kind: output, mode: generated.mode, bytes: fetched.buffer.length }

        if (readiness(conn) && typeof conn.sendMessage === 'function') {
            if (output === 'sticker') {
                try {
                    const sticker = await toSticker(fetched.buffer, fetched.mime)
                    await conn.sendMessage(chat, { sticker }, { quoted: m })
                    result.sent = 'sticker'
                    result.stickerBytes = sticker.length
                } catch (error) {
                    /*
                     * Conversion failed. The brief is explicit: only fall back to
                     * an ordinary image when conversion GENUINELY fails - and say
                     * so, rather than silently sending the wrong thing.
                     */
                    logErr('sticker conversion failed, sending as image', error)
                    const image = await toImage(fetched.buffer, fetched.mime)
                    await conn.sendMessage(chat, { image: image.buffer, mimetype: image.mime }, { quoted: m })
                    result.sent = 'image'
                    result.degraded = true
                    result.reason = 'sticker conversion failed'
                }
            } else {
                const image = await toImage(fetched.buffer, fetched.mime)
                await conn.sendMessage(chat, { image: image.buffer, mimetype: image.mime }, { quoted: m })
                result.sent = 'image'
            }
        } else {
            result.sent = 'none'
            result.reason = 'connection not open'
        }

        log(`done: ${result.sent} via ${result.mode} in ${built.language} (${result.bytes}b)`)
        return result
    } catch (error) {
        if (error instanceof EditError) {
            logErr(`failed [${error.code}]`, error.detail || error.message)
            return { ok: false, code: error.code, message: error.message, detail: error.detail }
        }
        logErr('unexpected failure', error)
        return { ok: false, code: 'unexpected', message: FAILURES.generate_failed }
    } finally {
        inFlight.delete(key)
    }
}

/* -------------------------------- status --------------------------------- */

function statusText() {
    const caps = capabilities()
    const key = apiKey()
    return [
        '*🎨 SMART RE-EDIT*',
        '',
        `Image API key: ${key ? 'configured' : 'NOT SET'}`,
        `Text-to-image (${IMAGE_ENDPOINT}): ${caps.textToImage ? 'available' : 'no key'}`,
        `Real image-to-image: ${caps.imageToImage ? caps.imageToImage : 'NOT AVAILABLE on this plan'}`,
        `Editing mode: ${caps.imageToImage ? 'pixel editing (reference image sent)' : 'reference-guided regeneration'}`,
        `In flight: ${inFlight.size}`
    ].join('\n') + (caps.imageToImage ? '' : '\n\nThe imageToImage endpoints return ENDPOINT_DISABLED, so the original is analysed and turned into a generation prompt instead of being edited pixel-for-pixel. Enable an imageToImage endpoint and this switches over automatically.')
}

module.exports = {
    reedit,
    resolveMedia,
    analyseReference,
    buildGenerationPrompt,
    generate,
    fetchImage,
    toSticker,
    toImage,
    decideOutput,
    probeCapabilities,
    capabilities,
    statusText,
    sniff,
    directLinksFrom,
    scrub,
    FAILURES,
    EditError,
    inFlightCount: () => inFlight.size
}
