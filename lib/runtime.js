'use strict'

/*
 * DARKNOTE RUNTIME ALIVE
 * ----------------------
 * The single authority on "is this bot actually alive".
 *
 * It exists for four narrow jobs, and nothing else:
 *
 *   1. ONE SOCKET.  Before a new WhatsApp socket is created, the previous one is
 *      closed. Two live sockets on one session is the classic cause of duplicated
 *      replies, duplicated read receipts and being logged out by WhatsApp.
 *
 *   2. ONE RECONNECT.  Reconnects go through a single timer with exponential
 *      backoff, so a dead network cannot turn into a tight reconnect loop, and
 *      two disconnect events cannot spawn two sockets.
 *
 *   3. HONEST STATE.  The connection state is recorded from the real
 *      connection.update events. Nothing here ever reports CONNECTED unless
 *      WhatsApp actually said so. Telegram reads this, so it cannot lie either.
 *
 *   4. NO SILENT DEATH.  Non-fatal errors are logged and survived; fatal ones are
 *      logged with a real cause and allowed to reach the panel supervisor. No
 *      infinite restart loop and no empty `catch {}`.
 *
 * This module never registers a message listener. It has no opinion about
 * messages, commands or AI - it only watches the socket lifecycle.
 */

/* ------------------------------- states ---------------------------------- */

// The four states Telegram is allowed to display. WhatsApp-aligned names.
const STATES = {
    CONNECTED: 'CONNECTED',
    CONNECTING: 'CONNECTING',
    DISCONNECTED: 'DISCONNECTED',
    AUTH_REQUIRED: 'AUTH_REQUIRED'
}

/*
 * Display labels. The state KEYS stay machine-readable (Telegram and the health
 * line switch on them), but anything a human reads says "AUTHENTICATION
 * REQUIRED" rather than the internal constant.
 */
const LABELS = {
    [STATES.CONNECTED]: 'CONNECTED',
    [STATES.CONNECTING]: 'CONNECTING',
    [STATES.DISCONNECTED]: 'DISCONNECTED',
    [STATES.AUTH_REQUIRED]: 'AUTHENTICATION REQUIRED'
}

const labelOf = value => LABELS[value] || String(value || 'UNKNOWN')

/*
 * Backoff ladder in milliseconds. Starts at 2s and tops out at 60s.
 * The floor is what stops a tight loop: even if WhatsApp closes the socket
 * instantly on every attempt, the next attempt is never sooner than 2s.
 */
const BACKOFF_STEPS = [2000, 5000, 10000, 20000, 40000, 60000]

// Health is logged on a slow interval. State CHANGES are logged immediately,
// so the panel stays readable instead of scrolling.
const HEALTH_INTERVAL_MS = 5 * 60 * 1000

const state = {
    whatsapp: STATES.DISCONNECTED,
    detail: 'not started',
    since: Date.now(),
    lastActivity: 0,
    lastOpen: 0,
    lastClose: 0,
    reconnects: 0,
    attempts: 0,
    authRequired: false,
    lastError: '',
    fatal: '',
    startedAt: Date.now()
}

let socket = null            // the ONE live socket
let reconnectTimer = null
let healthTimer = null
let backoffIndex = 0
let reconnectFn = null       // injected by index.js; runtime stays decoupled
let guardsInstalled = false
let shuttingDown = false

function log(message) {
    console.log(`[RUNTIME] ${message}`)
}

function logErr(message, error) {
    console.error(`[RUNTIME] ${message}`, error?.stack || error?.message || error || '')
}

function setState(next, detail) {
    const changed = state.whatsapp !== next
    state.whatsapp = next
    if (detail !== undefined) state.detail = String(detail || '')
    if (changed) {
        state.since = Date.now()
        // Immediate log on CHANGE only - this is the "meaningful state change"
        // the panel should show, without periodic noise.
        log(`WhatsApp: ${next}${state.detail ? ` (${state.detail})` : ''}`)
    }
}

/* ------------------------------ socket slot ------------------------------ */

/**
 * Claim the single socket slot.
 *
 * If a socket is already here it is closed first. This is the guarantee that two
 * sockets never run at once. Returns the socket, so callers can treat
 * register() as "make this the live socket".
 */
function register(nextSocket) {
    if (!nextSocket) return null
    if (socket && socket !== nextSocket) {
        const previous = socket
        socket = null
        try {
            // end() is the clean close. A previous socket that refuses to close
            // must not stop the new one from being used, so failures are logged
            // and swallowed - but never silently.
            if (typeof previous.end === 'function') {
                previous.end(new Error('superseded by a newer DARKNOTE socket'))
            } else if (typeof previous.ws?.close === 'function') {
                previous.ws.close()
            }
        } catch (error) {
            logErr('closing the superseded socket failed (continuing):', error)
        }
    }
    socket = nextSocket
    state.attempts += 1
    if (state.attempts > 1) state.reconnects = state.attempts - 1
    return socket
}

function unregister(target) {
    if (!target || socket === target) socket = null
}

function currentSocket() {
    return socket
}

/* ------------------------------- lifecycle ------------------------------- */

function markOpen() {
    backoffIndex = 0
    state.lastOpen = Date.now()
    state.authRequired = false
    state.lastError = ''
    setState(STATES.CONNECTED, 'session active')
}

function markConnecting(detail = 'opening socket') {
    setState(STATES.CONNECTING, detail)
}

function markClosed(statusCode, reason) {
    state.lastClose = Date.now()
    if (statusCode === 401 || /logged ?out/i.test(String(reason || ''))) {
        state.authRequired = true
        setState(STATES.AUTH_REQUIRED, 'logged out - session invalid')
        return
    }
    setState(STATES.DISCONNECTED, reason || 'connection closed')
}

/**
 * Whether a disconnect should be retried.
 *
 * 401 / loggedOut is the ONLY unrecoverable case: the session is dead and
 * retrying would loop forever against a server that will keep refusing us.
 * Everything else (network blip, restart, timeout) is recoverable.
 */
function isRecoverable(statusCode) {
    if (statusCode === 401) return false
    if (state.authRequired) return false
    return true
}

/**
 * Book the single pending reconnect.
 *
 * Any earlier timer is replaced, so a burst of close events still results in
 * exactly one reconnect. Delay follows the backoff ladder.
 */
function scheduleReconnect(fn) {
    if (typeof fn === 'function') reconnectFn = fn
    if (shuttingDown) return null
    if (!reconnectFn) return null
    if (!isRecoverable()) {
        log('reconnect suppressed: authentication is no longer valid')
        return null
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
    const delay = BACKOFF_STEPS[Math.min(backoffIndex, BACKOFF_STEPS.length - 1)]
    backoffIndex += 1
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        setState(STATES.CONNECTING, `reconnect attempt ${backoffIndex}`)
        Promise.resolve()
            .then(() => reconnectFn())
            .catch(error => logErr('reconnect attempt threw:', error))
    }, delay)
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
    return delay
}

function cancelReconnect() {
    if (!reconnectTimer) return false
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    return true
}

function isReconnectPending() {
    return Boolean(reconnectTimer)
}

/* -------------------------------- activity ------------------------------- */

function noteActivity() {
    state.lastActivity = Date.now()
}

function noteError(error) {
    state.lastError = String(error?.message || error || '').slice(0, 300)
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
    const s = Math.floor((Date.now() - state.startedAt) / 1000)
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60), sec = s % 60
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`
}

function getState() {
    return { ...state, uptimeMs: Date.now() - state.startedAt }
}

// Machine-readable snapshot for Telegram, so the controller reports the real
// state rather than guessing.
function telegramState() {
    return {
        state: state.whatsapp,
        connected: state.whatsapp === STATES.CONNECTED,
        reconnects: state.reconnects,
        lastActivity: state.lastActivity,
        lastError: state.lastError,
        fatal: state.fatal
    }
}

function statusText() {
    const runtimeHealthy = !state.fatal && state.whatsapp !== STATES.AUTH_REQUIRED
    return [
        '╭────────────────────╮',
        '│ ✞ DARKNOTE ALIVE',
        '│',
        `│ WhatsApp: ${labelOf(state.whatsapp)}`,
        `│ Runtime:  ${state.fatal ? 'FATAL' : runtimeHealthy ? 'HEALTHY' : 'ATTENTION'}`,
        `│ Uptime:   ${uptimeText()}`,
        `│ Activity: ${humanAge(state.lastActivity)}`,
        '╰────────────────────╯'
    ].join('\n')
}

function statusLine() {
    const runtimeHealthy = !state.fatal && state.whatsapp !== STATES.AUTH_REQUIRED
    return `DARKNOTE ALIVE | WhatsApp: ${labelOf(state.whatsapp)} | Runtime: ${state.fatal ? 'FATAL' : runtimeHealthy ? 'HEALTHY' : 'ATTENTION'} | up ${uptimeText()}`
}

/* ------------------------------ health loop ------------------------------ */

function startMonitor() {
    if (healthTimer) return false
    healthTimer = setInterval(() => {
        // One line per interval, and only the line. Logging every message would
        // flood the panel; logging nothing would hide a silent death.
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

/*
 * Non-fatal by default: we log the real error and keep running. A single bad
 * message or a failing download must not take the whole bot down.
 *
 * The process is NOT force-exited on uncaughtException either, because exiting
 * would restart the whole bot for something a single conversation caused. The
 * one exception is an explicit fatal path below, which reports the true cause
 * and lets the panel supervisor decide.
 */
function installGuards() {
    if (guardsInstalled) return false
    guardsInstalled = true

    process.on('unhandledRejection', (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        noteError(error)
        logErr('UNHANDLED REJECTION (bot kept running):', error)
    })

    process.on('uncaughtException', (error) => {
        noteError(error)
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
 * Fatal path. Used only when the bot genuinely cannot continue (a missing or
 * invalid session, for example). Logs the true cause and exits non-zero so the
 * panel supervisor restarts the process - deliberately NOT a restart loop we
 * drive ourselves.
 */
function fatal(reason, error) {
    state.fatal = String(reason || 'fatal error')
    logErr(`FATAL: ${state.fatal}`, error)
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    shutdown()
    setTimeout(() => process.exit(1), 250)
}

function shutdown() {
    shuttingDown = true
    cancelReconnect()
    stopMonitor()
}

module.exports = {
    STATES,
    LABELS,
    labelOf,
    register,
    unregister,
    currentSocket,
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
    statusText,
    statusLine,
    startMonitor,
    stopMonitor,
    installGuards,
    fatal,
    shutdown,
    uptimeText
}
