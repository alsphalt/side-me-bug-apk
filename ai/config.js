'use strict'

/*
 * DARKNOTE AI — centralized configuration.
 *
 * Every AI setting lives here and nowhere else. Secrets are read from the
 * environment (a gitignored .env file) and are NEVER hardcoded in this file,
 * never written to logs, and never returned to a user. Precedence is:
 *
 *     process.env  >  config.json -> "ai"  >  built-in default
 *
 * Every toggle is readable and writable through the ai* commands, and persists
 * to config.json, so settings survive a restart or a reconnect.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ENV_PATH = path.join(ROOT, '.env')
const CONFIG_PATH = path.join(ROOT, 'config.json')

/*
 * MEASURED PROVIDER LIMIT (verified against the live API, not assumed).
 *
 * The gateway used by the ?prompt= family rejects anything above 302 characters
 * with HTTP 400 INVALID_PARAMETER. Verified on gpt-5, claude-opus-4.6 and
 * gemini-3.1-pro: a 303-character prompt is rejected by all three, and a
 * 312-character prompt by claude and gemini alike. It is a GATEWAY limit, so it
 * applies to every provider behind that form of the API.
 *
 * /api/ai/chat is the exception: a POST endpoint taking {"question"} that
 * accepted 924 characters in a binary search. That is why the router can serve
 * genuinely long prompts at all, and why the chatbot can widen its context
 * budget when the message is long.
 */
const PROVIDER_MAX_PROMPT = 302
const PROMPT_SAFETY_MARGIN = 6
const PROMPT_BUDGET = PROVIDER_MAX_PROMPT - PROMPT_SAFETY_MARGIN
const LONG_PROMPT_BUDGET = 880

const DEFAULT_BASE_URL = 'https://www.mzazi.shop'

/* ------------------------------ .env reader ------------------------------ */

let envLoaded = false

/** Dependency-free .env reader: KEY=VALUE, # comments, never overrides a real env var. */
function loadEnvOnce() {
    if (envLoaded) return
    envLoaded = true
    try {
        if (!fs.existsSync(ENV_PATH)) return
        for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
            const line = raw.trim()
            if (!line || line.startsWith('#')) continue
            const eq = line.indexOf('=')
            if (eq < 1) continue
            const key = line.slice(0, eq).trim()
            let value = line.slice(eq + 1).trim()
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
            }
            if (key && !(key in process.env)) process.env[key] = value
        }
    } catch (error) {
        console.error('[AI] .env could not be read:', error?.message || error)
    }
}

/* ------------------------------- config file ----------------------------- */

/*
 * config.json is read on EVERY message (the dispatcher asks whether the chatbot
 * is on). Re-reading it from disk each time would be wasteful in a busy group,
 * so the parsed copy is cached briefly. A command that writes a setting
 * invalidates the cache immediately, so toggles still apply instantly.
 */
const CONFIG_CACHE_MS = 1000
let configCache = { at: 0, value: null }

function readConfigFile() {
    const now = Date.now()
    if (configCache.value && now - configCache.at < CONFIG_CACHE_MS) return configCache.value
    try {
        delete require.cache[require.resolve(CONFIG_PATH)]
        configCache = { at: now, value: require(CONFIG_PATH) || {} }
    } catch (error) {
        console.error('[AI] config.json could not be read:', error?.message || error)
        configCache = { at: now, value: configCache.value || {} }
    }
    return configCache.value
}

function invalidateConfigCache() {
    configCache = { at: 0, value: null }
}

function aiSection() {
    const file = readConfigFile()
    return file?.ai && typeof file.ai === 'object' && !Array.isArray(file.ai) ? file.ai : {}
}

/* --------------------------------- helpers ------------------------------- */

function envRaw(key) {
    const value = process.env[key]
    return value === undefined || value === '' ? undefined : value
}

function pickBool(envKey, configValue, fallback) {
    const raw = envRaw(envKey)
    if (raw !== undefined) return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(raw).trim().toLowerCase())
    if (typeof configValue === 'boolean') return configValue
    return fallback
}

function pickNum(envKey, configValue, fallback, min, max) {
    const raw = envRaw(envKey)
    const candidate = raw !== undefined ? Number(raw) : Number(configValue)
    if (!Number.isFinite(candidate)) return fallback
    let value = candidate
    if (Number.isFinite(min)) value = Math.max(min, value)
    if (Number.isFinite(max)) value = Math.min(max, value)
    return value
}

function pickStr(envKey, configValue, fallback) {
    const raw = envRaw(envKey)
    if (raw !== undefined) return String(raw).trim()
    if (configValue !== undefined && configValue !== null && String(configValue).trim() !== '') return String(configValue).trim()
    return fallback
}

function pickList(envKey, configValue, fallback) {
    const raw = envRaw(envKey)
    if (raw !== undefined) return raw.split(',').map(s => s.trim()).filter(Boolean)
    if (Array.isArray(configValue)) return configValue.map(s => String(s).trim()).filter(Boolean)
    return fallback
}

/* ------------------------------ public API ------------------------------- */

/**
 * The single source of truth for every AI behaviour. Read fresh on each call so
 * a command that flips a toggle takes effect immediately with no restart.
 */
function getAiSettings() {
    loadEnvOnce()
    const ai = aiSection()

    // The key is only ever taken from the environment or the local config file.
    // There is deliberately no hardcoded fallback: a committed key is a leaked key.
    const apiKey = pickStr('MZAZI_API_KEY', undefined, '') || pickStr('AI_API_KEY', ai.apikey, '')

    return {
        /* --- master switches ------------------------------------------------ */
        chatbotEnabled: pickBool('AI_CHATBOT_ENABLED', ai.chatbotEnabled, false),
        dmEnabled: pickBool('AI_DM_ENABLED', ai.dmEnabled, true),
        groupEnabled: pickBool('AI_GROUP_ENABLED', ai.groupEnabled, true),
        typingEnabled: pickBool('AI_TYPING_ENABLED', ai.typingEnabled, true),
        reactionsEnabled: pickBool('AI_REACTIONS_ENABLED', ai.reactionsEnabled, false),
        memoryEnabled: pickBool('AI_MEMORY_ENABLED', ai.memoryEnabled, true),
        responseTimingEnabled: pickBool('AI_RESPONSE_TIMING_ENABLED', ai.responseTimingEnabled, true),
        languageEnabled: pickBool('AI_LANGUAGE_ENABLED', ai.languageEnabled, true),
        replyContextEnabled: pickBool('AI_REPLY_CONTEXT_ENABLED', ai.replyContextEnabled, true),
        combineEnabled: pickBool('AI_COMBINE_ENABLED', ai.combineEnabled, true),
        emojiEnabled: pickBool('AI_EMOJI_ENABLED', ai.emojiEnabled, true),
        nameEnabled: pickBool('AI_NAME_ENABLED', ai.nameEnabled, true),

        /* --- future modules: all off until a verified provider exists ------- */
        modules: {
            assistant: pickBool('AI_ASSISTANT_ENABLED', ai.modules?.assistant, false),
            moderation: pickBool('AI_MODERATION_ENABLED', ai.modules?.moderation, false),
            rewrite: pickBool('AI_REWRITE_ENABLED', ai.modules?.rewrite, false),
            translate: pickBool('AI_TRANSLATE_ENABLED', ai.modules?.translate, false),
            files: pickBool('AI_FILES_ENABLED', ai.modules?.files, false),
            web: pickBool('AI_WEB_ENABLED', ai.modules?.web, false),
            vision: pickBool('AI_VISION_ENABLED', ai.modules?.vision, false),
            image: pickBool('AI_IMAGE_ENABLED', ai.modules?.image, false),
            sticker: pickBool('AI_STICKER_ENABLED', ai.modules?.sticker, false),
            imagesearch: pickBool('AI_IMAGESEARCH_ENABLED', ai.modules?.imagesearch, false)
        },

        /* --- delays (milliseconds after conversion) ------------------------- */
        dmDelayMs: pickNum('AI_DM_DELAY', ai.dmDelay, 15, 0, 600) * 1000,
        shortDelayMs: pickNum('AI_SHORT_DELAY', ai.shortDelay, 4, 0, 600) * 1000,
        normalDelayMinMs: pickNum('AI_NORMAL_DELAY_MIN', ai.normalDelayMin, 4, 0, 600) * 1000,
        normalDelayMaxMs: pickNum('AI_NORMAL_DELAY_MAX', ai.normalDelayMax, 10, 0, 600) * 1000,
        longDelayMinMs: pickNum('AI_LONG_DELAY_MIN', ai.longDelayMin, 13, 0, 600) * 1000,
        longDelayMaxMs: pickNum('AI_LONG_DELAY_MAX', ai.longDelayMax, 20, 0, 600) * 1000,
        groupDelayMinMs: pickNum('AI_GROUP_DELAY_MIN', ai.groupDelayMin, 15, 0, 600) * 1000,
        groupDelayMaxMs: pickNum('AI_GROUP_DELAY_MAX', ai.groupDelayMax, 17, 0, 600) * 1000,

        /* --- provider / router ---------------------------------------------- */
        provider: pickStr('AI_PROVIDER', ai.provider, 'router'),
        baseUrl: pickStr('AI_BASE_URL', ai.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, ''),
        endpoint: pickStr('AI_ENDPOINT', ai.endpoint, `${DEFAULT_BASE_URL}/api/ai/gpt-5`),
        apiKey,
        timeoutMs: pickNum('AI_TIMEOUT_MS', ai.timeoutMs, 60000, 5000, 180000),
        retries: pickNum('AI_RETRIES', ai.retries, 2, 0, 4),
        maxFallbacks: pickNum('AI_MAX_FALLBACKS', ai.maxFallbacks, 2, 0, 4),
        maxAttempts: pickNum('AI_MAX_ATTEMPTS', ai.maxAttempts, 3, 1, 5),
        disabledProviders: pickList('AI_DISABLED_PROVIDERS', ai.disabledProviders, []),
        providers: ai.providers && typeof ai.providers === 'object' ? ai.providers : {},

        /* --- provider health / cooldown ------------------------------------- */
        healthFailureThreshold: pickNum('AI_HEALTH_FAILURE_THRESHOLD', ai.healthFailureThreshold, 3, 1, 20),
        healthBaseCooldownMs: pickNum('AI_HEALTH_BASE_COOLDOWN', ai.healthBaseCooldownMs, 60000, 1000, 3600000),
        healthMaxCooldownMs: pickNum('AI_HEALTH_MAX_COOLDOWN', ai.healthMaxCooldownMs, 900000, 1000, 86400000),

        /* --- prompt budgets -------------------------------------------------- */
        promptBudget: PROMPT_BUDGET,
        longPromptBudget: pickNum('AI_LONG_PROMPT_BUDGET', ai.longPromptBudget, LONG_PROMPT_BUDGET, 100, 1200),
        providerMaxPrompt: PROVIDER_MAX_PROMPT,

        /* --- limits / abuse protection --------------------------------------- */
        maxMessageChars: pickNum('AI_MAX_MESSAGE_CHARS', ai.maxMessageChars, 4000, 80, 20000),
        maxContextTurns: pickNum('AI_MAX_CONTEXT_TURNS', ai.maxContextTurns, 6, 0, 40),
        maxReplyChars: pickNum('AI_MAX_REPLY_CHARS', ai.maxReplyChars, 3500, 200, 20000),
        userPerMinute: pickNum('AI_RATE_USER_PER_MIN', ai.rateUserPerMinute, 6, 1, 120),
        groupPerMinute: pickNum('AI_RATE_GROUP_PER_MIN', ai.rateGroupPerMinute, 12, 1, 240),
        batchWindowMs: pickNum('AI_BATCH_WINDOW_MS', ai.batchWindowMs, 2500, 0, 15000),
        firstTurnDmDelay: pickBool('AI_FIRST_TURN_DELAY', ai.firstTurnDelay, true),
        maxSessions: pickNum('AI_MAX_SESSIONS', ai.maxSessions, 800, 10, 20000),
        sessionTtlDays: pickNum('AI_SESSION_TTL_DAYS', ai.sessionTtlDays, 30, 1, 3650),

        /*
         * OWNER delays are shorter on purpose. The owner runs the bot and is
         * usually mid-task, so a simple reply must never take minutes:
         * short 4-5s, normal 5-10s, long 10-20s.
         */
        ownerShortDelayMs: pickNum('AI_OWNER_SHORT_DELAY', ai.ownerShortDelay, 4, 0, 600) * 1000,
        ownerNormalDelayMinMs: pickNum('AI_OWNER_NORMAL_DELAY_MIN', ai.ownerNormalDelayMin, 5, 0, 600) * 1000,
        ownerNormalDelayMaxMs: pickNum('AI_OWNER_NORMAL_DELAY_MAX', ai.ownerNormalDelayMax, 10, 0, 600) * 1000,
        ownerLongDelayMinMs: pickNum('AI_OWNER_LONG_DELAY_MIN', ai.ownerLongDelayMin, 10, 0, 600) * 1000,
        ownerLongDelayMaxMs: pickNum('AI_OWNER_LONG_DELAY_MAX', ai.ownerLongDelayMax, 20, 0, 600) * 1000,

        /* --- public chatbot behaviour ---------------------------------------- */
        // How long after the AI's OWN message it may continue the conversation
        // if the person goes quiet. NOT the reply delay.
        chatbotDelayMode: pickStr('AI_CHATBOT_DELAY_MODE', ai.chatbotDelayMode, 'short'),
        chatbotDelayShortMs: pickNum('AI_CHATBOT_DELAY_SHORT', ai.chatbotDelayShort, 270, 30, 3600) * 1000,
        chatbotDelayLongMs: pickNum('AI_CHATBOT_DELAY_LONG', ai.chatbotDelayLong, 630, 30, 3600) * 1000,
        // How long to wait before replying to a public user. The shorter end of
        // the range is used for short messages, the longer end for complex ones.
        replyDelayMode: pickStr('AI_REPLY_DELAY_MODE', ai.replyDelayMode, 'short'),
        replyDelayShortMinMs: pickNum('AI_REPLY_SHORT_MIN', ai.replyDelayShortMin, 5, 0, 600) * 1000,
        replyDelayShortMaxMs: pickNum('AI_REPLY_SHORT_MAX', ai.replyDelayShortMax, 10, 0, 600) * 1000,
        replyDelayLongMinMs: pickNum('AI_REPLY_LONG_MIN', ai.replyDelayLongMin, 15, 0, 600) * 1000,
        replyDelayLongMaxMs: pickNum('AI_REPLY_LONG_MAX', ai.replyDelayLongMax, 20, 0, 600) * 1000,
        // After this long with no reply, a returning user gets the topic resumed.
        longSilenceMs: pickNum('AI_LONG_SILENCE', ai.longSilenceMinutes, 90, 5, 2880) * 60 * 1000,
        followUpMaxPerSilence: pickNum('AI_FOLLOWUP_MAX', ai.followUpMaxPerSilence, 1, 0, 3),

        /*
         * Status gets three INDEPENDENT controls. They are read from the existing
         * statusAutomation block so the .avs/.als/.ars commands keep working, and
         * the clearer .statusview/.statuslike/.statusreact commands write to the
         * same three flags rather than starting a competing system.
         */
        // NOTE: statusAutomation lives at the TOP LEVEL of config.json (it is the
        // existing DARKNOTE block the .avs/.als/.ars commands write to), NOT
        // inside the "ai" section. Reading it from `ai` made all three flags look
        // permanently off.
        statusView: readConfigFile()?.statusAutomation?.avs?.enabled === true,
        statusLike: readConfigFile()?.statusAutomation?.als?.enabled === true,
        statusReact: readConfigFile()?.statusAutomation?.ars?.enabled === true,
        statusReactEmoji: pickStr('AI_STATUS_REACT_EMOJI', readConfigFile()?.statusAutomation?.ars?.emoji, '😊'),

        /* --- conversation state / continuation -------------------------------- */
        // A short acknowledgement like "ok" does not always need a written reply.
        shortAckReaction: pickBool('AI_SHORT_ACK_REACTION', ai.shortAckReaction, true),
        shortAckSilence: pickBool('AI_SHORT_ACK_SILENCE', ai.shortAckSilence, true),

        /* --- conversation intelligence --------------------------------------- */
        repeatSimilarityThreshold: pickNum('AI_REPEAT_SIMILARITY', ai.repeatSimilarityThreshold, 0.72, 0.3, 1),
        summaryMaxChars: pickNum('AI_SUMMARY_MAX_CHARS', ai.summaryMaxChars, 120, 20, 600),

        /* --- presence ---------------------------------------------------------- */
        onlineCycleEnabled: ai.onlineCycleEnabled === true,
        onlineCycleMs: pickNum('AI_ONLINE_CYCLE_MS', ai.onlineCycleMs, 0, 0, 86400000),

        /* --- abuse safety ------------------------------------------------------ */
        abuseSafetyEnabled: pickBool('AI_ABUSE_SAFETY_ENABLED', ai.abuseSafetyEnabled, true)
    }
}

/** True when the chatbot has everything it needs to attempt a reply. */
function isUsable() {
    const s = getAiSettings()
    return Boolean(s.chatbotEnabled && s.apiKey && s.baseUrl)
}

/** Safe, non-secret description used by the status command and logs. */
function describe() {
    const s = getAiSettings()
    return {
        baseUrl: s.baseUrl,
        apiKey: s.apiKey ? `set (${String(s.apiKey).slice(0, 8)}…, ${String(s.apiKey).length} chars)` : 'MISSING',
        chatbot: s.chatbotEnabled ? 'ON' : 'OFF',
        dm: s.dmEnabled ? 'on' : 'off',
        group: s.groupEnabled ? 'on' : 'off',
        typing: s.typingEnabled ? 'on' : 'off',
        reactions: s.reactionsEnabled ? 'on' : 'off',
        memory: s.memoryEnabled ? 'on' : 'off',
        timing: s.responseTimingEnabled ? 'on' : 'off',
        language: s.languageEnabled ? 'on' : 'off',
        replyContext: s.replyContextEnabled ? 'on' : 'off',
        combine: s.combineEnabled ? 'on' : 'off',
        emoji: s.emojiEnabled ? 'on' : 'off',
        name: s.nameEnabled ? 'on' : 'off',
        promptBudget: s.promptBudget,
        longPromptBudget: s.longPromptBudget
    }
}

/** Persist a single toggle back into config.json -> "ai". Used by the commands. */
function writeAiSetting(key, value) {
    const file = readConfigFile()
    if (!file.ai || typeof file.ai !== 'object' || Array.isArray(file.ai)) file.ai = {}
    file.ai[key] = value
    const tmp = `${CONFIG_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2))
    fs.renameSync(tmp, CONFIG_PATH)
    invalidateConfigCache()
    return true
}

module.exports = {
    getAiSettings,
    isUsable,
    describe,
    writeAiSetting,
    readConfigFile,
    invalidateConfigCache,
    PROVIDER_MAX_PROMPT,
    PROMPT_BUDGET,
    LONG_PROMPT_BUDGET,
    DEFAULT_BASE_URL,
    ROOT
}
