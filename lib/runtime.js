'use strict'

/*
 * DARKNOTE RUNTIME ALIVE
 * ----------------------
 * The single authority on "is this bot actually alive".
 *
 * It now tracks MANY sessions at once - one per paired WhatsApp account - so
 * every piece of state is keyed by session id:
 *
 *   runtime.register(socket, 's2')   // s2's slot only
 *
 * Registering a socket closes the previous socket FOR THAT SESSION and no other.
 * Getting that wrong is how a second session silently kills the first, so it is
 * the first thing the tests cover.
 *
 * Four jobs, and nothing else:
 *
 *   1. ONE SOCKET PER SESSION.  A session's previous socket is closed before a
 *      new one is used. Two live sockets on one session cause duplicated replies,
 *      duplicated read receipts and eventually a forced logout.
 *
 *   2. ONE RECONNECT PER SESSION.  Backoff timers are per session, so one dead
 *      session cannot spawn a loop, and cannot cancel another session's retry.
 *
 *   3. HONEST STATE.  Recorded from real connection.update events. Nothing here
 *      ever reports CONNECTED unless WhatsApp said so. Telegram reads this, so it
 *      cannot lie either.
 *
 *   4. NO SILENT DEATH.  Non-fatal errors are logged and survived; fatal ones are
 *      logged with a real cause and left to the panel supervisor.
 *
 * 'main' is the default session id, so single-session callers behave exactly as
 * they did before this became multi-session.
 */

const STATES = {
    CONNECTED: 'CONNECTED',
    CONNECTING: 'CONNECTING',
    DISCONNECTED: 'DISCONNECTED',
    AUTH_REQUIRED: 'AUTH_REQUIRED'
}

const LABELS = {
    [STATES.CONNECTED]: 'CONNECTED',
    [STATES.CONNECTING]: 'CONNECTING',
    [STATES.DISCONNECTED]: 'DISCONNECTED',
    [STATES.AUTH_REQUIRED]: 'AUTHENTICATION REQUIRED'
}

const labelOf = value => LABELS[value] || String(value || 'UNKNOWN')

/*
 * Backoff ladder in milliseconds, per session. Starts at 2s and tops out at 60s.
 * The floor is what stops a tight loop: even if WhatsApp closes a socket
 * instantly on every attempt, the next attempt is never sooner than 2s.
 */
const BACKOFF_STEPS = [2000, 5000, 10000, 20000, 40000, 60000]
const HEALTH_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_SESSION = 'main'

let sessions = new Map()
let healthTimer = null
let shuttingDown = false
let guardsInstalled = false
const global = { startCount: 0, fatal: '', startedAt: Date.now() }

function log(message) {
    console.log(`[RUNTIME] ${message}`)
}

function logErr(message, error) {
    console.error(`[RUNTIME] ${message}`, error?.stack || error?.message || error || '')
}

/* ------------------------------- state slots ----------------------------- */

/**
 * The state for one session, created on demand.
 *
 * A missing session reads as DISCONNECTED rather than throwing, so a status
 * request for a session that has not started yet still returns something honest.
 */
function slot(id) {
    const key = String(id || DEFAULT_SESSION)
    if (!sessions.has(key)) {
        sessions.set(key, {
            id: key,
            socket: null,
            whatsapp: STATES.DISCONNECTED,
            detail: 'not started',
            since: Date.now(),
            lastActivity: 0,
            lastOpen: 0,
            lastClose: 0,
            attempts: 0,
            reconnects: 0,
            authRequired: false,
            lastError: '',
            backoffIndex: 0,
            timer: null,
            reconnectFn: null
        })
    }
    return sessions.get(key)
}

function setState(id, next, detail) {
    const target = slot(id)
    const changed = target.whatsapp !== next
    target.whatsapp = next
    if (detail !== undefined) target.detail = String(detail || '')
    if (changed) {
        target.since = Date.now()
        log(`${target.id}: ${next}${target.detail ? ` (${target.detail})` : ''}`)
    }
}

/* ------------------------------ socket slots ----------------------------- */

/**
 * Claim the socket slot FOR ONE SESSION.
 *
 * Only that session's previous socket is closed. Other sessions keep running,
 * which is the whole point of the keyed map.
 */
function register(nextSocket, id = DEFAULT_SESSION) {
    if (!nextSocket) return null
    const target = slot(id)
    if (target.socket && target.socket !== nextSocket) {
        const previous = target.socket
        target.socket = null
        try {
            if (typeof previous.end === 'function') previous.end(new Error(`superseded by a newer ${target.id} socket`))
            else if (typeof previous.ws?.close === 'function') previous.ws.close()
        } catch (error) {
            logErr(`closing the superseded socket for ${target.id} failed (continuing):`, error)
        }
    }
    target.socket = nextSocket
    target.attempts += 1
    global.startCount += 1
    if (target.attempts > 1) target.reconnects = target.attempts - 1
    return target.socket
}

function unregister(idOrSocket) {
    // Accepts either a session id or the socket itself, so a late event from an
    // old socket cannot clear a session it no longer owns.
    if (typeof idOrSocket === 'object' && idOrSocket !== null) {
        for (const target of sessions.values()) {
            if (target.socket === idOrSocket) target.socket = null
        }
        return
    }
    const target = slot(idOrSocket)
    target.socket = null
}

function currentSocket(id = DEFAULT_SESSION) {
    return slot(id).socket
}

/** Every session with its socket, for the runner. */
const socketEntries = () => [...sessions.values()].map(s => ({ id: s.id, socket: s.socket }))
const sessionIds = () => [...sessions.keys()]

/* ------------------------------- lifecycle ------------------------------- */

function markOpen(id = DEFAULT_SESSION) {
    const target = slot(id)
    target.backoffIndex = 0
    target.lastOpen = Date.now()
    target.authRequired = false
    target.lastError = ''
    setState(id, STATES.CONNECTED, 'session active')
}

function markConnecting(detail = 'opening socket', id = DEFAULT_SESSION) {
    setState(id, STATES.CONNECTING, detail)
}

function markClosed(statusCode, reason, id = DEFAULT_SESSION) {
    const target = slot(id)
    target.lastClose = Date.now()
    if (statusCode === 401 || /logged ?out/i.test(String(reason || ''))) {
        target.authRequired = true
        setState(id, STATES.AUTH_REQUIRED, 'logged out - session invalid')
        return
    }
    setState(id, STATES.DISCONNECTED, reason || 'connection closed')
}

/**
 * Whether a disconnect should be retried.
 *
 * 401 / loggedOut is the ONLY unrecoverable case: the session is dead and
 * retrying would loop forever against a server that keeps refusing. Everything
 * else (network blip, restart, timeout) is recoverable.
 */
function isRecoverable(statusCode, id = DEFAULT_SESSION) {
    if (statusCode === 401) return false
    if (slot(id).authRequired) return false
    return true
}

/**
 * Book the single pending reconnect FOR ONE SESSION.
 *
 * Any earlier timer for that session is replaced, so a burst of close events
 * still results in exactly one reconnect, and other sessions' timers are
 * untouched.
 */
function scheduleReconnect(fn, id = DEFAULT_SESSION) {
    const target = slot(id)
    if (typeof fn === 'function') target.reconnectFn = fn
    if (shuttingDown) return null
    if (!target.reconnectFn) return null
    if (!isRecoverable(undefined, target.id)) {
        log(`${target.id}: reconnect suppressed, authentication is no longer valid`)
        return null
    }
    if (target.timer) {
        clearTimeout(target.timer)
        target.timer = null
    }
    const delay = BACKOFF_STEPS[Math.min(target.backoffIndex, BACKOFF_STEPS.length - 1)]
    target.backoffIndex += 1
    target.timer = setTimeout(() => {
        target.timer = null
        setState(target.id, STATES.CONNECTING, `reconnect attempt ${target.backoffIndex}`)
        Promise.resolve()
            .then(() => target.reconnectFn())
            .catch(error => logErr(`${target.id}: reconnect attempt threw`, error))
    }, delay)
    if (typeof target.timer.unref === 'function') target.timer.unref()
    return delay
}

function cancelReconnect(id = DEFAULT_SESSION) {
    const target = slot(id)
    if (!target.timer) return false
    clearTimeout(target.timer)
    target.timer = null
    return true
}

function isReconnectPending(id = DEFAULT_SESSION) {
    return Boolean(slot(id).timer)
}

function forget(id) {
    const target = sessions.get(id)
    if (!target) return false
    if (target.timer) clearTimeout(target.timer)
    if (target.socket) {
        try { target.socket.end?.(new Error('session removed')) } catch { /* best effort */ }
    }
    sessions.delete(id)
    return true
}

/* -------------------------------- activity ------------------------------- */

function noteActivity(id = DEFAULT_SESSION) {
    slot(id).lastActivity = Date.now()
}

function noteError(error, id = DEFAULT_SESSION) {
    slot(id).lastError = String(error?.message || error || '').slice(0, 300)
}

function humanAge(ms) {
    if (!ms) return 'never'
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

function uptimeText() {
    const s = Math.floor((Date.now() - global.startedAt) / 1000)
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60), sec = s % 60
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`
}

function getState(id = DEFAULT_SESSION) {
    const target = slot(id)
    return {
        id: target.id,
        whatsapp: target.whatsapp,
        detail: target.detail,
        since: target.since,
        lastActivity: target.lastActivity,
        lastOpen: target.lastOpen,
        lastClose: target.lastClose,
        reconnects: target.reconnects,
        attempts: target.attempts,
        authRequired: target.authRequired,
        lastError: target.lastError,
        fatal: global.fatal,
        startedAt: global.startedAt,
        uptimeMs: Date.now() - global.startedAt
    }
}

/** Machine-readable snapshot for one session (Telegram reads this). */
function telegramState(id = DEFAULT_SESSION) {
    const target = slot(id)
    return {
        id: target.id,
        state: target.whatsapp,
        connected: target.whatsapp === STATES.CONNECTED,
        reconnects: target.reconnects,
        lastActivity: target.lastActivity,
        lastError: target.lastError,
        fatal: global.fatal
    }
}

/**
 * Every session at a glance. This is what "is the bot alive" means once more
 * than one session can exist - a single flag would hide 149 failures.
 */
function aggregate() {
    const counts = { CONNECTED: 0, CONNECTING: 0, DISCONNECTED: 0, AUTH_REQUIRED: 0 }
    let reconnects = 0
    for (const target of sessions.values()) {
        counts[target.whatsapp] = (counts[target.whatsapp] || 0) + 1
        reconnects += target.reconnects
    }
    const total = sessions.size
    return {
        total,
        ...counts,
        reconnects,
        healthy: counts.AUTH_REQUIRED === 0 && !global.fatal,
        fatal: global.fatal
    }
}

function statusText(id = DEFAULT_SESSION) {
    const target = slot(id)
    const runtimeHealthy = !global.fatal && target.whatsapp !== STATES.AUTH_REQUIRED
    const agg = aggregate()
    const lines = [
        '╭────────────────────╮',
        '│ ✞ DARKNOTE ALIVE',
        '│',
        `│ WhatsApp: ${labelOf(target.whatsapp)}`,
        `│ Runtime:  ${global.fatal ? 'FATAL' : runtimeHealthy ? 'HEALTHY' : 'ATTENTION'}`,
        `│ Uptime:   ${uptimeText()}`,
        `│ Activity: ${humanAge(target.lastActivity)}`
    ]
    // Only shown once more than one session exists, so single-session output
    // stays exactly as it was.
    if (agg.total > 1) {
        lines.push(`│ Sessions: ${agg.total} (${agg.CONNECTED} connected)`)
        if (agg.AUTH_REQUIRED) lines.push(`│ Auth needed: ${agg.AUTH_REQUIRED}`)
    }
    lines.push('╰────────────────────╯')
    return lines.join('\n')
}

function statusLine() {
    const agg = aggregate()
    if (agg.total <= 1) {
        const target = slot(DEFAULT_SESSION)
        const runtimeHealthy = !global.fatal && target.whatsapp !== STATES.AUTH_REQUIRED
        return `DARKNOTE ALIVE | WhatsApp: ${labelOf(target.whatsapp)} | Runtime: ${global.fatal ? 'FATAL' : runtimeHealthy ? 'HEALTHY' : 'ATTENTION'} | up ${uptimeText()}`
    }
    return `DARKNOTE ALIVE | Sessions: ${agg.CONNECTED}/${agg.total} connected${agg.AUTH_REQUIRED ? ` | ${agg.AUTH_REQUIRED} need auth` : ''} | up ${uptimeText()}`
}

/* ------------------------------ health loop ------------------------------ */

function startMonitor() {
    if (healthTimer) return false
    healthTimer = setInterval(() => {
        // One line per interval. Logging every message would flood the panel;
        // logging nothing would hide a silent death.
        log(statusLine())
    }, HEALTH_INTERVAL_MS)
    if (typeof healthTimer.unref === 'function') healthTimer.unref()
    return true
}

function stopMonitor() {
    if (!healthTimer) return false
    clearInterval(healthTimer)
    healthTimer = null
    return true
}

/* --------------------------- crash protection ---------------------------- */

function installGuards() {
    if (guardsInstalled) return false
    guardsInstalled = true

    process.on('unhandledRejection', (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        logErr('UNHANDLED REJECTION (bot kept running):', error)
    })

    process.on('uncaughtException', (error) => {
        logErr('UNCAUGHT EXCEPTION (bot kept running):', error)
    })

    process.on('warning', (warning) => {
        if (String(warning?.name || '') === 'MaxListenersExceededWarning') {
            logErr('LISTENER LEAK DETECTED:', new Error(warning.message))
        }
    })

    return true
}

/**
 * Fatal path, used only when the bot genuinely cannot continue. Logs the true
 * cause and exits non-zero so the panel supervisor restarts the process -
 * deliberately NOT a restart loop we drive ourselves.
 */
function fatal(reason, error) {
    global.fatal = String(reason || 'fatal error')
    logErr(`FATAL: ${global.fatal}`, error)
    shutdown()
    setTimeout(() => process.exit(1), 250)
}

function shutdown() {
    shuttingDown = true
    for (const target of sessions.values()) {
        if (target.timer) { clearTimeout(target.timer); target.timer = null }
    }
    stopMonitor()
}

module.exports = {
    STATES,
    LABELS,
    labelOf,
    DEFAULT_SESSION,
    register,
    unregister,
    currentSocket,
    socketEntries,
    sessionIds,
    forget,
    markOpen,
    markConnecting,
    markClosed,
    isRecoverable,
    scheduleReconnect,
    cancelReconnect,
    isReconnectPending,
    noteActivity,
    noteError,
    getState,
    telegramState,
    aggregate,
    statusText,
    statusLine,
    startMonitor,
    stopMonitor,
    installGuards,
    fatal,
    shutdown,
    uptimeText
}
