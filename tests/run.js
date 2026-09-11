'use strict'

/*
 * DARKNOTE test runner.
 *
 *   node tests/run.js
 *
 * Exits non-zero when anything fails, so a shell `&&` or CI can gate on it.
 * Every suite is a module exporting a function that receives the harness and
 * may return a promise (the router suite drives async code).
 */

const harness = require('./harness')

const suites = [
    require('./ai-providers.test'),
    require('./ai-router.test'),
    require('./menu.test'),
    require('./autohuman.test')
]

;(async () => {
    for (const suite of suites) {
        try {
            await suite(harness)
        } catch (error) {
            harness.section(suite.name || 'unnamed suite')
            harness.ok('suite ran without throwing', false, error?.stack || String(error))
        }
    }
    process.exit(harness.report() ? 0 : 1)
})()
