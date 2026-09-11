'use strict'

/*
 * Response timing.
 *
 * The owner asked for the AI to answer in 5 seconds, so that is asserted
 * directly rather than described. timing.delayFor() draws from a window, so a
 * test that only checked the config could not prove what a reply actually
 * waits - these assertions go through delayFor() itself.
 */

const timing = require('../ai/timing')
const config = require('../ai/config')

module.exports = function timingSuite({ section, ok, eq }) {
    const settings = config.getAiSettings()

    section('ai/timing -- every configured window is 5 seconds')

    for (const key of [
        'replyDelayShortMinMs', 'replyDelayShortMaxMs',
        'replyDelayLongMinMs', 'replyDelayLongMaxMs',
        'groupDelayMinMs', 'groupDelayMaxMs',
        'ownerNormalDelayMinMs', 'ownerNormalDelayMaxMs',
        'ownerLongDelayMinMs', 'ownerLongDelayMaxMs'
    ]) {
        eq(`${key} is 5000ms`, settings[key], 5000)
    }
    eq('ownerShortDelayMs is 5000ms', settings.ownerShortDelayMs, 5000)

    eq('Auto Human Reply pacing totals 5 seconds',
        settings.autohumanAnalyseMs + settings.autohumanGenerateMs + settings.autohumanPreSendMs,
        5000)

    section('ai/timing -- a reply actually waits 5 seconds')

    const exact = [
        ['a short DM', { text: 'hey' }],
        ['a normal DM', { text: 'see you tomorrow at the usual place ok' }],
        ['a long DM', { text: 'why does this keep failing every single time we try it' }],
        ['a group reply', { text: 'hey', isGroup: true }],
        ['a first-turn DM', { text: 'hey', isFirstTurn: true }],
        ['an owner normal message', { text: 'see you tomorrow at the usual place ok', isOwner: true }],
        ['an owner long message', { text: 'why does this keep failing every single time we try it', isOwner: true }]
    ]
    for (const [label, options] of exact) {
        eq(`${label} waits exactly 5s`, timing.delayFor({ ...options, settings }), 5000)
    }

    /*
     * The owner SHORT case is the one deliberate exception in windowFor(): a
     * single-value delay is wrapped in a narrow band (x0.92 to x1.05) so the bot
     * is not a metronome. It lands around 5s rather than exactly on it, which is
     * why it is asserted as a band instead of an exact figure.
     */
    const ownerShort = timing.delayFor({ text: 'hey', isOwner: true, settings })
    ok('an owner short message lands in a narrow band around 5s',
        ownerShort >= 4600 && ownerShort <= 5250, `${ownerShort}ms`)

    section('ai/timing -- the delay is never minutes')

    for (const text of ['hey', 'see you tomorrow at the usual place ok', 'why does this keep failing']) {
        const delay = timing.delayFor({ text, settings })
        ok(`"${text.slice(0, 24)}" is under 10s`, delay <= 10000, `${delay}ms`)
    }

    section('ai/timing -- timing can still be switched off')

    eq('it returns 0 when response timing is disabled',
        timing.delayFor({ text: 'hey', settings: { ...settings, responseTimingEnabled: false } }), 0)
    eq('it returns 0 when the legacy key is off',
        timing.delayFor({ text: 'hey', settings: { ...settings, timingEnabled: false, responseTimingEnabled: undefined } }), 0)

    section('ai/timing -- classification is unchanged')

    eq('one word is short', timing.classify('hey'), 'short')
    eq('a plain sentence is normal', timing.classify('see you tomorrow at the usual place ok'), 'normal')
    eq('a multi-clause question is long', timing.classify('why does this keep failing every single time we try it'), 'long')
    eq('an empty message is short', timing.classify(''), 'short')
}
