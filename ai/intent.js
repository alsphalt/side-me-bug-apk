'use strict'

/*
 * DARKNOTE AI — INTENT ROUTER
 * ---------------------------
 * The layer that makes DARKNOTE feel like ONE assistant instead of a bag of
 * commands. It takes a natural-language request and decides which AI TOOL should
 * answer it:
 *
 *   "darknote create a sticker of a black wolf"   -> sticker generation
 *   "darknote generate an image of a dark city"   -> image generation
 *   "darknote describe this"  (quoted image)      -> vision  (unavailable, refuses)
 *   "darknote translate this to Swahili"          -> translation
 *   "darknote summarize this"                     -> summarisation
 *   anything else                                 -> plain conversation
 *
 * WHERE IT SITS
 *
 *   messages.upsert -> command dispatcher -> ai/index.handle()
 *                                              |-- autohuman  (if on)
 *                                              |-- INTENT     <- this file
 *                                              '-- chatbot    (conversation)
 *
 * It is reached ONLY from the single existing AI entry point, so it can never
 * produce a second reply: either it handles the message and returns, or it
 * declines and the chatbot answers. There is no listener here.
 *
 * ¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬
 * CAPABILITY HONESTY - MEASURED AGAINST THE LIVE API, NOT ASSUMED
 *
 *   image generation   WORKS   /api/image/animagine returns a real image.
 *                              Integrated in lib/image-edit.js.
 *   sticker generation WORKS   local sharp + lib/StickerMaker writeExif.
 *   translation        WORKS   a text model translates; /api/tools/translate
 *                              is also Live but is not needed.
 *   summarisation      WORKS   text model.
 *
 *   image vision       NOT AVAILABLE
 *        No vision endpoint exists on this API (the only image-adjacent tool is
 *        /api/tools/font-analyzer), and every chat provider declares
 *        imageUnderstanding: false. ai/modules/vision.js already documents that
 *        an apparent success was hallucination from the filename and did not
 *        reproduce.
 *
 *   sticker vision     NOT AVAILABLE   same reason.
 *
 *   voice transcription NOT AVAILABLE
 *        /api/ai/whisper, /api/tools/transcribe and /api/tools/speechma all
 *        report "Not configured" on this plan.
 *
 * Those three REFUSE with a plain explanation. They never invent a description
 * and never claim to have heard an audio file.
 */

const config = require('./config')
const provider = require('./provider')
const imageEdit = require('../lib/image-edit.js')
const display = require('../lib/display.js')

/* ------------------------------- patterns -------------------------------- */

/*
 * Anchored imperatives only.
 *
 * A loose match on "picture" would hijack ordinary conversation - "I made a
 * picture of my dog yesterday" is not a request. Requiring the message to OPEN
 * with a command verb makes an accidental match very unlikely, which matters
 * because a false positive here replaces a normal reply with an image.
 */
const IMPERATIVE = '(?:please\\s+|kindly\\s+)?(create|make|generate|draw|design|paint|render|produce|tengeneza|chora|unda)'

const PATTERNS = [
    // "make an image of ...", "generate a logo for ...", "draw me a ..."
    { intent: 'image', re: new RegExp(`^${IMPERATIVE}\\b[\\s\\S]{0,60}\\b(image|picture|photo|logo|poster|wallpaper|art|artwork|illustration|painting|picha|picha ya)\\b`, 'i') },
    // "create a sticker of ...", "make me a sticker"
    { intent: 'sticker', re: new RegExp(`^${IMPERATIVE}\\b[\\s\\S]{0,60}\\b(sticker|stiker|sticka)\\b`, 'i') },
    // "turn this into a sticker", "convert this to a sticker"
    { intent: 'sticker', re: /^(please\s+)?(turn|convert|change|fanya|badilisha|geuza)\b[\s\S]{0,40}\b(sticker|stiker)\b/i },
    // "make this an image" from a sticker
    { intent: 'image', re: /^(please\s+)?(turn|convert|change|make|fanya|badilisha)\b[\s\S]{0,30}\b(this|hii|photo|picture|image|picha)\b[\s\S]{0,20}\b(into|to|as|iwe)\b[\s\S]{0,20}\b(image|photo|picture|picha)\b/i },
    // vision: "what is in this", "describe this", "read this picture"
    { intent: 'vision', re: /^(please\s+)?(what('| i)?s?\s+(in|on)|describe|read|analyse|analyze|explain|look at|tell me about|eleza|soma|angalia|nini)\b/i },
    // translation
    { intent: 'translate', re: /^(please\s+)?(translate|tafsiri|badilisha lugha)\b/i },
    // summarise / shorten
    { intent: 'summarize', re: /^(please\s+)?(summarize|summarise|sum up|shorten|tl;?dr|fupisha|muhtasari)\b/i }
]

/*
 * A vision request must actually be about MEDIA.
 *
 * A bare demonstrative is not enough: "describe how this command works" contains
 * "this" but is an ordinary question. So a vision request needs either
 *
 *   - a media NOUN ("describe this sticker", "read the image"), or
 *   - a demonstrative standing ALONE as the object ("describe this", "what is in
 *     that?").
 *
 * The second form is why the check is anchored to the end of the sentence.
 */
const MEDIA_NOUN = /\b(image|photo|picture|sticker|stiker|picha|screenshot|selfie|meme)\b/i
const BARE_DEMONSTRATIVE = /\b(this|that|it|these|those|hii|hiyo)\s*[?.!]*$/i

const isAboutMedia = text => MEDIA_NOUN.test(text) || BARE_DEMONSTRATIVE.test(String(text || '').trim())

/* ------------------------------ classification --------------------------- */

/**
 * Work out what the user wants.
 *
 * @returns {{intent: string, prompt: string, reason: string}}
 *   intent is 'image' | 'sticker' | 'vision' | 'translate' | 'summarize' | 'chat'
 */
function classify(text) {
    /*
     * The "darknote" trigger is stripped HERE, not only in route().
     *
     * Otherwise classify("darknote create a sticker of a wolf") sees a sentence
     * starting with "darknote" and matches nothing, because every pattern is
     * anchored to an imperative verb. Stripping here makes classify correct on
     * raw text on its own, and stripping twice is a no-op.
     */
    const raw = display.clean(String(text || '').replace(/^darknote\b[,:]?\s*/i, ''), 400)
    if (!raw) return { intent: 'chat', prompt: '', reason: 'empty' }

    for (const pattern of PATTERNS) {
        if (pattern.re.test(raw)) {
            // A vision request only applies to media. Without media the sentence
            // is a normal question ("describe how this works").
            if (pattern.intent === 'vision' && !isAboutMedia(raw)) {
                return { intent: 'chat', prompt: raw, reason: 'vision-without-media' }
            }
            return { intent: pattern.intent, prompt: raw, reason: `matched:${pattern.intent}` }
        }
    }
    return { intent: 'chat', prompt: raw, reason: 'no-tool-match' }
}

/*
 * Strip the request framing so the backend gets a clean visual prompt.
 *
 * "darknote create a sticker of a black wolf" -> "a black wolf"
 *
 * Only the leading request clause is removed. Everything after is kept, because
 * it is the part that describes the picture.
 */
/**
 * Pull the visual subject out of a request.
 *
 * @param {string} text          the request, with the trigger already stripped
 * @param {string} kind          'image' | 'sticker'
 *
 * Each step TRIMS, because every removal leaves a leading space and the next
 * strip is anchored to the start of the string. Without that the second step
 * never fires and the whole chain silently returns the input unchanged - which
 * is exactly the bug this replaces.
 *
 * IMAGE keeps the media noun ("generate a logo for DARKNOTE" -> "a logo for
 * DARKNOTE"), because "a logo" IS the subject and dropping it would lose what
 * kind of picture was asked for. STICKER drops the word "sticker", because the
 * medium is already decided by the intent and what remains is the subject
 * ("create a sticker of a black wolf" -> "a black wolf").
 */
function extractPrompt(text, kind = 'image') {
    let value = String(text || '').trim()
    const step = (re, replacement = '') => { value = value.replace(re, replacement).trim() }

    // "turn this into a sticker" carries no subject of its own: the subject is
    // the quoted media, which the caller handles.
    step(/^(please\s+|kindly\s+)?(create|make|generate|draw|design|paint|render|produce|tengeneza|chora|unda)\b/i)
    step(/^(me|for me)\b/i)
    step(/^(a|an|the)\s+/i)
    if (kind === 'sticker') {
        step(/^(sticker|stiker|sticka)\b/i)
        step(/^(of|for|showing|with|ya|wa)\b/i)
    } else {
        // Only strip a leading media noun when it is NOT the subject, i.e. when
        // it is followed by a preposition ("an image OF a city"). "a logo for X"
        // keeps "logo".
        value = value.replace(/^(image|picture|photo|picha)\s+(of|showing|with)\b/i, (_m, _n, prep) => `${prep} `).trim()
    }
    step(/\b(as|into|to)\s+a\s+(sticker|stiker)\b/i)
    step(/^(of|for|showing|with|ya|wa)\b/i)

    return value.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/* -------------------------------- helpers -------------------------------- */

const KIND_LABEL = { image: 'image', sticker: 'sticker' }

const FAILURE_TEXT = {
    generate_failed: '❌ I could not generate that picture — the image service is busy or unavailable. Please try again in a moment.',
    rate_limited: '❌ The image service is rate limited right now. Please try again in a minute.',
    no_image_returned: "❌ The image service didn't return a picture. Please try again.",
    empty_instruction: '❌ Tell me what to make, e.g. "darknote create a sticker of a black wolf".',
    sticker_failed: '❌ I made the picture but could not convert it to a sticker.',
    not_configured: '❌ The AI image service is not configured.'
}

function failure(code, detail) {
    if (detail) console.error(`[INTENT] ${code}: ${imageEdit.scrub(detail)}`)
    return { ok: false, message: FAILURE_TEXT[code] || FAILURE_TEXT.generate_failed }
}

/** Honest refusals. Nothing here pretends a capability exists. */
const UNAVAILABLE = {
    vision: [
        '❌ I can\'t read images. There is no vision model on this plan — the API exposes no image-understanding endpoint, and every chat model here is text-only.',
        '',
        'I will not guess at what is in a picture. If you tell me what it shows, I can work with that.'
    ].join('\n'),
    voice: [
        '❌ I can\'t listen to voice notes. Transcription is not available on this plan — whisper and the other transcription endpoints all report "Not configured".',
        '',
        'Send the text instead and I will answer it.'
    ].join('\n')
}

/** Ask the text model to rewrite a request into a clean image prompt. */
async function enrichPrompt(prompt, wantSticker, settings) {
    try {
        const directive = [
            'Turn this request into ONE short English image-generation prompt.',
            'Describe only what should be visible. No preamble, no quotes, no explanation.',
            wantSticker ? 'The subject must read clearly as a flat cartoon sticker character on a plain background.' : '',
            `Request: ${prompt}`
        ].filter(Boolean).join(' ')

        const result = await provider.ask(directive, settings, { originalMessage: prompt })
        if (result?.ok && result.answer) {
            const clean = String(result.answer).replace(/^```[\s\S]*?```$/g, '').replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0].trim()
            if (clean) return clean.slice(0, 300)
        }
        console.log(`[INTENT] prompt enrichment unavailable (${result?.code || 'unknown'}); using the raw request`)
    } catch (error) {
        console.error('[INTENT] prompt enrichment threw:', error?.message || error)
    }
    // A genuine fallback, not a fake success: the raw request still describes
    // the picture well enough to generate from.
    return prompt
}

/* ------------------------------- generation ------------------------------ */

/**
 * Generate a picture and deliver it as an image or a real sticker.
 *
 * Reuses lib/image-edit.js wholesale: it already handles the verified generation
 * call, the CDN's HTML-preview redirect quirk, magic-byte type detection, retries
 * and the WebP sticker conversion. Duplicating any of that here would be a second
 * implementation to keep in sync.
 */
async function deliver(conn, m, prompt, kind) {
    const settings = config.getAiSettings()
    const chat = String(m.chat)

    if (!imageEdit.capabilities().textToImage) return failure('not_configured')

    const enriched = await enrichPrompt(prompt, kind === 'sticker', settings)
    console.log(`[INTENT] generating ${kind} — prompt="${enriched.slice(0, 80)}"`)

    let generated
    try {
        // The media argument is unused on the text-to-image path; a minimal
        // stand-in keeps the shared signature.
        generated = await imageEdit.generate(enriched, { kind: 'image', buffer: Buffer.alloc(0) })
    } catch (error) {
        return failure(error?.code || 'generate_failed', error?.detail || error?.message)
    }

    let fetched
    try {
        fetched = await imageEdit.fetchImage(generated.url)
    } catch (error) {
        return failure(error?.code || 'no_image_returned', error?.detail || error?.message)
    }

    if (!fetched?.buffer?.length) return failure('no_image_returned')

    if (kind === 'sticker') {
        try {
            const sticker = await imageEdit.toSticker(fetched.buffer, fetched.mime)
            await conn.sendMessage(chat, { sticker }, { quoted: m })
            return { ok: true, kind: 'sticker', bytes: sticker.length }
        } catch (error) {
            /*
             * Conversion failed. The brief is explicit that a sticker must not be
             * silently sent as an ordinary image, so the real reason is logged and
             * the user is told.
             */
            console.error('[INTENT] sticker conversion failed:', error?.detail || error?.message)
            return failure('sticker_failed', error?.detail || error?.message)
        }
    }

    const image = await imageEdit.toImage(fetched.buffer, fetched.mime)
    await conn.sendMessage(chat, { image: image.buffer, mimetype: image.mime }, { quoted: m })
    return { ok: true, kind: 'image', bytes: image.buffer.length }
}

/* --------------------------------- routing ------------------------------- */

/** Does this message ask for an AI tool? Exported for tests and for the hook. */
function isToolRequest(text) {
    return classify(text).intent !== 'chat'
}

/**
 * Try to handle a message as an AI tool request.
 *
 * @returns {{handled: boolean, intent?: string, ok?: boolean, reason?: string}}
 *   `handled: false` means "not mine" and the chatbot should answer instead.
 */
async function route(conn, m, context = {}) {
    const text = String(m?.text || '').trim()
    if (!text) return { handled: false, reason: 'no-text' }
    if (m?.fromMe) return { handled: false, reason: 'from-me' }

    /*
     * ELIGIBILITY - the request must actually be addressed to the bot.
     *
     * Without this, any message that happens to start with "make an image..."
     * would be hijacked and answered with a generated picture instead of being
     * treated as conversation. Two things make a request eligible:
     *
     *   "darknote ..."  an EXPLICIT trigger. Honoured regardless of the chatbot
     *                   switch, because the brief says direct requests keep
     *                   working while `.chatbot off`.
     *   chatbot ON      then a clear tool imperative may be acted on by itself.
     */
    const directed = /^darknote\b/i.test(text)
    const chatbotOn = Boolean(config.getAiSettings().chatbotEnabled)
    const mentioned = Boolean(m?.__darknoteMentioned)

    if (!directed && !chatbotOn && !mentioned) {
        return { handled: false, reason: 'not-directed' }
    }

    // A quoted message is the "this" that request phrasing refers to.
    const quoted = m?.quoted
    const quotedKind = quoted ? (/(sticker)/i.test(String(quoted.mtype || '')) ? 'sticker' : /image/i.test(String(quoted.mtype || '')) ? 'image' : '') : ''

    // Strip the "darknote" trigger before classifying, so "darknote create a
    // sticker of a wolf" is judged on "create a sticker of a wolf".
    const body = text.replace(/^darknote\b[,:]?\s*/i, '').trim()

    const verdict = classify(body)
    if (verdict.intent === 'chat') return { handled: false, reason: verdict.reason }
    verdict.prompt = body

    console.log(`[INTENT] ${verdict.intent}${quotedKind ? ` (quoted ${quotedKind})` : ''} — ${text.slice(0, 60)}`)

    try {
        switch (verdict.intent) {
            case 'vision': {
                // Honest refusal. The quoted media is detected so the reason is
                // specific, but nothing is invented about its contents.
                const what = quotedKind ? `that ${quotedKind}` : 'images'
                await conn.sendMessage(m.chat, { text: `${UNAVAILABLE.vision}\n\n(I did see that you replied to ${what}.)` }, { quoted: m })
                return { handled: true, intent: 'vision', ok: false, reason: 'vision-unavailable' }
            }

            case 'translate': {
                const source = quoted?.text || quoted?.caption || ''
                const result = await provider.ask(
                    `Translate the following into English. Reply with the translation only, no preamble.\n\n${text}${source ? `\n\nQuoted text to translate:\n${source}` : ''}`,
                    config.getAiSettings(),
                    { originalMessage: text }
                )
                if (!result?.ok || !result.answer) {
                    await conn.sendMessage(m.chat, { text: '❌ I could not translate that right now.' }, { quoted: m })
                    return { handled: true, intent: 'translate', ok: false }
                }
                await conn.sendMessage(m.chat, { text: String(result.answer).trim() }, { quoted: m })
                return { handled: true, intent: 'translate', ok: true }
            }

            case 'summarize': {
                const source = quoted?.text || quoted?.caption || ''
                const body = source || text.replace(/^(please\s+)?(summarize|summarise|sum up|shorten|fupisha|muhtasari)\b[:\s]*/i, '')
                if (!body) {
                    await conn.sendMessage(m.chat, { text: '❌ Reply to the message you want summarised.' }, { quoted: m })
                    return { handled: true, intent: 'summarize', ok: false, reason: 'no-source' }
                }
                const result = await provider.ask(
                    `Summarise this concisely, keeping the meaning. Reply with the summary only.\n\n${body}`,
                    config.getAiSettings(),
                    { originalMessage: body }
                )
                if (!result?.ok || !result.answer) {
                    await conn.sendMessage(m.chat, { text: '❌ I could not summarise that right now.' }, { quoted: m })
                    return { handled: true, intent: 'summarize', ok: false }
                }
                await conn.sendMessage(m.chat, { text: String(result.answer).trim() }, { quoted: m })
                return { handled: true, intent: 'summarize', ok: true }
            }

            case 'sticker': {
                // Replying to media -> convert THAT media, not a new generation.
                if (quotedKind) {
                    const result = await imageEdit.reedit(conn, m, text, { output: 'sticker' })
                    if (result.ok) return { handled: true, intent: 'sticker', ok: true, source: 'quoted' }
                    if (result.code === 'duplicate') return { handled: true, intent: 'sticker', ok: true, reason: 'duplicate' }
                    await conn.sendMessage(m.chat, { text: `❌ ${result.message}` }, { quoted: m })
                    return { handled: true, intent: 'sticker', ok: false, reason: result.code }
                }
                /*
                 * `body` (trigger already stripped) and kind 'sticker'.
                 *
                 * Using the raw `text` here meant the trigger stayed in the prompt
                 * and the kind defaulted to 'image', so "darknote make a sticker"
                 * - which has NO subject - produced a non-empty prompt and
                 * generated a picture from the word "darknote" instead of asking
                 * what to draw.
                 */
                const prompt = extractPrompt(body, 'sticker')
                if (!prompt) {
                    await conn.sendMessage(m.chat, { text: FAILURE_TEXT.empty_instruction }, { quoted: m })
                    return { handled: true, intent: 'sticker', ok: false, reason: 'no-prompt' }
                }
                const outcome = await deliver(conn, m, prompt, 'sticker')
                if (!outcome.ok) await conn.sendMessage(m.chat, { text: outcome.message }, { quoted: m })
                return { handled: true, intent: 'sticker', ok: outcome.ok, reason: outcome.message }
            }

            case 'image': {
                if (quotedKind) {
                    const result = await imageEdit.reedit(conn, m, text, { output: 'image' })
                    if (result.ok) return { handled: true, intent: 'image', ok: true, source: 'quoted' }
                    if (result.code === 'duplicate') return { handled: true, intent: 'image', ok: true, reason: 'duplicate' }
                    await conn.sendMessage(m.chat, { text: `❌ ${result.message}` }, { quoted: m })
                    return { handled: true, intent: 'image', ok: false, reason: result.code }
                }
                const prompt = extractPrompt(body, 'image')
                if (!prompt) {
                    await conn.sendMessage(m.chat, { text: FAILURE_TEXT.empty_instruction }, { quoted: m })
                    return { handled: true, intent: 'image', ok: false, reason: 'no-prompt' }
                }
                const outcome = await deliver(conn, m, prompt, 'image')
                if (!outcome.ok) await conn.sendMessage(m.chat, { text: outcome.message }, { quoted: m })
                return { handled: true, intent: 'image', ok: outcome.ok, reason: outcome.message }
            }

            default:
                return { handled: false, reason: 'unrouted' }
        }
    } catch (error) {
        console.error('[INTENT] routing failed:', error?.stack || error)
        return { handled: true, intent: verdict.intent, ok: false, reason: 'exception' }
    }
}

/** Panel text for `.aistatus`-style reporting. */
function statusText() {
    const caps = imageEdit.capabilities()
    return [
        '*🧠 AI INTENT ROUTER*',
        '',
        `Image generation : ${caps.textToImage ? 'WORKING' : 'not configured'}`,
        `Sticker creation : WORKING (local WebP conversion)`,
        `Translation      : WORKING (text model)`,
        `Summarisation    : WORKING (text model)`,
        `Image vision     : NOT AVAILABLE — no vision endpoint on this API`,
        `Sticker vision   : NOT AVAILABLE — same`,
        `Voice notes      : NOT AVAILABLE — transcription endpoints report "Not configured"`
    ].join('\n')
}

module.exports = {
    classify,
    extractPrompt,
    isToolRequest,
    route,
    statusText,
    deliver,
    UNAVAILABLE,
    PATTERNS
}
