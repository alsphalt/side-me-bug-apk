'use strict'

/*
 * DARKNOTE AI — service facade.
 *
 * The rest of the bot talks to the AI only through this file. Adding a future
 * module means adding a file under ai/modules/ and registering it — never
 * editing the WhatsApp message handler.
 *
 *   ai/config.js       centralized settings + secrets
 *   ai/transport.js    HTTP
 *   ai/providers.js    THE REGISTRY - one object per provider
 *   ai/health.js       provider health, cooldown, recovery
 *   ai/objectives.js   what the user actually wants
 *   ai/router.js       ranking + fallback + one normalised answer
 *   ai/provider.js     compatibility facade over the router
 *   ai/language.js     English / Kiswahili / Sheng / mixed detection
 *   ai/personality.js  persona + prompt assembly inside the budget
 *   ai/timing.js       human-like delay windows
 *   ai/memory.js       isolated per-chat memory, summary, repeat detection
 *   ai/ratelimit.js    limits, in-flight dedupe, cancellation
 *   ai/reactions.js    optional, heuristic, OFF by default
 *   ai/chatbot.js      the orchestrator and single reply path
 *   ai/modules/        the ten future modules, all inert
 */

const config = require('./config')
const provider = require('./provider')
const chatbot = require('./chatbot')
const autohuman = require('./autohuman')
const memory = require('./memory')
const language = require('./language')
const timing = require('./timing')
const personality = require('./personality')
const ratelimit = require('./ratelimit')
const reactions = require('./reactions')
const objectives = require('./objectives')
const health = require('./health')
const providers = require('./providers')
const aiModules = require('./modules')
const owner = require('./owner')
const presence = require('./presence')
const grouptimer = require('./grouptimer')
const scheduler = require('./scheduler')
const convState = require('./state')
const safety = require('./safety')

const fs = require('fs')
const path = require('path')

// Register every provider so the status panel can show UNVERIFIED ones.
health.register(providers.providerIds())

const onOff = value => (value ? 'ON' : 'OFF')

/**
 * Status lives under statusAutomation.{avs,als,ars}.enabled so the existing
 * .avs/.als/.ars commands keep working. These clearer commands write the SAME
 * three flags rather than starting a second, competing system.
 *   statusview  -> avs  (view)
 *   statuslike  -> als  (like, the heart)
 *   statusreact -> ars  (react with the configured emoji)
 */
function writeStatusFlag(name, enabled) {
    const file = config.readConfigFile()
    if (!file.statusAutomation || typeof file.statusAutomation !== 'object') file.statusAutomation = {}
    const current = file.statusAutomation[name] || {}
    file.statusAutomation[name] = { ...current, enabled }
    const target = path.join(config.ROOT, 'config.json')
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2))
    fs.renameSync(tmp, target)
    config.invalidateConfigCache()
    return true
}

/** Public reply-delay presets offered on the setup card. */
const REPLY_DELAY_PRESETS = { short: '5–10 sec', long: '15–20 sec' }
const CHATBOT_DELAY_PRESETS = { short: '4–5 min', long: '10–11 min' }

function presetLabel(kind, mode) {
    const table = kind === 'chatbot' ? CHATBOT_DELAY_PRESETS : REPLY_DELAY_PRESETS
    return table[mode] || mode
}

/** One option line, marking the one currently selected. */
function optionLine(label, value, selected) {
    return `${selected ? '✅' : '▫️'} ${label}`
}

/**
 * The setup panel shown when the public chatbot is switched on.
 * Both choices are always listed so the delay is a deliberate pick rather than
 * whatever happened to be left over. Each line maps 1:1 to a button on the
 * card, and the same two keys are writable by .chatbotdelay / .replydelay.
 */
function setupSummary(settings) {
    return [
        '*⚙️ DARKNOTE AI SETUP*',
        '',
        '1️⃣ *CHATBOT DELAY*',
        '_After the AI replies, how long it waits before it may continue the conversation itself if the person goes quiet._',
        optionLine('4–5 min', 'short', settings.chatbotDelayMode !== 'long'),
        optionLine('10–11 min', 'long', settings.chatbotDelayMode === 'long'),
        '',
        '2️⃣ *REPLY DELAY*',
        '_How long before replying to a user. Short messages use the fast end, long or complex ones the slow end._',
        optionLine('5–10 sec', 'short', settings.replyDelayMode !== 'long'),
        optionLine('15–20 sec', 'long', settings.replyDelayMode === 'long'),
        '',
        `Selected → chatbot *${presetLabel('chatbot', settings.chatbotDelayMode)}* · reply *${presetLabel('reply', settings.replyDelayMode)}*`,
        '',
        'Tap an option, or use:',
        '• .chatbotdelay 4-5min | 10-11min',
        '• .replydelay 5-10sec | 15-20sec'
    ].join('\n')
}

/* ------------------------------ toggle table ----------------------------- */

/*
 * Every persistent switch. `.ai on|off` is the master. `.aimemory` with no
 * argument still shows what is remembered, so the older behaviour is preserved.
 */
const TOGGLES = {
    ai: { key: 'chatbotEnabled', label: 'AI master' },
    aichat: { key: 'chatbotEnabled', label: 'Chatbot' },
    aidm: { key: 'dmEnabled', label: 'DM replies' },
    aigroup: { key: 'groupEnabled', label: 'Group replies (mention only)' },
    aityping: { key: 'typingEnabled', label: 'Typing indicator' },
    aireact: { key: 'reactionsEnabled', label: 'Reactions (heuristic, unverified)' },
    aimemory: { key: 'memoryEnabled', label: 'Conversation memory' },
    ailanguage: { key: 'languageEnabled', label: 'Language following' },
    aitiming: { key: 'responseTimingEnabled', label: 'Human-like timing' },
    aireply: { key: 'replyContextEnabled', label: 'Reply / quoted context' },
    aicombine: { key: 'combineEnabled', label: 'Message combining' },
    aiemoji: { key: 'emojiEnabled', label: 'Natural emoji' },
    ainame: { key: 'nameEnabled', label: 'Name personalization' }
}

/** The ten future-module switches, e.g. `.aivision on`. */
const MODULE_TOGGLES = {
    aiassistant: 'assistant',
    aimoderation: 'moderation',
    airewrite: 'rewrite',
    aitranslate: 'translate',
    aifiles: 'files',
    aiweb: 'web',
    aivision: 'vision',
    aiimage: 'image',
    aisticker: 'sticker',
    aiimagesearch: 'imagesearch'
}

/* ------------------------------- rendering ------------------------------- */

function providerHealthLines() {
    const snapshot = provider.healthSnapshot()
    const disabled = config.getAiSettings().disabledProviders || []
    return snapshot.map(row => {
        const p = providers.getProvider(row.id)
        const limit = p?.capabilities?.maxPromptChars || 302
        const state = disabled.includes(row.id) ? 'DISABLED' : row.state
        const detail = state === 'COOLDOWN' && row.cooldownRemainingMs
            ? ` (${Math.ceil(row.cooldownRemainingMs / 1000)}s)`
            : ''
        const score = `${row.successes}/${row.successes + row.failures}`
        return `${state === 'READY' ? '✅' : state === 'COOLDOWN' ? '⏸' : state === 'DISABLED' ? '⛔' : '⚠️'} ${p?.label || row.id}: ${state}${detail} · cap ${limit} · ok ${score}`
    })
}

function statusText(conn = null) {
    const s = config.getAiSettings()
    const lines = [
        '*🧠 DARKNOTE AI*',
        '',
        `Master: *${onOff(s.chatbotEnabled)}*`,
        `Chatbot: ${onOff(s.chatbotEnabled)}`,
        `DM: ${onOff(s.dmEnabled)}`,
        `Group (mention only): ${onOff(s.groupEnabled)}`,
        `Memory: ${onOff(s.memoryEnabled)}`,
        `Typing: ${onOff(s.typingEnabled)}`,
        `Timing: ${onOff(s.responseTimingEnabled)}`,
        `Language: ${onOff(s.languageEnabled)}`,
        `Reply context: ${onOff(s.replyContextEnabled)}`,
        `Combine: ${onOff(s.combineEnabled)}`,
        `Emoji: ${onOff(s.emojiEnabled)}`,
        `Name: ${onOff(s.nameEnabled)}`,
        `Reactions: ${onOff(s.reactionsEnabled)}`,
        `Fallback: ON (max ${s.maxFallbacks})`,
        '',
        `*Owner AI: ALWAYS ON* (paired session ${owner.describeOwner(conn)})`,
        `Chatbot delay: ${presetLabel('chatbot', s.chatbotDelayMode)} · Reply delay: ${presetLabel('reply', s.replyDelayMode)}`,
        `Status — view ${onOff(s.statusView)} · like ${onOff(s.statusLike)} · react ${onOff(s.statusReact)}`,
        `Online cycle: ${presence.status().running ? presence.status().label : 'off'}`,
        `Scheduled tasks: ${scheduler.list().length}`,
        '',
        '*Providers*',
        ...providerHealthLines(),
        '',
        `API key: ${s.apiKey ? 'configured' : '⚠️ MISSING'}`,
        `Prompt budget: ${s.promptBudget} (long ${s.longPromptBudget})`
    ]
    const mods = aiModules.summary(s)
    lines.push('', `*Future modules*: ${mods.available}/${mods.total} available, ${mods.enabled} switched on`)
    return lines.join('\n')
}

function capabilityText() {
    const caps = provider.capabilities()
    const rows = provider.capabilityMatrix()
    const yes = []
    const no = []
    const partial = []
    const mark = (label, value) => {
        if (value === true) yes.push(label)
        else if (value === false) no.push(label)
        else partial.push(`${label} (${value})`)
    }
    mark('text chat', caps.textChat)
    mark('conversation context', caps.conversationContext)
    mark('long conversations', caps.longConversations)
    mark('file / PDF analysis', caps.fileAnalysis)
    mark('image understanding', caps.imageUnderstanding)
    mark('web search', caps.webSearch)
    mark('translation', caps.translation)
    mark('structured output', caps.structuredOutput)
    mark('image generation', caps.imageGeneration)
    mark('image editing', caps.imageEditing)
    mark('tool / function calling', caps.toolCalling)
    return [
        '*🔎 MEASURED PROVIDER CAPABILITIES*',
        '',
        `✅ ${yes.join(', ') || '—'}`,
        `⚠️ ${partial.join(', ') || '—'}`,
        `❌ ${no.join(', ') || '—'}`,
        '',
        '*Per provider*',
        ...rows.map(r => `• ${r.label}: cap ${r.limit} · ${r.measured?.reliability || '?'} ok`),
        '',
        `Gateway prompt cap: ${caps.gatewayMaxPromptChars} · best available: ${caps.maxPromptChars}`
    ].join('\n')
}

function moduleText() {
    const s = config.getAiSettings()
    return ['*🧩 FUTURE AI MODULES*', '', ...aiModules.statusLines(s)].join('\n')
}

/* -------------------------------- commands ------------------------------- */

/**
 * Handle the AI management commands. Returns true when the command was ours.
 * These are ordinary prefixed commands and never auto-trigger; only conversation
 * is prefix-free.
 */
async function runCommand(conn, m, command, args, reply, context = {}) {
    const settings = config.getAiSettings()
    const mode = String(args[args.length - 1] || '').toLowerCase()
    const wantsToggle = ['on', 'off'].includes(mode)

    /* --- module toggles (aiassistant, aivision, ...) --------------------- */
    if (MODULE_TOGGLES[command]) {
        if (!context.isOwner) { await reply('❌ Owner only.'); return true }
        const name = MODULE_TOGGLES[command]
        const current = settings.modules || {}
        if (!wantsToggle) {
            const line = (aiModules.statusLines(settings).find(l => l.toLowerCase().includes(name)) || '').trim()
            await reply(`${line || name}\n\nUsage: ${context.prefix || '.'}${command} on|off`)
            return true
        }
        config.writeAiSetting('modules', { ...current, [name]: mode === 'on' })
        const after = aiModules.get(name).available(config.getAiSettings(), providers)
        await reply(after.available
            ? `✅ ${name} is now ON`
            : `⚠️ ${name} switched ${mode.toUpperCase()}, but it stays inactive: ${after.reason}.`)
        return true
    }

    /* --- simple toggles --------------------------------------------------- */
    if (TOGGLES[command]) {
        if (!context.isOwner) { await reply('❌ Owner only.'); return true }
        const entry = TOGGLES[command]

        // `.aimemory` with no argument keeps the old behaviour: show memory.
        if (command === 'aimemory' && !wantsToggle) {
            if (!settings.memoryEnabled) { await reply('ℹ️ Conversation memory is currently OFF.'); return true }
            const summary = memory.describe(memory.sessionKey(m))
            await reply(['*🧠 DARKNOTE AI MEMORY*', `Session: ${summary.key || 'unknown'}`, `Turns: ${summary.turns}`, '', ...summary.lines].join('\n'))
            return true
        }

        if (!wantsToggle) {
            await reply(`${entry.label}: ${onOff(Boolean(settings[entry.key]))}\n\nUsage: ${context.prefix || '.'}${command} on|off`)
            return true
        }
        config.writeAiSetting(entry.key, mode === 'on')
        const after = config.getAiSettings()
        if (entry.key === 'chatbotEnabled' && !after.chatbotEnabled) {
            if (typeof chatbot.clearAllBatches === 'function') chatbot.clearAllBatches()
        }
        const header = `✅ ${entry.label} is now ${onOff(Boolean(after[entry.key]))}`
        // Turning the public chatbot ON presents the setup panel, so the delays
        // are chosen deliberately rather than left at whatever was there before.
        if (entry.key === 'chatbotEnabled' && mode === 'on') {
            await reply(`${header}\n\n${setupSummary(after)}`)
        } else {
            await reply(header)
        }
        return true
    }

    /* --- status: three INDEPENDENT controls -------------------------------- */
    if (command === 'statusview' || command === 'statuslike' || command === 'statusreact') {
        if (!context.isOwner) { await reply('❌ Owner only.'); return true }
        const flag = { statusview: ['avs', 'statusView'], statuslike: ['als', 'statusLike'], statusreact: ['ars', 'statusReact'] }[command]
        if (!wantsToggle) {
            await reply(`${command}: ${onOff(Boolean(settings[flag[1]]))}\n\nUsage: ${context.prefix || '.'}${command} on|off`)
            return true
        }
        writeStatusFlag(flag[0], mode === 'on')
        await reply(`✅ ${command} is now ${onOff(mode === 'on')}`)
        return true
    }

    /* --- delay presets (the setup card writes the same two keys) ------------ */
    if (command === 'chatbotdelay' || command === 'replydelay') {
        if (!context.isOwner) { await reply('❌ Owner only.'); return true }
        const isChatbot = command === 'chatbotdelay'
        const key = isChatbot ? 'chatbotDelayMode' : 'replyDelayMode'
        const options = isChatbot ? '4-5min | 10-11min' : '5-10sec | 15-20sec'
        const raw = String(args[0] || '').toLowerCase()
        if (!raw) {
            await reply(`${isChatbot ? 'Chatbot delay' : 'Reply delay'}: ${presetLabel(isChatbot ? 'chatbot' : 'reply', settings[key])}\n\nUsage: ${context.prefix || '.'}${command} ${options}`)
            return true
        }
        // "10-11min" and "15-20sec" start at 10+, so the leading number decides.
        const leading = (raw.match(/^(\d+)/) || [])[1]
        const chosen = raw.startsWith('long') ? 'long' : raw.startsWith('short') ? 'short' : (Number(leading) >= 10 ? 'long' : 'short')
        config.writeAiSetting(key, chosen)
        await reply(`✅ ${isChatbot ? 'Chatbot delay' : 'Reply delay'} set to *${presetLabel(isChatbot ? 'chatbot' : 'reply', chosen)}*.`)
        return true
    }

    if (command === 'aisetup') {
        await reply(setupSummary(settings))
        return true
    }

    /* --- online presence --------------------------------------------------- */
    if (command === 'online') {
        if (!context.isOwner) { await reply('❌ Owner only.'); return true }
        const arg = String(args[0] || '').toLowerCase()
        if (!arg) {
            presence.once(conn)
            await reply('✅ Appearing online.')
            return true
        }
        if (arg === 'off' || arg === 'stop') {
            const existed = presence.stop(conn)
            await reply(existed ? '✅ Online cycle stopped.' : 'ℹ️ No online cycle was running.')
            return true
        }
        const parsed = presence.parseDuration(arg)
        if (!parsed || !parsed.ms) {
            await reply(`❌ ${parsed?.error ? parsed.error : 'Invalid duration.'}\n\nTry: ${context.prefix || '.'}online 30sec | 5min | 2hrs | off`)
            return true
        }
        presence.start(conn, parsed.ms)
        await reply(`✅ Online cycle started: ${presence.formatDuration(parsed.ms)} online, ${presence.formatDuration(parsed.ms)} offline, repeating.\n\nStop with ${context.prefix || '.'}online off`)
        return true
    }

    /* --- group close / open ------------------------------------------------ */
    if (command === 'close' || command === 'open') {
        if (!m.isGroup) { await reply('❌ This command only works in a group.'); return true }
        const wantClose = command === 'close'
        let allowed = context.isOwner
        if (!allowed) {
            try {
                const metadata = await conn.groupMetadata(m.chat)
                const me = String(m.sender || '').split('@')[0].split(':')[0]
                allowed = (metadata?.participants || []).some(p => {
                    const id = String(p.id || p.jid || '').split('@')[0].split(':')[0]
                    return id === me && Boolean(p.admin)
                })
            } catch { allowed = false }
        }
        if (!allowed) { await reply('❌ Only group admins or the bot owner can do that.'); return true }

        const control = await grouptimer.canControl(conn, m.chat)
        if (!control.ok) { await reply('❌ DARKNOTE must be a group admin to change the group setting.'); return true }

        const arg = String(args[0] || '').toLowerCase()
        if (!arg) {
            const result = await grouptimer.immediate(conn, m.chat, wantClose)
            await reply(result.ok ? `✅ Group ${wantClose ? 'closed' : 'opened'}.` : `❌ ${result.reason || 'Failed.'}`)
            return true
        }
        const parsed = presence.parseDuration(arg)
        if (!parsed || !parsed.ms) {
            await reply(`❌ ${parsed?.error ? parsed.error : 'Invalid duration.'}\n\nTry: ${context.prefix || '.'}${command} 70sec | 10min | 2hrs`)
            return true
        }
        const result = await grouptimer.timed(conn, m.chat, wantClose, parsed.ms)
        await reply(result.ok
            ? `✅ Group ${wantClose ? 'closed' : 'opened'} now, and will ${wantClose ? 'open' : 'close'} automatically in ${presence.formatDuration(parsed.ms)}.`
            : `❌ ${result.reason || 'Failed.'}`)
        return true
    }

    /* --- reports ---------------------------------------------------------- */
    if (command === 'aistatus') {
        await reply(`${statusText(conn)}\n\n${capabilityText()}`)
        return true
    }

    if (command === 'aicapabilities') {
        await reply(capabilityText())
        return true
    }

    if (command === 'aimodules') {
        await reply(moduleText())
        return true
    }

    if (command === 'aihealth') {
        const arg = String(args[0] || '').toLowerCase()
        if (arg === 'reset') {
            if (!context.isOwner) { await reply('❌ Owner only.'); return true }
            health.reset()
            health.register(providers.providerIds())
            await reply('♻️ Provider health reset — every provider is eligible again.')
            return true
        }
        await reply(['*🩺 PROVIDER HEALTH*', '', ...providerHealthLines(), '', `Usage: ${context.prefix || '.'}aihealth reset`].join('\n'))
        return true
    }

    if (command === 'aiforget') {
        const cleared = memory.reset(memory.sessionKey(m))
        await reply(cleared ? '🧹 I have forgotten this conversation.' : 'ℹ️ I had nothing stored for this chat.')
        return true
    }

    /* --- legacy aliases kept working ------------------------------------- */
    if (command === 'chatbot') {
        if (!context.isOwner) { await reply('❌ Owner only.'); return true }
        if (!wantsToggle) { await reply(`${statusText()}\n\nUsage: ${context.prefix || '.'}chatbot on|off`); return true }
        config.writeAiSetting('chatbotEnabled', mode === 'on')
        const after = config.getAiSettings()
        if (!after.chatbotEnabled) chatbot.clearAllBatches()
        await reply(`✅ AI CHATBOT is now ${onOff(after.chatbotEnabled)}`)
        return true
    }

    if (command === 'aiset') {
        if (!context.isOwner) { await reply('❌ Owner only.'); return true }
        // Old names still accepted: .aiset dm|group|typing|reactions|memory|timing on|off
        const legacy = { dm: 'aidm', group: 'aigroup', typing: 'aityping', reactions: 'aireact', memory: 'aimemory', timing: 'aitiming' }
        const target = legacy[String(args[0] || '').toLowerCase()]
        if (!target) {
            const usage = Object.entries(TOGGLES).map(([k, v]) => `${k}=${onOff(Boolean(settings[v.key]))}`).join('  ')
            await reply(`Usage: ${context.prefix || '.'}aiset <${Object.keys(legacy).join('|')}> on|off\n\nOr use the direct commands:\n${usage}`)
            return true
        }
        const entry = TOGGLES[target]
        config.writeAiSetting(entry.key, mode === 'on')
        await reply(`✅ ${entry.label} is now ${onOff(mode === 'on')}`)
        return true
    }

    return false
}

/*
 * THE SINGLE AI ENTRY POINT.
 *
 * `.autohuman` has its own switch, so it is tried first: it must work whether or
 * not the public chatbot is on. When it is off - which is the default - this is
 * exactly the previous `chatbot.handle`, so nothing that already worked changes
 * behaviour.
 *
 * Both paths return immediately and do their work in a detached task, so one
 * slow provider never blocks the message pipeline.
 */
async function handle(conn, m, context = {}) {
    try {
        if (autohuman.enabled()) {
            const verdict = autohuman.evaluate(conn, m, context)
            if (verdict.ok) return autohuman.handle(conn, m, context)
            // Not eligible for a human-style reply. Fall through to the normal
            // chatbot so an existing `.chatbot on` setup keeps working.
        }
    } catch (error) {
        console.error('[AI] autohuman hand-off failed:', error?.stack || error)
    }
    return chatbot.handle(conn, m, context)
}

module.exports = {
    // orchestration
    handle,
    autohuman,
    evaluate: chatbot.evaluate,
    clearAllBatches: chatbot.clearAllBatches,
    pendingCount: chatbot.pendingCount,
    isBotMentioned: chatbot.isBotMentioned,

    // commands + status
    runCommand,
    statusText,
    capabilityText,
    moduleText,
    providerHealthLines,
    TOGGLES,
    MODULE_TOGGLES,

    // sub-modules
    config,
    provider,
    memory,
    language,
    timing,
    personality,
    ratelimit,
    reactions,
    objectives,
    health,
    providers,
    aiModules,
    router: require('./router'),
    transport: require('./transport'),
    owner,
    presence,
    grouptimer,
    scheduler,
    convState,
    safety,
    setupSummary,
    presetLabel
}
