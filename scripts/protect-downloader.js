#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

// The readable implementation moved to ytdl.source.js because lib/ytdl.js is now
// the loader shim. `npm run protect` is the general entry point and covers this.
const source = path.join(__dirname, '..', 'lib', 'ytdl.source.js')
const output = path.join(__dirname, '..', 'lib', 'ytdl.protected.js')

let JavaScriptObfuscator
try {
  JavaScriptObfuscator = require('javascript-obfuscator')
} catch {
  console.error('[PROTECT] javascript-obfuscator is not installed. Run: npm install')
  process.exit(1)
}

const code = fs.readFileSync(source, 'utf8')
const result = JavaScriptObfuscator.obfuscate(code, {
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
})

fs.writeFileSync(output, result.getObfuscatedCode())
console.log(`[PROTECT] Protected downloader written to ${output}`)
