'use strict'

/*
 * DARKNOTE MENU — generated, never hand-maintained.
 *
 * THE TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 *   1. NAMES ONLY. An entry is `prefix + command` and nothing else. No `<args>`,
 *      no `on|off`, no usage text, no descriptions. If a command takes options,
 *      the menu still shows only the command - the user finds out how to use it
 *      by using it. This is checked by stripArgs() below, which is applied to
 *      every single entry as it is rendered, so a usage string cannot leak into
 *      the menu even if the registry somehow carried one.

 *   2. ONE ENTRY PER COMMAND. Every command is funnelled through one Set before
 *      rendering, so a command that appears in two categories, or that is
 *      registered twice, still prints exactly once.
 *
 * The command list comes from the EXISTING registry (`getRegisteredCommands()`,
 * which scans the real dispatcher). There is no second list of commands to keep
 * in sync: registering a command is all it takes for it to appear here.
 */

const { getRegisteredCommands } = require('./command-system')

/*
 * INTERNAL DISPATCH CASES, not user commands.
 *
 * Button handlers reach the dispatcher through the same switch, so the registry
 * legitimately contains entries like `ytvideo_select` and `shazam_audio`. They
 * are parts of a button protocol (they carry result indices), cannot be typed by
 * a user, and must not be advertised as commands. The previous menu special-cased
 * two of them by hand; this catches the whole family.
 */
const INTERNAL_COMMAND = /^(ytvideo_select|song_audio|shazam_(?:audio|play|file|video))$/i

const isInternal = name => INTERNAL_COMMAND.test(String(name || ''))

/*
 * Presentation only. A category that names a command which is not registered is
 * silently dropped, so this table can never invent a command that does not
 * exist. Anything registered but not named here still appears, under MORE.
 */
const CATEGORIES = [
    { title: 'MAIN', names: ['menu', 'allmenu', 'ping', 'info', 'owner', 'cekowner', 'myjid', 'public', 'self', 'runtime', 'alive', 'state'] },
    { title: 'AI', names: ['chatbot', 'autohuman', 'aistatus', 'ai', 'darknote', 'aimemory', 'aiforget', 'aimem', 'aireset', 'aiset', 'aicap'] },
    { title: 'GROUP', names: ['tagall', 'hidetag', 'listonline', 'listactive', 'listinactive', 'groupadmins', 'groupadmin', 'admin', 'groupjid', 'channeljid', 'gpstatus', 'gppp', 'kick', 'add', 'promote', 'demote', 'leave', 'join', 'approveall', 'rejectall', 'creategc'] },
    { title: 'SECURITY', names: ['antilink', 'antidelete', 'antidelete1', 'antidelete2', 'antidelete3', 'antidelete4', 'anticall', 'antidemote', 'antikick', 'antiadd', 'antipromote', 'antisticker', 'antimedia', 'antiviewonce', 'antimentionstatus', 'antienforce', 'block', 'unblock', 'call'] },
    { title: 'MEDIA', names: ['vv', 'vv2', 'vv2auto', 'conver', 'ss', 'sss', 'getpp', 'steal', 'pp', 'setstatus', 'setgcpp', 'avs', 'als', 'ars', 'autoread', 'autotyping', 'autorecoding'] },
    { title: 'AI EDIT', names: ['edit', 'reedit', 'editphoto', 'editsticker'] },
    { title: 'STICKER', names: ['sticker', 's', 'stckcmd'] },
    { title: 'DOWNLOAD', names: ['ytvideo', 'song', 'shazam', 'instagram', 'igstalk', 'ytdl', 'play'] },
    { title: 'OWNER', names: ['addowner', 'delowner', 'addprem', 'delprem', 'cmdset', 'setprefix', 'eval', 'shell', 'restart', 'broadcast', 'evil_pain'] }
]

/*
 * Strip anything that is not the command itself.
 *
 * Defensive by design: the registry returns bare names today, but a menu that
 * silently starts printing `.song <query>` because something upstream changed
 * is exactly the regression this brief is asking to prevent.
 */
function stripArgs(raw) {
    return String(raw || '')
        .trim()
        .replace(/^[.!\/#]/, '')     // any leading prefix
        .split(/[\s<\[(]/)[0]        // drop arguments / usage / brackets
        .replace(/[^a-z0-9_]/gi, '') // keep identifier characters only
        .toLowerCase()
}

/**
 * Build the menu text.
 *
 * @param {object} config  the bot config (for `prefix`)
 * @param {object} [info]  header figures: { mode, number, ping, runtime }
 */
function build(config, info = {}) {
    const prefix = String(config?.prefix || '.')
    const registered = getRegisteredCommands()
    const shown = new Set()
    const sections = []

    for (const category of CATEGORIES) {
        const lines = []
        for (const raw of category.names) {
            const name = stripArgs(raw)
            if (!name || shown.has(name)) continue
            if (isInternal(name)) continue         // button protocol, not a command
            if (!registered.has(name)) continue    // never advertise an unregistered command
            shown.add(name)
            lines.push(`  ${prefix}${name}`)
        }
        if (lines.length) sections.push(`〔 ${category.title} 〕\n${lines.join('\n')}`)
    }

    // Anything registered but not categorised still has to be reachable.
    const rest = [...registered]
        .map(stripArgs)
        .filter(name => name && !shown.has(name) && !isInternal(name))
        .sort()
    if (rest.length) {
        sections.push(`〔 MORE 〕\n${rest.map(name => `  ${prefix}${name}`).join('\n')}`)
    }

    const header = [
        '╭────────────────────╮',
        '│ ✞ DARKNOTE L2',
        '│',
        `│ Mode   : ${info.mode || 'PUBLIC'}`,
        `│ Number : ${info.number || '-'}`,
        `│ Ping   : ${Number.isFinite(info.ping) ? `${Math.floor(info.ping)} ms` : '-'}`,
        `│ Uptime : ${info.runtime || '-'}`,
        `│ Commands: ${shown.size + rest.length}`,
        '╰────────────────────╯'
    ].join('\n')

    return {
        text: `${header}\n\n${sections.join('\n\n')}`,
        count: shown.size + rest.length,
        sections: sections.length
    }
}

/** Every command the menu lists, for tests and for the uniqueness guarantee. */
function listCommands() {
    return [...getRegisteredCommands()].map(stripArgs).filter(name => name && !isInternal(name))
}

module.exports = { build, listCommands, stripArgs, isInternal, CATEGORIES }
