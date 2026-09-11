'use strict'

/*
 * Presence collection for .listonline.
 *
 * The bug this guards: nothing ever called presenceSubscribe for group members,
 * so the cache the command reads was permanently empty and it could only ever
 * answer "No group participants are currently detected as online". Nobody was
 * offline - the bot had never asked. Each test below fails against that
 * behaviour.
 */

const groupFeatures = require('../lib/group-features')

const ALICE = '254700000001@s.whatsapp.net'
const BOB = '254700000002@s.whatsapp.net'
const CAROL = '254700000003@s.whatsapp.net'

function metadata(...jids) {
    return { participants: jids.map(id => ({ id })) }
}

/** A conn that records subscriptions and answers with whatever presence we seed. */
function fakeConn({ presence = {}, throwOnSubscribe = false } = {}) {
    const subscribed = []
    const conn = {
        user: { id: '254107287140:5@s.whatsapp.net' },
        presenceSubscribe: async jid => {
            if (throwOnSubscribe) throw new Error('refused')
            subscribed.push(jid)
        },
        __darknotePresence: new Map(Object.entries(presence))
    }
    return { conn, subscribed }
}

const online = at => ({ online: true, presence: 'available', at })
const offline = at => ({ online: false, presence: 'unavailable', at })

module.exports = async function presenceSuite({ section, ok, eq }) {
    const options = { waitMs: 0, gapMs: 0 }

    section('lib/group-features -- presence is SUBSCRIBED before it is read')

    {
        const { conn, subscribed } = fakeConn()
        await groupFeatures.collectPresence(conn, metadata(ALICE, BOB, CAROL), options)
        eq('every participant was subscribed to', subscribed.sort(), [ALICE, BOB, CAROL].sort())
    }

    {
        const { conn, subscribed } = fakeConn()
        await groupFeatures.collectPresence(conn, metadata(ALICE, ALICE, BOB), options)
        eq('a duplicate participant is subscribed once', subscribed.sort(), [ALICE, BOB].sort())
    }

    {
        // A participant carrying both a phone JID and a LID gets both subscribed.
        const { conn, subscribed } = fakeConn()
        await groupFeatures.collectPresence(conn, {
            participants: [{ id: ALICE, lid: '11111111111111@lid' }]
        }, options)
        eq('both JID forms of a participant are subscribed', subscribed.sort(), [ALICE, '11111111111111@lid'].sort())
    }

    section('lib/group-features -- the wait actually happens')

    {
        const { conn } = fakeConn()
        const started = Date.now()
        await groupFeatures.collectPresence(conn, metadata(ALICE), { waitMs: 120, gapMs: 0 })
        ok('it waits for updates to arrive before reading', Date.now() - started >= 110,
            `${Date.now() - started}ms`)
    }

    section('lib/group-features -- the reported source is honest')

    {
        const { conn } = fakeConn()
        const result = await groupFeatures.collectPresence(conn, metadata(ALICE, BOB), options)
        eq('nothing arrived -> no-presence', result.source, 'no-presence')
        eq('nothing is listed online', result.online.length, 0)
        eq('nothing is claimed offline either', result.offline.length, 0)
        eq('it reports how many subscriptions it attempted', result.requested, 2)
    }

    {
        const { conn } = fakeConn({ presence: { [ALICE]: online(Date.now()) } })
        const result = await groupFeatures.collectPresence(conn, metadata(ALICE, BOB), options)
        eq('a fresh update -> live', result.source, 'live')
        eq('the online member is listed', result.online.map(p => p.id), [ALICE])
        eq('it counts the fresh entry', result.fresh, 1)
    }

    {
        const { conn } = fakeConn({
            presence: { [ALICE]: online(Date.now()), [BOB]: offline(Date.now()) }
        })
        const result = await groupFeatures.collectPresence(conn, metadata(ALICE, BOB), options)
        eq('online and offline are split correctly', result.online.map(p => p.id), [ALICE])
        eq('the offline member is reported as offline', result.offline.map(p => p.id), [BOB])
        eq('source is live when at least one entry is fresh', result.source, 'live')
    }

    {
        const old = Date.now() - 10 * 60 * 1000
        const { conn } = fakeConn({ presence: { [ALICE]: online(old) } })
        const result = await groupFeatures.collectPresence(conn, metadata(ALICE), options)
        eq('only stale data -> stale', result.source, 'stale')
    }

    {
        const { conn } = fakeConn()
        conn.presenceSubscribe = undefined
        const result = await groupFeatures.collectPresence(conn, metadata(ALICE), options)
        eq('a build without presenceSubscribe -> unsupported', result.source, 'unsupported')
        eq('nothing is claimed about anyone', result.online.length + result.offline.length, 0)
    }

    {
        const { conn } = fakeConn({ throwOnSubscribe: true })
        const result = await groupFeatures.collectPresence(conn, metadata(ALICE, BOB), options)
        eq('every subscription refused -> subscribe-failed', result.source, 'subscribe-failed')
        eq('it counts the refusals', result.refused, 2)
    }

    section('lib/group-features -- a large group is capped, not flooded')

    {
        const many = Array.from({ length: 12 }, (_, index) => `25470000${String(index).padStart(4, '0')}@s.whatsapp.net`)
        const { conn, subscribed } = fakeConn()
        const result = await groupFeatures.collectPresence(conn, metadata(...many), { waitMs: 0, gapMs: 0, cap: 5 })
        eq('only the cap was subscribed', subscribed.length, 5)
        eq('it says it was capped', result.capped, true)
        eq('it reports the real number attempted', result.requested, 5)
    }

    section('lib/group-features -- the newest entry wins across JID forms')

    {
        // The phone JID is known but a minute old; the LID is current. The newer
        // entry must win, because that is the one that reflects now.
        const presence = new Map([
            [ALICE, offline(Date.now() - 60000)],
            ['11111111111111@lid', online(Date.now())]
        ])
        const entry = groupFeatures.presenceEntryFor(presence, { id: ALICE, lid: '11111111111111@lid' })
        ok('the freshest entry is chosen, whichever JID form it arrived under', entry?.online === true, JSON.stringify(entry))
        eq('a missing participant yields null', groupFeatures.presenceEntryFor(presence, { id: '254799999999@s.whatsapp.net' }), null)
    }

    section('lib/group-features -- the empty state is SPECIFIC, not "nobody is online"')

    {
        const noPresence = groupFeatures.describeEmptyPresence({ source: 'no-presence', requested: 12 })
        ok('it says presence was requested', /Presence was requested for 12/.test(noPresence), noPresence)
        ok('it explicitly denies meaning "everyone is offline"',
            /not the same as everyone being offline/i.test(noPresence), noPresence)

        const failed = groupFeatures.describeEmptyPresence({ source: 'subscribe-failed', refused: 3, requested: 3 })
        ok('a refusal is described as a refusal', /refused every presence subscription/i.test(failed), failed)

        const unsupported = groupFeatures.describeEmptyPresence({ source: 'unsupported' })
        ok('an unsupported build is called out', /does not expose presenceSubscribe/i.test(unsupported), unsupported)

        const stale = groupFeatures.describeEmptyPresence({ source: 'stale' })
        ok('stale data is called stale', /none is recent/i.test(stale), stale)

        const allOffline = groupFeatures.describeEmptyPresence({ source: 'live' })
        ok('the one case that IS "everyone offline" says so', /every member who reported is currently offline/i.test(allOffline), allOffline)

        const messages = [noPresence, failed, unsupported, stale, allOffline]
        eq('every source gets its own distinct sentence', new Set(messages).size, messages.length)
        for (const message of messages) {
            ok('no generic "no group participants detected" wording survives',
                !/no group participants are currently detected/i.test(message), message)
        }
    }
}
