'use strict'

/*
 * DARKNOTE AI — image inspiration search module.
 *
 * VERIFIED STATUS: NOT WIRED IN. Requires a permitted image source API with
 * attribution. Intended sources are officially supported APIs only:
 *   Unsplash, Pexels, Pixabay, Wikimedia Commons
 *
 * Deliberately NOT implemented as scraping. If Pinterest is ever wanted, it must
 * be through an official permitted access method that respects its terms.
 * Attribution/link-back is a requirement of every source listed above.
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'imagesearch',
    label: 'Image search',
    toggle: 'imagesearch',
    capability: 'imageSearch',
    providerRequirement: 'a permitted image API with attribution (Unsplash / Pexels / Pixabay / Wikimedia)',
    howToEnable: 'Add an API key for a chosen source and wire it here. Always return the attribution link with the results.'
})
