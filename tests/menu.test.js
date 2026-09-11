'use strict'

/*
 * The menu is generated from the dispatcher registry, so these assertions cover
 * both "is the command registered" and "is it advertised". The Auto Human Reply
 * bug was exactly a mismatch between those two.
 */

const menu = require('../lib/menu')
const { getRegisteredCommands } = require('../lib/command-system')

module.exports = function menuSuite({ section, ok }) {
    section('lib/menu -- Auto Human Reply is discoverable')

    const listed = menu.listCommands()
    const unique = new Set(listed)

    ok('.autohuman IS listed (the command the owner could not find)', unique.has('autohuman'))
    ok('.autohuman is not also treated as internal', menu.isInternal('autohuman') === false)

    section('lib/menu -- .kickall is exposed in GROUP')

    ok('.kickall IS listed', unique.has('kickall'))

    section('lib/menu -- the rest of the AI family stays unlisted')

    for (const name of ['chatbot', 'chatbotdelay', 'replydelay', 'darknote', 'ask',
        'statusview', 'statuslike', 'statusreact', 'aisticker', 'aivision']) {
        ok(`.${name} stays hidden`, !unique.has(name))
    }

    section('lib/menu -- registration comes from the dispatcher')

    const registered = getRegisteredCommands()
    ok('the registry finds kickall in BIGBRO.js', registered.has('kickall'))
    ok('the registry finds autohuman in BIGBRO.js', registered.has('autohuman'))
    ok('the registry still finds kick', registered.has('kick'))

    section('lib/menu -- rendering')

    const built = menu.build({ prefix: '.' }, { mode: 'PUBLIC', number: '254700000000', ping: 12, runtime: '1m' })
    ok('the rendered menu shows .autohuman', built.text.includes('.autohuman'))
    ok('the rendered menu shows .kickall', built.text.includes('.kickall'))
    ok('the rendered menu does not show .chatbot', !built.text.includes('.chatbot'))
    ok('the AI section is present', built.text.includes('AI'))
    ok('nothing carries usage text', !/\.\w+\s+</.test(built.text), 'the menu must print bare command names')
    ok('the reported count matches the listed commands',
        built.count === unique.size, `${built.count} vs ${unique.size}`)
}
