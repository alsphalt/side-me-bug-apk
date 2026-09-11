'use strict'

/*
 * DARKNOTE L2 LICENSE
 * .igstalk — Instagram profile information.
 * © DARKNOTE L2 • Bigbrother
 *
 * UPSTREAM API STATUS (verified, not assumed)
 * The endpoint originally supplied — https://aemt.me/download/igstalk — no longer
 * resolves at all: the domain returns NXDOMAIN ("Could not resolve host: aemt.me")
 * while general outbound HTTPS from the same host works normally. Instagram's own
 * web_profile_info endpoint answers HTTP 401 {"require_login":true} without a
 * logged-in session.
 *
 * So this module does three things:
 *   1. keeps that endpoint as the default, exactly as specified;
 *   2. lets the owner point it at any working provider with
 *      config.json -> "instagram": { "endpoint": "https://host/path?username={username}" }
 *      (the literal {username} is replaced with an encoded username, otherwise
 *      ?username= is appended);
 *   3. parses several common response shapes, so most providers work unchanged.
 *
 * Native fetch is used — Node 18+ provides it, so no dependency is added.
 */

const path = require('path')

const DEFAULT_ENDPOINT = 'https://aemt.me/download/igstalk?username={username}'
const DEFAULT_TIMEOUT_MS = 20000
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/

function settings() {
    const configPath = path.join(__dirname, '..', 'config.json')
    let config = {}
    try {
        delete require.cache[require.resolve(configPath)]
        config = require(configPath) || {}
    } catch (error) {
        console.error('[IGSTALK] config read failed, using defaults:', error?.message || error)
    }
    const timeout = Number(config?.instagram?.timeoutMs)
    return {
        endpoint: String(config?.instagram?.endpoint || DEFAULT_ENDPOINT),
        timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_TIMEOUT_MS,
        prefix: String(config?.prefix || '.')
    }
}

/** Accept "name" or "@name". Reject URLs and anything that is not a handle. */
function cleanUsername(raw) {
    const value = String(raw || '').trim()
    if (!value) return { error: 'EMPTY' }
    if (/^https?:\/\//i.test(value)) return { error: 'URL' }
    const username = value.replace(/^@+/, '').replace(/\/+$/, '').trim()
    if (!username) return { error: 'EMPTY' }
    if (!USERNAME_RE.test(username)) return { error: 'INVALID' }
    return { username }
}

function firstDefined(...values) {
    for (const value of values) {
        if (value === undefined || value === null) continue
        if (typeof value === 'string' && !value.trim()) continue
        return value
    }
    return undefined
}

/** Find the user record in any of the shapes public providers commonly return. */
function pickUserInfo(payload) {
    if (!payload || typeof payload !== 'object') return null
    const candidates = [
        payload.result?.user_info,
        payload.result?.user,
        payload.data?.user_info,
        payload.data?.user,
        payload.user_info,
        payload.user,
        payload.result,
        payload.data,
        payload
    ]
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue
        if (
            candidate.username !== undefined ||
            candidate.full_name !== undefined ||
            candidate.follower_count !== undefined ||
            candidate.followers !== undefined ||
            candidate.edge_followed_by !== undefined
        ) return candidate
    }
    return null
}

/** Normalise any provider shape into the fields the bot displays. */
function normalizeUser(info) {
    const followers = firstDefined(info.followers, info.follower_count, info.followers_count, info.edge_followed_by?.count)
    const following = firstDefined(info.following, info.following_count, info.follows_count, info.edge_follow?.count)
    const posts = firstDefined(info.posts, info.media_count, info.posts_count, info.edge_owner_to_timeline_media?.count)
    const isPrivate = firstDefined(info.is_private, info.private)
    const verified = firstDefined(info.is_verified, info.verified)
    const picture = firstDefined(info.profile_pic_url, info.profile_pic_url_hd, info.profile_picture, info.profilePicUrl)

    return {
        name: firstDefined(info.full_name, info.fullName, info.name) ?? 'Unknown',
        username: firstDefined(info.username, info.user_name) ?? 'Unknown',
        followers: followers ?? 'Unknown',
        following: following ?? 'Unknown',
        posts: posts ?? 'Unknown',
        bio: firstDefined(info.biography, info.bio) ?? 'No bio',
        link: firstDefined(info.external_url, info.externalUrl, info.website) ?? 'None',
        isPrivate: isPrivate === undefined ? 'Unknown' : (isPrivate ? 'Yes' : 'No'),
        verified: verified === undefined ? 'Unknown' : (verified ? 'Yes' : 'No'),
        picture: typeof picture === 'string' && /^https?:\/\//i.test(picture) ? picture : ''
    }
}

function formatCaption(user) {
    return [
        `🎀 Name: ${user.name}`,
        `📝 Username: ${user.username}`,
        `🎉 Followers: ${user.followers}`,
        `🎗️ Following: ${user.following}`,
        `📢 Posts: ${user.posts}`,
        `💡 Bio: ${user.bio}`,
        `🔗 Links: ${user.link}`,
        `🔒 Private: ${user.isPrivate}`,
        `📌 Verified: ${user.verified}`
    ].join('\n')
}

function buildUrl(endpoint, username) {
    const encoded = encodeURIComponent(username)
    if (endpoint.includes('{username}')) return endpoint.replace('{username}', encoded)
    return `${endpoint}${endpoint.includes('?') ? '&' : '?'}username=${encoded}`
}

/** Fetch and normalise a profile. Never throws; always reports why it failed. */
async function fetchProfile(username, options) {
    if (typeof fetch !== 'function') {
        return { ok: false, code: 'NO_FETCH', reason: 'This Node runtime does not provide a global fetch.' }
    }
    const url = buildUrl(options.endpoint, username)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)

    let response
    try {
        response = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'user-agent': 'DARKNOTE/5.1.0' }
        })
    } catch (error) {
        const aborted = error?.name === 'AbortError'
        return {
            ok: false,
            code: aborted ? 'TIMEOUT' : 'NETWORK',
            endpoint: url,
            reason: aborted
                ? `The API did not respond within ${options.timeoutMs}ms`
                : `Request failed: ${error?.message || error}`
        }
    } finally {
        clearTimeout(timer)
    }

    if (!response.ok) {
        return { ok: false, code: 'HTTP', status: response.status, endpoint: url, reason: `The API answered HTTP ${response.status}` }
    }

    const text = await response.text()
    let payload
    try {
        payload = JSON.parse(text)
    } catch (error) {
        return { ok: false, code: 'BAD_JSON', endpoint: url, reason: `The API returned non-JSON content: ${text.slice(0, 120)}` }
    }

    const info = pickUserInfo(payload)
    if (!info) {
        return { ok: false, code: 'EMPTY', endpoint: url, reason: 'The API response contained no user information.' }
    }
    return { ok: true, endpoint: url, user: normalizeUser(info) }
}

/**
 * .igstalk <username>
 * Progress messages are wrapped so a rejected send (WhatsApp occasionally answers
 * with "not-acceptable") can never abort the lookup.
 */
async function handleIgStalk({ conn, m, reply, args }) {
    const config = settings()
    const safe = async (text) => {
        try { return await reply(text) } catch (error) {
            console.error('[IGSTALK] message could not be delivered:', error?.message || error)
            return null
        }
    }

    const raw = (Array.isArray(args) ? args.join(' ') : String(args || '')).trim()
    if (!raw) {
        await safe([
            '📸 *INSTAGRAM STALK*',
            '',
            `Usage: ${config.prefix}igstalk <username>`,
            `Example: ${config.prefix}igstalk instagram`,
            '',
            'A leading @ is fine.'
        ].join('\n'))
        return { ok: false, code: 'NO_USERNAME' }
    }

    const cleaned = cleanUsername(raw)
    if (cleaned.error === 'URL') {
        await safe('❌ Please give me an Instagram username, not a link.')
        return { ok: false, code: 'URL' }
    }
    if (cleaned.error) {
        await safe('❌ That is not a valid Instagram username.')
        return { ok: false, code: cleaned.error }
    }

    await safe(`🔎 Looking up *${cleaned.username}*...`)

    const result = await fetchProfile(cleaned.username, config)
    if (!result.ok) {
        console.error(`[IGSTALK] ${result.code}: ${result.reason} [${result.endpoint || 'no endpoint'}]`)
        await safe('❌ Instagram user information could not be retrieved.')
        return result
    }

    const caption = formatCaption(result.user)

    // Prefer the profile picture; a missing or unusable image must not break it.
    if (result.user.picture && typeof conn?.sendMessage === 'function') {
        try {
            await conn.sendMessage(m.chat, { image: { url: result.user.picture }, caption }, { quoted: m })
            return { ok: true, code: 'SENT_IMAGE', username: cleaned.username, user: result.user }
        } catch (error) {
            console.error('[IGSTALK] profile picture could not be sent, falling back to text:', error?.message || error)
        }
    }
    if (typeof conn?.sendMessage === 'function') {
        try {
            await conn.sendMessage(m.chat, { text: caption }, { quoted: m })
            return { ok: true, code: 'SENT_TEXT', username: cleaned.username, user: result.user }
        } catch (error) {
            console.error('[IGSTALK] text could not be sent:', error?.message || error)
        }
    }
    await safe(caption)
    return { ok: true, code: 'SENT_REPLY', username: cleaned.username, user: result.user }
}

module.exports = {
    handleIgStalk,
    cleanUsername,
    pickUserInfo,
    normalizeUser,
    formatCaption,
    fetchProfile,
    buildUrl,
    settings,
    DEFAULT_ENDPOINT
}
