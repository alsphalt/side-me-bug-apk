'use strict'

/*
 * The status-author resolution that broke status reactions.
 *
 * The console showed, for a Status posted by a LID:
 *   [ARS] broadcast reaction failed, trying the author directly: not-acceptable
 *   [ARS] status action failed: Error: not-acceptable
 *
 * Because a LID's digits were turned into `<digits>@s.whatsapp.net`. The tests
 * below pin the invariant that a LID NEVER produces a phone JID.
 */

const statusAuthor = require('../lib/status-author')

/*
 * Mirrors lib/msg.js: resolveLidEnhanced returns the LID UNCHANGED when it has
 * no mapping. Any test that treated that as success would pass here and fail in
 * production, which is exactly the bug, so the real behaviour is reproduced.
 */
const resolver = mapping => ({ resolveLidEnhanced: async lid => mapping[lid] || lid })

module.exports = async function statusAuthorSuite({ section, ok, eq }) {
    const LID = '39252410810457@lid'
    const PN = '254700000000@s.whatsapp.net'

    section('lib/status-author -- a phone-number author (nothing to resolve)')

    {
        const author = await statusAuthor.resolveStatusAuthor({}, { key: { participant: PN } })
        eq('the participant is kept as-is', author.raw, PN)
        eq('it is treated as a usable phone JID', author.pn, PN)
        eq('no LID is reported', author.lid, '')
    }

    section('lib/status-author -- a LID author that CAN be resolved')

    {
        const conn = resolver({ [LID]: PN })
        const author = await statusAuthor.resolveStatusAuthor(conn, { key: { participant: LID } })
        eq('the raw participant is preserved', author.raw, LID)
        eq('it resolves to a phone JID', author.pn, PN)
        eq('the LID is cleared once resolved', author.lid, '')
    }

    section('lib/status-author -- a LID author that CANNOT be resolved')

    {
        // The real-world case from the console: no mapping exists.
        const author = await statusAuthor.resolveStatusAuthor(resolver({}), { key: { participant: LID } })
        eq('no phone JID is invented', author.pn, '')
        eq('the LID is reported instead', author.lid, LID)
        /*
         * THE REGRESSION. The old code did digits(participant) + '@s.whatsapp.net',
         * producing '39252410810457@s.whatsapp.net' - a JID that does not exist.
         */
        ok('the LID digits are NEVER turned into a phone JID',
            !String(author.pn).includes('39252410810457'),
            `pn was ${JSON.stringify(author.pn)}`)
    }

    section('lib/status-author -- a build with no resolver at all')

    {
        const author = await statusAuthor.resolveStatusAuthor({}, { key: { participant: LID } })
        eq('it degrades to "unresolved" instead of inventing a JID', author.pn, '')
        eq('the LID is still reported', author.lid, LID)
    }

    section('lib/status-author -- a resolver that fails')

    {
        const conn = { resolveLidEnhanced: async () => { throw new Error('resolver exploded') } }
        const author = await statusAuthor.resolveStatusAuthor(conn, { key: { participant: LID } })
        eq('a throwing resolver does not take the caller down', author.pn, '')
        eq('the LID is reported as unresolved', author.lid, LID)
    }

    section('lib/status-author -- a resolver that returns another LID')

    {
        const other = '11111111111111@lid'
        const author = await statusAuthor.resolveStatusAuthor(resolver({ [LID]: other }), { key: { participant: LID } })
        eq('a second LID is not accepted as a phone number', author.pn, '')
        eq('the original LID is what gets reported', author.lid, LID)
    }

    section('lib/status-author -- other shapes')

    {
        const viaItem = await statusAuthor.resolveStatusAuthor({}, { participant: PN })
        eq('falls back to item.participant', viaItem.pn, PN)

        const missing = await statusAuthor.resolveStatusAuthor({}, { key: {} })
        eq('a missing participant yields nothing', missing.pn, '')
        eq('a missing participant reports no LID', missing.lid, '')

        ok('isLid detects a LID', statusAuthor.isLid(LID) === true)
        ok('isLid rejects a phone JID', statusAuthor.isLid(PN) === false)
    }

    section('lib/status-author -- JID comparison')

    {
        eq('a device suffix is ignored', statusAuthor.normalizeForCompare('254700000000:12@s.whatsapp.net'), PN)
        eq('the domain is kept', statusAuthor.normalizeForCompare(LID), LID)
        ok('identical digits in different domains do NOT compare equal',
            statusAuthor.normalizeForCompare('39252410810457@lid') !== statusAuthor.normalizeForCompare('39252410810457@s.whatsapp.net'))
        eq('an empty value stays empty', statusAuthor.normalizeForCompare(''), '')
    }

    section('lib/status-author -- never reacts to the paired account\'s own Status')

    {
        const conn = { user: { id: '254107287140:5@s.whatsapp.net', lid: LID } }

        ok('the account\'s own phone JID is recognised',
            statusAuthor.isOwnStatus(conn, { raw: '254107287140@s.whatsapp.net', pn: '254107287140@s.whatsapp.net' }) === true)
        ok('the account\'s own LID is recognised',
            statusAuthor.isOwnStatus(conn, { raw: LID, pn: '' }) === true)
        ok('someone else is not mistaken for the account',
            statusAuthor.isOwnStatus(conn, { raw: PN, pn: PN }) === false)
        ok('an empty author is not an own-status match',
            statusAuthor.isOwnStatus(conn, { raw: '', pn: '' }) === false)
    }
}
