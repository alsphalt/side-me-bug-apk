#!/usr/bin/env node
'use strict'

/*
 * DARKNOTE L2 — source protection.
 *
 * Obfuscates the sensitive command modules with the project's existing
 * javascript-obfuscator pipeline (the same one scripts/protect-downloader.js
 * uses for ytdl) and writes <name>.protected.js next to each readable source.
 * BIGBRO.js loads the protected build when it is present.
 *
 * BE CLEAR ABOUT WHAT THIS IS: obfuscation, not cryptographic encryption. It
 * defeats casual reading, copying and grep-ing for the protocol details. It is
 * not mathematically reversible-proof. To make it meaningful when you hand the
 * bot to somebody else, do not ship the readable source files alongside.
 *
 * Usage:  npm run protect
 */

const fs = require('fs')
const path = require('path')

// Modules to protect. Add an entry to protect another module.
//   source: the readable file in lib/ (without .js)
//   output: the protected file to write (without .protected.js)
const TARGETS = [
  { source: 'block-status', output: 'block-status' },
  { source: 'shazam', output: 'shazam' },
  // ytdl keeps its readable implementation in ytdl.source.js because
  // lib/ytdl.js is the loader shim every consumer already requires.
  { source: 'ytdl.source', output: 'ytdl' }
]
const LIB = path.join(__dirname, '..', 'lib')

const OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.65,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 8,
  transformObjectKeys: false,
  unicodeEscapeSequence: false
}

let JavaScriptObfuscator
try {
  JavaScriptObfuscator = require('javascript-obfuscator')
} catch (error) {
  console.error('[PROTECT] javascript-obfuscator is not installed. Run: npm install')
  process.exit(1)
}

let failures = 0

for (const target of TARGETS) {
  const name = target.source
  const label = target.output
  const source = path.join(LIB, `${name}.js`)
  const output = path.join(LIB, `${label}.protected.js`)

  if (!fs.existsSync(source)) {
    console.error(`[PROTECT] source not found, skipping: ${source}`)
    failures++
    continue
  }

  try {
    const code = fs.readFileSync(source, 'utf8')
    const obfuscated = JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode()

    // Verify the obfuscated build actually loads and exposes an API BEFORE it
    // replaces anything. A broken build must never overwrite a good one.
    const probe = path.join(LIB, `.probe-${label}.js`)
    fs.writeFileSync(probe, obfuscated)
    let protectedExports = []
    try {
      const loaded = require(probe)
      protectedExports = loaded && typeof loaded === 'object' ? Object.keys(loaded).sort() : []
    } finally {
      try { delete require.cache[require.resolve(probe)] } catch { }
      try { fs.unlinkSync(probe) } catch { }
    }

    if (!protectedExports.length) throw new Error('the obfuscated build exported nothing')

    // The protected build must expose exactly the same API as the source, or a
    // consumer would break at runtime.
    const sourceExports = Object.keys(require(source)).sort()
    const missing = sourceExports.filter(key => !protectedExports.includes(key))
    if (missing.length) throw new Error(`the obfuscated build is missing exports: ${missing.join(', ')}`)

    fs.writeFileSync(output, obfuscated)
    console.log(`[PROTECT] ${name}.js -> ${label}.protected.js (${code.length} -> ${obfuscated.length} bytes, ${protectedExports.length} exports match the source)`)
  } catch (error) {
    console.error(`[PROTECT] ${label} failed:`, error?.message || error)
    console.error('[PROTECT] tip: run this where the dependencies are installed (npm install).')
    failures++
  }
}

if (failures) {
  console.error(`[PROTECT] ${failures} module(s) failed; existing protected builds were left untouched.`)
  process.exit(1)
}
console.log('[PROTECT] done.')
