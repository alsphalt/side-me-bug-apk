'use strict'

/*
 * DARKNOTE AI — file analysis module (PDF / DOCX / TXT / code).
 *
 * VERIFIED STATUS: NOT AVAILABLE. No provider on this platform exposes a file
 * or document parameter, and the gateway prompt cap (302 characters on the
 * ?prompt= family) would make uploading document text impossible anyway. Text
 * that already fits inside the prompt budget can be pasted directly into a
 * normal chat message, which the chatbot already handles.
 *
 * Intended flow once a provider exists:
 *   file -> extract text (local) -> chunk -> summarise -> ask -> answer
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'files',
    label: 'File analysis',
    toggle: 'files',
    capability: 'fileAnalysis',
    providerRequirement: 'a provider that accepts a file or document input and has been verified doing so',
    howToEnable: 'Register a verified provider with capability fileAnalysis: true, then add the local text-extraction step.'
})
