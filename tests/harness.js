'use strict'

/*
 * Minimal assertion harness.
 *
 * The repository had no test runner and no test files at all, even though
 * several modules refer to "the test suite" in their comments. Adding a real
 * runner would mean adding a dependency to a bot that ships as a WhatsApp
 * client, so this is deliberately tiny: sections, two assertion helpers and a
 * report. No dependencies, no globals, no config.
 */

const state = { passed: 0, failed: 0, failures: [], section: '' }

function section(title) {
    state.section = title
    console.log(`\n${title}`)
}

function ok(name, condition, detail = '') {
    if (condition) {
        state.passed++
        console.log(`  PASS  ${name}`)
        return true
    }
    state.failed++
    const where = state.section ? `${state.section} / ` : ''
    state.failures.push(`${where}${name}${detail ? ` -- ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
    return false
}

/** Structural equality, so objects and arrays can be compared directly. */
function eq(name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    return ok(name, a === e, a === e ? '' : `expected ${e}, got ${a}`)
}

function report() {
    const total = state.passed + state.failed
    console.log(`\n${'='.repeat(64)}`)
    console.log(`${state.passed}/${total} passed, ${state.failed} failed`)
    if (state.failed) {
        console.log('\nFailures:')
        for (const failure of state.failures) console.log(`  - ${failure}`)
    }
    console.log('='.repeat(64))
    return state.failed === 0
}

module.exports = { section, ok, eq, report, state }
