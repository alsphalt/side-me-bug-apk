'use strict'

/*
 * The Shazam "not configured correctly" message.
 *
 * The identifier reported NO_CREDENTIALS and the reply said only "Shazam is not
 * configured correctly on this bot", which names nothing and cannot be fixed
 * without reading the source. The check itself was CORRECT - the `acrcloud`
 * package is installed and the client builds fine - so the missing piece is the
 * credential, and the message now says exactly that.
 *
 * The credential tests set and clear the real variables, so they prove the check
 * works in both directions rather than only asserting today's state.
 */

const shazam = require('../lib/shazam')

const KEY_NAMES = ['ACRCLOUD_HOST', 'ACRCLOUD_ACCESS_KEY', 'ACRCLOUD_ACCESS_SECRET']

module.exports = function shazamSuite({ section, ok, eq }) {
    section('lib/shazam -- the unavailable message is specific')

    const noCreds = shazam.describeUnavailable({ code: 'NO_CREDENTIALS', reason: 'credentials are missing' }, '.')
    for (const name of KEY_NAMES) {
        ok(`it names ${name}`, noCreds.includes(name), noCreds)
    }
    ok('it says which path still works', /shazam <song name>/.test(noCreds), noCreds)
    ok('it gives a concrete example', /shazam ruger/.test(noCreds), noCreds)
    ok('the old generic wording is gone', !/not configured correctly/i.test(noCreds), noCreds)
    ok('it does not merely say "not configured"', !/^❌ Shazam is not configured/.test(noCreds), noCreds)

    const noPackage = shazam.describeUnavailable({ code: 'NO_PACKAGE', reason: 'the acrcloud package is missing' }, '.')
    ok('another failure names its own code', /NO_PACKAGE/.test(noPackage), noPackage)
    ok('another failure carries the reason', /acrcloud package is missing/.test(noPackage), noPackage)
    ok('another failure still offers the working path', /shazam <song name>/.test(noPackage), noPackage)

    const custom = shazam.describeUnavailable({ code: 'NO_CREDENTIALS', reason: 'x' }, '!')
    ok('it honours the configured prefix', custom.includes('!shazam <song name>'), custom)

    section('lib/shazam -- the credential check works in both directions')

    const saved = {}
    for (const name of KEY_NAMES) {
        saved[name] = process.env[name]
        delete process.env[name]
    }

    try {
        const absent = shazam.credentials()
        eq('no credentials -> not ready', absent.ready, false)

        const client = shazam.acrClient()
        eq('the client reports NO_CREDENTIALS', client.code, 'NO_CREDENTIALS')
        eq('it is not ok', client.ok, false)
        ok('its reason names the missing variables', /ACRCLOUD_HOST/.test(String(client.reason)), String(client.reason))
        ok('the reply built from it names them too',
            KEY_NAMES.every(name => shazam.describeUnavailable(client, '.').includes(name)))

        process.env.ACRCLOUD_HOST = 'identify-eu-west-1.acrcloud.com'
        process.env.ACRCLOUD_ACCESS_KEY = 'test-key'
        process.env.ACRCLOUD_ACCESS_SECRET = 'test-secret'

        const present = shazam.credentials()
        eq('all three present -> ready', present.ready, true)
        ok('one missing variable is still not enough', (() => {
            const hold = process.env.ACRCLOUD_ACCESS_SECRET
            delete process.env.ACRCLOUD_ACCESS_SECRET
            const partial = shazam.credentials().ready
            process.env.ACRCLOUD_ACCESS_SECRET = hold
            return partial === false
        })())

        const built = shazam.acrClient()
        ok('the client builds once the credentials exist', built.ok === true, JSON.stringify(built).slice(0, 200))
        ok('and it is no longer a NO_CREDENTIALS failure', built.code !== 'NO_CREDENTIALS')
    } finally {
        for (const name of KEY_NAMES) {
            if (saved[name] === undefined) delete process.env[name]
            else process.env[name] = saved[name]
        }
    }

    section('lib/shazam -- the name-search path needs no credentials')

    const usage = shazam.usageText('.')
    ok('the usage text offers the name search', /shazam <name>/.test(usage), usage)
    ok('and the reply path', /shazam — reply to an audio or video|shazam — reply/.test(usage), usage)
}
