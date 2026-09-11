'use strict'

/*
 * WEATHER AND LOCAL TIME LOOKUPS
 * ------------------------------
 * Neither of these existed in this bot. The dispatcher registry has 144
 * commands and no weather, climate, forecast, time or clock entry - so these are
 * new features, not broken ones.
 *
 * Open-Meteo is used because it needs NO API KEY. That removes an entire class
 * of failure - a credential that is missing, mis-scoped or expired - which is
 * the kind of vague "not configured" message the operator asked to stop seeing.
 * Both endpoints were verified live before this file was written:
 *   geocoding  Kiambu -> admin1 "Kiambu County", country Kenya (KE), tz Africa/Nairobi
 *   geocoding  Dubai  -> admin1 "Dubai",         country United Arab Emirates (AE)
 *   forecast   returns current conditions plus the timezone and utc_offset_seconds
 *
 * Every failure names the STAGE that failed (geocoding or forecast) and the HTTP
 * status, so "the place was not found" can be told apart from "the service is
 * down" - which a single generic sentence could never do.
 */

const axios = require('axios')

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const TIMEOUT_MS = 12000
const USER_AGENT = 'DARKNOTE/2.1 (+weather command)'

/*
 * Which continent a place is on, derived from the IANA timezone that Open-Meteo
 * returns. The first segment of an IANA zone IS its region ("Africa/Nairobi",
 * "Asia/Dubai", "Europe/London"), so this is read from the data rather than
 * guessed from the place name.
 *
 * The one genuinely ambiguous area is `America/*`, which covers two continents.
 * That is resolved with an explicit list of the South American country codes -
 * everything else under America/* is North America, which is also how Central
 * America and the Caribbean are classified. Zones with no region segment (UTC,
 * Etc/*) and the ocean areas return an empty string rather than a guess.
 */
const SOUTH_AMERICA = new Set(['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'FK', 'GF', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE'])

function continentFor(timezone, countryCode = '') {
    const area = String(timezone || '').split('/')[0].trim().toLowerCase()
    switch (area) {
        case 'africa': return 'Africa'
        case 'asia': return 'Asia'
        case 'europe': return 'Europe'
        case 'australia':
        case 'pacific': return 'Oceania'
        case 'antarctica': return 'Antarctica'
        case 'america':
            return SOUTH_AMERICA.has(String(countryCode || '').trim().toUpperCase())
                ? 'South America'
                : 'North America'
        default: return ''
    }
}

/*
 * WMO 4677 weather codes, which is what Open-Meteo reports in `weather_code`.
 * An unlisted code is reported as such instead of being mapped to something
 * plausible-looking.
 */
const WMO_CODES = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
}

function describeWeatherCode(code) {
    const key = Number(code)
    if (!Number.isFinite(key)) return 'Unknown (no weather code returned)'
    return WMO_CODES[key] || `Unknown weather code (${key})`
}

/* ------------------------------- transport ------------------------------- */

async function getJson(url, stage) {
    try {
        const response = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            validateStatus: () => true
        })
        if (response.status < 200 || response.status >= 300) {
            return { ok: false, stage, status: response.status, reason: `HTTP ${response.status}` }
        }
        return { ok: true, data: response.data }
    } catch (error) {
        const status = Number(error?.response?.status || 0)
        const timedOut = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))
        return {
            ok: false,
            stage,
            status,
            reason: timedOut ? `no reply within ${TIMEOUT_MS}ms` : (error?.message || 'network error')
        }
    }
}

/** Find candidate places by name. */
async function geocodePlace(name) {
    const query = String(name || '').trim()
    if (!query) return { ok: false, stage: 'input', status: 0, reason: 'no place was given' }

    const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`
    const result = await getJson(url, 'geocoding')
    if (!result.ok) return result

    const places = Array.isArray(result.data?.results) ? result.data.results : []
    // A 200 with an empty list means the service answered and does not know this
    // place. That is a different problem from the service being unreachable.
    if (!places.length) return { ok: false, stage: 'geocoding', status: 200, reason: `no place matched "${query}"` }

    return { ok: true, places }
}

/** Current conditions for a coordinate. */
async function currentWeather(latitude, longitude) {
    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
        timezone: 'auto'
    })

    const result = await getJson(`${FORECAST_URL}?${params.toString()}`, 'forecast')
    if (!result.ok) return result

    const current = result.data?.current
    if (!current) return { ok: false, stage: 'forecast', status: 200, reason: 'the reply contained no current conditions' }

    return {
        ok: true,
        current,
        timezone: String(result.data?.timezone || ''),
        utcOffsetSeconds: Number(result.data?.utc_offset_seconds || 0),
        elevation: Number(result.data?.elevation || 0)
    }
}

/* ------------------------------ local time ------------------------------- */

/** A valid IANA zone name, e.g. Africa/Nairobi. */
function isTimeZone(value) {
    const zone = String(value || '').trim()
    if (!zone || !zone.includes('/')) return false
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: zone }).format(new Date())
        return true
    } catch {
        return false
    }
}

/** UTC offset for a zone, as +HH:MM. Standard zones report "GMT", so that maps to +00:00. */
function offsetFor(timeZone, when = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' }).formatToParts(when)
        const name = parts.find(part => part.type === 'timeZoneName')?.value || ''
        const match = name.match(/GMT([+-]\d{2}:\d{2})/)
        return match ? match[1] : '+00:00'
    } catch {
        return ''
    }
}

/**
 * The local time in a zone.
 *
 * Read from Intl rather than from a time service: the timezone is the only thing
 * needed, so this is exact and works even when the network is unavailable.
 * Returns null for an unknown zone instead of silently falling back to the
 * server's own clock, which would be wrong for the requested place.
 */
function localTimeIn(timeZone, when = new Date()) {
    const zone = String(timeZone || '').trim()
    if (!zone) return null
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: zone,
            hour12: false,
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).formatToParts(when)

        const get = type => parts.find(part => part.type === type)?.value || ''
        return {
            time: `${get('hour')}:${get('minute')}:${get('second')}`,
            date: `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}`,
            timeZone: zone,
            offset: offsetFor(zone, when)
        }
    } catch {
        return null
    }
}

/* ------------------------------- formatting ------------------------------ */

const label = (value, fallback = 'not reported') => {
    const text = String(value ?? '').trim()
    return text || fallback
}

/** The place breakdown the operator asked for: village/market, county, country, continent. */
function describePlace(place) {
    return {
        name: label(place?.name, 'unknown place'),
        area: label(place?.admin3 || place?.admin4, ''),       // most local unit, when the service has one
        market: label(place?.admin2, ''),                      // district / sub-county / township
        county: label(place?.admin1, ''),                      // county / region / state
        country: label(place?.country, ''),
        countryCode: String(place?.country_code || '').toUpperCase(),
        continent: continentFor(place?.timezone, place?.country_code) || 'unknown',
        timeZone: label(place?.timezone, ''),
        population: Number(place?.population || 0),
        latitude: Number(place?.latitude || 0),
        longitude: Number(place?.longitude || 0)
    }
}

function placeLines(place) {
    const lines = [`• Village / area   : ${place.name}`]
    if (place.area) lines.push(`• Local unit       : ${place.area}`)
    if (place.market) lines.push(`• District / town  : ${place.market}`)
    lines.push(`• County / region  : ${place.county || 'not reported'}`)
    lines.push(`• Country          : ${place.country || 'not reported'}${place.countryCode ? ` (${place.countryCode})` : ''}`)
    lines.push(`• Continent        : ${place.continent}`)
    return lines
}

function renderWeather(place, weather) {
    const current = weather.current
    const lines = [
        `📍 *${place.name.toUpperCase()}*`,
        '',
        '*Location*',
        ...placeLines(place),
        '',
        '*Conditions now*',
        `• Weather    : ${describeWeatherCode(current.weather_code)}`,
        `• Temperature: ${current.temperature_2m}°C (feels like ${current.apparent_temperature}°C)`,
        `• Humidity   : ${current.relative_humidity_2m}%`,
        `• Wind       : ${current.wind_speed_10m} km/h`,
        `• Rain       : ${current.precipitation} mm`,
        `• Elevation  : ${weather.elevation} m`
    ]

    const local = localTimeIn(weather.timezone || place.timeZone)
    if (local) lines.push('', `🕒 Local time: ${local.time.slice(0, 5)} (${local.timeZone}, UTC${local.offset})`)
    lines.push('', `_Source: Open-Meteo · observed ${current.time}_`)
    return lines.join('\n')
}

function renderTime(place, timeZone) {
    const local = localTimeIn(timeZone)
    if (!local) return null

    const lines = [
        `🕒 *${place ? place.name.toUpperCase() : timeZone}*`,
        '',
        `• Local time : ${local.time}`,
        `• Date       : ${local.date}`,
        `• Timezone   : ${local.timeZone} (UTC${local.offset})`
    ]
    if (place) {
        lines.push(`• County     : ${place.county || 'not reported'}`)
        lines.push(`• Country    : ${place.country || 'not reported'}${place.countryCode ? ` (${place.countryCode})` : ''}`)
        lines.push(`• Continent  : ${place.continent}`)
    }
    lines.push('', '_Time read locally from the IANA timezone, not from a server clock._')
    return lines.join('\n')
}

/**
 * A SPECIFIC failure line.
 *
 * Names the stage that failed and the HTTP status, so the operator can act on
 * it: an unknown place needs a different spelling, a 5xx needs a retry, a
 * timeout needs a network check.
 */
function describeFailure(result, subject) {
    const stage = result?.stage || 'lookup'
    const status = Number(result?.status || 0)
    const reason = String(result?.reason || 'no reason reported')
    const where = subject ? ` "${subject}"` : ''
    if (stage === 'input') return `❌ No location was given.\n\nUsage: .weather <place>  ·  .time <place>`
    if (stage === 'geocoding') {
        return status === 200
            ? `❌ Geocoding found no place matching${where}.\n\nReason: ${reason}. Try a nearby larger town, or add the country.`
            : `❌ Geocoding failed for${where}.\n\nStage: geocoding · ${status ? `HTTP ${status}` : 'no HTTP status'} · ${reason}`
    }
    if (stage === 'forecast') {
        return `❌ The weather service failed for${where}.\n\nStage: forecast · ${status ? `HTTP ${status}` : 'no HTTP status'} · ${reason}`
    }
    return `❌ ${stage} failed for${where}: ${reason}`
}

/* -------------------------------- commands ------------------------------- */

/** `.weather <place>` */
async function weatherReport(query) {
    const found = await geocodePlace(query)
    if (!found.ok) return { ok: false, message: describeFailure(found, query), failure: found }

    const place = describePlace(found.places[0])
    if (!place.timeZone) {
        return {
            ok: false,
            message: `❌ Geocoding returned ${place.name} without a timezone, so the local time cannot be resolved.`,
            failure: { stage: 'geocoding', status: 200, reason: 'no timezone in the response' }
        }
    }

    const weather = await currentWeather(place.latitude, place.longitude)
    if (!weather.ok) return { ok: false, message: describeFailure(weather, place.name), failure: weather }

    return { ok: true, message: renderWeather(place, weather), place, weather }
}

/**
 * `.time <place or IANA zone>`
 *
 * Accepting a bare zone ("Africa/Nairobi") makes this work with no network call
 * at all, which is useful when the weather service is the thing that is down.
 */
async function timeReport(query) {
    const raw = String(query || '').trim()
    if (!raw) return { ok: false, message: describeFailure({ stage: 'input' }, raw) }

    if (isTimeZone(raw)) {
        const message = renderTime(null, raw)
        if (message) return { ok: true, message, place: null, timeZone: raw }
    }

    const found = await geocodePlace(raw)
    if (!found.ok) return { ok: false, message: describeFailure(found, raw), failure: found }

    const place = describePlace(found.places[0])
    const message = renderTime(place, place.timeZone)
    if (!message) {
        return {
            ok: false,
            message: `❌ ${place.name} returned an unusable timezone (${place.timeZone || 'empty'}).`,
            failure: { stage: 'timezone', status: 0, reason: 'unusable timezone' }
        }
    }
    return { ok: true, message, place, timeZone: place.timeZone }
}

module.exports = {
    geocodePlace,
    currentWeather,
    continentFor,
    describeWeatherCode,
    localTimeIn,
    offsetFor,
    isTimeZone,
    describePlace,
    renderWeather,
    renderTime,
    describeFailure,
    weatherReport,
    timeReport
}
