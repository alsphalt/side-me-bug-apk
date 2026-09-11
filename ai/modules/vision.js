'use strict'

/*
 * DARKNOTE AI — vision module (image understanding).
 *
 * VERIFIED STATUS: NOT AVAILABLE. Testing showed the model cannot see images:
 * asked about an image at an opaque URL it replied "I can't view images
 * directly" and "I can't access external links". An earlier apparent success was
 * hallucination from the filename, and it did not reproduce.
 *
 * No provider on this platform has been verified for imageUnderstanding, so this
 * module refuses. It will switch itself on automatically the moment a provider
 * declares imageUnderstanding: true with a verification date.
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'vision',
    label: 'Image understanding',
    toggle: 'vision',
    capability: 'imageUnderstanding',
    providerRequirement: 'a provider that accepts an image and has been verified doing so',
    howToEnable: 'Register a verified vision provider in ai/providers.js with capability imageUnderstanding: true.'
})
