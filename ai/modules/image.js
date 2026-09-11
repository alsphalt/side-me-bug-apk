'use strict'

/*
 * DARKNOTE AI — image generation module.
 *
 * VERIFIED STATUS: PARTIALLY AVAILABLE, NOT WIRED IN.
 * A SEPARATE endpoint was tested and it WORKS:
 *   GET /api/fluxv2?prompt=<text>&apikey=<key>  -> returns an image URL
 * The sibling /api/ai/flux is BROKEN (502 PROVIDER_ERROR) and must not be used.
 *
 * No CHAT provider can generate an image, so this stays off until the fluxv2
 * route is wired in deliberately. It is kept separate from the chatbot: image
 * generation is a command/feature, not a conversational capability.
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'image',
    label: 'Image generation',
    toggle: 'image',
    capability: 'imageGeneration',
    providerRequirement: 'a verified image-generation endpoint (fluxv2 tested working)',
    howToEnable: 'Wire /api/fluxv2 into this module. It returns an image URL; fetch it and send as an image message.'
})
