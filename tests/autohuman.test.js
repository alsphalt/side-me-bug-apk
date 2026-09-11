'use strict'

/*
 * Auto Human Reply. The feature was invisible and switched off, and it also
 * stored every incoming message twice. These tests pin all three.
 */

const fs = require('fs')
const path = require('path')

const autohuman = require('../ai/autohuman')
const configFile = require('../config.json')

module.exports = function autohumanSuite({ section, ok, eq }) {
    const dm = {
        chat: '254700000000@s.whatsapp.net',
        key: { remoteJid: '254700000000@s.whatsapp.net' },
        fromMe: false,
        text: 'hey, are you around?',
        pushName: 'Test',
        mtype: 'conversation',
        sender: '254700000000@s.whatsapp.net'
    }
    const group = {
        ...dm,
        chat: '12345@g.us',
        key: { remoteJid: '12345@g.us' },
        isGroup: true,
        sender: '254700000000@s.whatsapp.net'
    }
    const conn = { user: { id: '254700000001:1@s.whatsapp.net' } }

    section('ai/autohuman -- the switch is actually on')

    ok('config.json has autohumanEnabled true', configFile.ai.autohumanEnabled === true)
    ok('the module agrees it is enabled', autohuman.enabled() === true)

    section('ai/autohuman -- what it refuses to answer')

    const own = autohuman.evaluate(conn, { ...dm, fromMe: true }, { mode: 'public' })
    ok('never answers its own message', own.ok === false && own.reason === 'from-me', JSON.stringify(own))

    const command = autohuman.evaluate(conn, { ...dm, text: '.menu' }, { mode: 'public', prefix: '.' })
    ok('never answers a command', command.ok === false && command.reason === 'command', JSON.stringify(command))

    const blank = autohuman.evaluate(conn, { ...dm, text: '   ' }, { mode: 'public' })
    ok('ignores an empty message', blank.ok === false && blank.reason === 'empty', JSON.stringify(blank))

    const statusMsg = autohuman.evaluate(conn, {
        ...dm,
        chat: 'status@broadcast',
        key: { remoteJid: 'status@broadcast' }
    }, { mode: 'public' })
    ok('ignores a status broadcast', statusMsg.ok === false && statusMsg.reason === 'status', JSON.stringify(statusMsg))

    const silent = autohuman.evaluate(conn, dm, { mode: 'self', isOwner: false })
    ok('stays silent in self mode for a non-owner',
        silent.ok === false && silent.reason === 'self-mode', JSON.stringify(silent))

    const chatter = autohuman.evaluate(conn, group, { mode: 'public' })
    ok('ignores unmentioned group chatter',
        chatter.ok === false && chatter.reason === 'group-not-mentioned', JSON.stringify(chatter))

    const eligible = autohuman.evaluate(conn, dm, { mode: 'public' })
    ok('answers a plain DM', eligible.ok === true && eligible.kind === 'dm', JSON.stringify(eligible))
    ok('keys the conversation per contact', eligible.key === 'd:254700000000', String(eligible.key))

    section('ai/autohuman -- the prompt carries the conversation')

    const lines = [
        { who: 'them', t: 'hello there' },
        { who: 'me', t: 'hey, what is up' },
        { who: 'them', t: 'nothing much, you?' }
    ]
    const built = autohuman.buildPrompt({ longPromptBudget: 880 }, lines, dm)

    ok('includes the newest incoming line (the one being answered)',
        built.prompt.includes('nothing much, you?'), built.prompt)
    ok('includes both sides of the conversation',
        built.prompt.includes('hello there') && built.prompt.includes('hey, what is up'))
    ok('labels the bot as "you" and the other person as "them"',
        built.prompt.includes('you: hey, what is up') && built.prompt.includes('them: hello there'))
    ok('instructs the model that it is not an assistant', /not an assistant/i.test(built.prompt))
    ok('asks for only the next message', /ONLY your next message/i.test(built.prompt))
    ok('reports how many lines it included', built.included === lines.length, String(built.included))

    section('ai/autohuman -- the window is trimmed to fit, newest first')

    const longLines = [
        { who: 'them', t: 'a'.repeat(200) },
        { who: 'me', t: 'b'.repeat(200) },
        { who: 'them', t: 'the newest message' }
    ]
    const tight = autohuman.buildPrompt({ longPromptBudget: 400 }, longLines, dm)
    ok('keeps the newest line', tight.prompt.includes('the newest message'))
    ok('drops the oldest line rather than overflowing',
        !tight.prompt.includes('aaaa'), tight.prompt)
    ok('drops at least one line', tight.included < longLines.length, String(tight.included))
    ok('adds no more than the wide window did',
        tight.prompt.length <= built.prompt.length, `${tight.prompt.length} vs ${built.prompt.length}`)

    section('ai/autohuman -- no customer-service phrasing is sent')

    ok('detects "how can I help"', autohuman.roboticHits('How can I help you today?').length > 0)
    ok('detects "let me know if you need"', autohuman.roboticHits('Let me know if you need anything.').length > 0)
    ok('detects "I am here to help"', autohuman.roboticHits('I am here to help.').length > 0)
    ok('a normal reply is clean', autohuman.roboticHits('haha yeah I am good, you?').length === 0)

    eq('strips the assistant sentence and keeps the rest',
        autohuman.sanitise('Cool, see you then. How can I help you today?'), 'Cool, see you then.')
    eq('drops a reply that is entirely assistant-style',
        autohuman.sanitise('How can I help you today?'), '')
    eq('keeps a clean reply intact', autohuman.sanitise('yeah just chilling'), 'yeah just chilling')

    section('ai/autohuman -- the incoming message is recorded exactly once')

    /*
     * The regression this guards: handle() appends the incoming line before
     * generating (so the prompt contains the message being answered), and run()
     * used to append it AGAIN after sending. Every turn therefore stored the
     * person's message twice, so the 15-message window covered half as much real
     * conversation as it claimed and the prompt budget was spent on duplicates.
     */
    const source = fs.readFileSync(path.join(__dirname, '..', 'ai', 'autohuman.js'), 'utf8')
    const incomingAppends = source.match(/appendTranscript\([^)]*who:\s*'them'/g) || []
    eq('exactly one place records the incoming message', incomingAppends.length, 1)

    const replyAppends = source.match(/appendTranscript\([^)]*who:\s*'me'/g) || []
    eq('exactly one place records our reply', replyAppends.length, 1)
}
