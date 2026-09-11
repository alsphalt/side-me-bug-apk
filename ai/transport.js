'use strict'

/*
 * DARKNOTE AI — HTTP transport.
 *
 * One place that knows how to talk HTTP, so every provider adapter stays a
 * pure description of a request/response shape. Nothing provider-specific and
 * no secret ever reaches this layer, and it never logs a URL (a URL contains
 * the API key on this platform).
 */

const https = require('https')
const http = require('http')

const USER_AGENT = 'DARKNOTE-AI/2.0'

/**
 * Perform one request. ALWAYS settles: a timeout, a socket error and a broken
 * response stream all resolve with a result object rather than throwing, so a
 * caller can never be left hanging with a typing indicator on screen.
 */
function request({ url, method = 'GET', headers = {}, body = null, timeoutMs = 60000 }) {
    return new Promise(resolve => {
        const startedAt = Date.now()
        let settled = false
        const finish = value => {
            if (settled) return
            settled = true
            resolve({ ...value, ms: Date.now() - startedAt })
        }

        let target
        try {
            target = new URL(url)
        } catch {
            return finish({ status: 0, error: 'malformed request URL' })
        }

        const lib = target.protocol === 'http:' ? http : https
        const payload = body === null || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body))
        const finalHeaders = {
            accept: 'application/json',
            'user-agent': USER_AGENT,
            ...headers
        }
        if (payload !== null) finalHeaders['content-length'] = Buffer.byteLength(payload)

        let req
        try {
            req = lib.request({
                method,
                hostname: target.hostname,
                port: target.port || undefined,
                path: target.pathname + target.search,
                headers: finalHeaders
            }, res => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8')
                    let json = null
                    try { json = JSON.parse(raw) } catch { json = null }
                    finish({ status: Number(res.statusCode) || 0, json, body: raw.slice(0, 300) })
                })
                res.on('error', error => finish({ status: 0, error: error?.message || 'response stream error' }))
            })
        } catch (error) {
            return finish({ status: 0, error: error?.message || 'request could not be created' })
        }

        // A hung socket must never leave the bot typing forever.
        req.setTimeout(timeoutMs, () => {
            try { req.destroy(new Error(`timed out after ${timeoutMs}ms`)) } catch { }
        })
        req.on('error', error => finish({ status: 0, error: error?.message || 'network error' }))
        if (payload !== null) req.write(payload)
        req.end()
    })
}

module.exports = { request }
