'use strict'

/*
 * DARKNOTE AI — smart assistant module (tool/function calling).
 *
 * VERIFIED STATUS: NOT AVAILABLE. NOT ONE of the five providers exposes a
 * tools / functions parameter. Testing confirmed there is no tool channel, and
 * the 302-character gateway cap leaves no room for a tool schema anyway.
 *
 * Letting a chat model "perform actions" without a real tool channel would mean
 * parsing free text into commands, which is unsafe and unpredictable. It will
 * not be done. When a provider with verified tool calling is added, this module
 * becomes the single place that maps tool calls to approved actions.
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'assistant',
    label: 'Smart assistant',
    toggle: 'assistant',
    capability: 'toolCalling',
    providerRequirement: 'a provider with verified tool/function calling',
    howToEnable: 'Register a provider with capability toolCalling: true and a verification date, then map its tool calls to an explicit allowlist of actions.'
})
