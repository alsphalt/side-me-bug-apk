'use strict'

/* DARKNOTE command registry/alias layer.
 * Aliases point to command names only; command implementations remain in the
 * existing dispatcher. Persistence intentionally reuses config.json.
 */
const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')
const MAIN_PATH = path.join(__dirname, '..', 'BIGBRO.js')
const config = require(CONFIG_PATH)

const BUILTIN = new Set(['ss', 'cmdset', 'stckcmd'])
const NAME_RE = /^[a-z0-9][a-z0-9_]{0,31}$/i

function normalizeName(value) {
    return String(value || '').trim().replace(/^\./, '').toLowerCase()
}

function sessionKey(conn) {
    // Strip the device suffix (:10) before removing separators - it changes on
    // every re-link, which used to orphan the stored aliases.
    const n = String(conn?.user?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '')
    return n || 'unpaired'
}

function readAliases(conn) {
    if (!config.cmdAliases || typeof config.cmdAliases !== 'object' || Array.isArray(config.cmdAliases)) config.cmdAliases = {}
    // Backward compatibility: an old flat alias object is migrated to the
    // current primary/unpaired session rather than shared across sessions.
    const values = Object.values(config.cmdAliases)
    const looksFlat = values.length === 0 || values.some(v => typeof v === 'string')
    if (looksFlat) {
        const flat = config.cmdAliases
        config.cmdAliases = { [sessionKey(conn)]: {} }
        for (const [rawAlias, rawTarget] of Object.entries(flat)) {
            const alias = normalizeName(rawAlias), target = normalizeName(rawTarget)
            if (NAME_RE.test(alias) && NAME_RE.test(target) && alias !== target) config.cmdAliases[sessionKey(conn)][alias] = target
        }
        saveConfig()
    }
    const key = sessionKey(conn)
    if (!config.cmdAliases[key] || typeof config.cmdAliases[key] !== 'object' || Array.isArray(config.cmdAliases[key])) config.cmdAliases[key] = {}
    const clean = {}
    for (const [rawAlias, rawTarget] of Object.entries(config.cmdAliases[key])) {
        const alias = normalizeName(rawAlias), target = normalizeName(rawTarget)
        if (NAME_RE.test(alias) && NAME_RE.test(target) && alias !== target) clean[alias] = target
    }
    config.cmdAliases[key] = clean
    return clean
}

function saveConfig() {
    const tmp = `${CONFIG_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fs.renameSync(tmp, CONFIG_PATH)
}

function getRegisteredCommands() {
    const registered = new Set(BUILTIN)
    try {
        const source = fs.readFileSync(MAIN_PATH, 'utf8')
        const re = /\bcase\s+['"]([a-zA-Z0-9_]+)['"]\s*:/g
        let match
        while ((match = re.exec(source))) registered.add(match[1].toLowerCase())
    } catch (error) {
        console.error('[CMDSET] Registry scan failed:', error?.message || error)
    }
    return registered
}

function resolveCommand(command, conn) {
    let current = normalizeName(command)
    if (!current) return null
    const aliases = readAliases(conn)
    const seen = new Set()
    while (aliases[current]) {
        if (seen.has(current)) return null
        seen.add(current)
        current = normalizeName(aliases[current])
        if (!current || seen.size > 32) return null
    }
    return current
}

function isRegisteredOrAlias(command, conn) {
    const name = normalizeName(command)
    if (!NAME_RE.test(name)) return false
    const registered = getRegisteredCommands()
    if (registered.has(name)) return true
    const resolved = resolveCommand(name, conn)
    return !!resolved && registered.has(resolved)
}

function configureAlias(existingCommand, newAlias, conn) {
    const source = normalizeName(existingCommand)
    const alias = normalizeName(newAlias)
    if (!NAME_RE.test(source) || !NAME_RE.test(alias)) {
        return { ok: false, code: 'invalid', message: '❌ Invalid command or alias name. Use letters, numbers, and underscores only.' }
    }
    if (source === alias) {
        return { ok: false, code: 'invalid', message: '❌ The alias must be different from the original command.' }
    }

    const registered = getRegisteredCommands()
    const aliases = readAliases(conn)
    const target = resolveCommand(source, conn)
    if (!target || !registered.has(target)) {
        return { ok: false, code: 'unknown', message: `❌ The command *${source}* is not registered in DARKNOTE.` }
    }

    // .ss is also a native context-sensitive status-save command. It can be
    // used as an alias for VV only as a fallback when the message is not a
    // status reply; the native .ss behavior keeps priority for status replies.
    const contextualAlias = alias === 'ss'
    if (registered.has(alias) && !contextualAlias) {
        return { ok: false, code: 'conflict', message: `❌ *${alias}* is already a registered command. Choose another alias.` }
    }

    // Resolve the target before writing. This prevents alias cycles such as
    // vv -> ss -> vv and keeps stored values pointed at real commands.
    if (alias === target || resolveCommand(alias, conn) === target) {
        return { ok: false, code: 'cycle', message: `❌ That alias would create a circular or duplicate command mapping.` }
    }

    aliases[alias] = target
    config.cmdAliases = aliases
    saveConfig()
    return { ok: true, alias, target }
}

function resolveForDispatch(command, conn) {
    const name = normalizeName(command)
    if (!name) return null
    const resolved = resolveCommand(name, conn)
    if (!resolved) return name
    return resolved
}

module.exports = {
    normalizeName,
    getRegisteredCommands,
    isRegisteredOrAlias,
    resolveCommand,
    resolveForDispatch,
    configureAlias,
    saveConfig
}
