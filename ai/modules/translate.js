'use strict'

/*
 * DARKNOTE AI — translation module.
 *
 * VERIFIED STATUS: PARTIALLY AVAILABLE, NOT WIRED IN.
 * A SEPARATE endpoint was tested and it WORKS:
 *   GET /api/tools/translate?text=<text>&to=sw&apikey=<key>
 *   verified: "good morning" -> "habari za asubuhi"
 *
 * IMPORTANT NUANCE: the chatbot ALREADY handles ordinary translation by simply
 * following the user's language (verified for English, Kiswahili and Sheng).
 * This module is for EXPLICIT translation requests where a deterministic
 * translator is better than a chat model - "translate this exactly".
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'translate',
    label: 'Translation',
    toggle: 'translate',
    capability: 'translation',
    providerRequirement: 'a verified translation endpoint (/api/tools/translate tested working)',
    howToEnable: 'Wire /api/tools/translate into this module for explicit .aitranslate requests.'
})
