'use strict'

/*
 * DARKNOTE AI — sticker creation module.
 *
 * VERIFIED STATUS: NOT WIRED IN. No provider generates stickers, but this is the
 * one future module that does NOT need a new AI provider: the project already
 * ships `sharp` (verified working, libvips 8.17.3) and there is an existing
 * sticker pipeline in lib/StickerMaker.js and lib/sticker-commands.js.
 *
 * The remaining work is LOCAL image processing plus, optionally, an AI step to
 * auto-caption or restyle. Kept separate from the chatbot on purpose.
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'sticker',
    label: 'Sticker creation',
    toggle: 'sticker',
    capability: 'stickerGeneration',
    providerRequirement: 'no AI provider needed - local sharp conversion; add an AI step only for auto-captioning',
    howToEnable: 'Reuse lib/StickerMaker.js with the existing sharp dependency. This module is a wrapper, not a new AI capability.'
})
