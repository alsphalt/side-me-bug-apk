'use strict'

/*
 * Weather and local time.
 *
 * The geocoding fixtures below are RECORDED live responses from Open-Meteo, not
 * invented ones - the exact fields the service really returns for these places.
 * Everything here is offline: the network paths are exercised separately against
 * the live service, never in the test suite.
 */

const weather = require('../lib/weather')

/** Recorded 2026-09-12 from geocoding-api.open-meteo.com. */
const KIAMBU = {
    name: 'Kiambu',
    admin1: 'Kiambu County',
    country: 'Kenya',
    country_code: 'KE',
    timezone: 'Africa/Nairobi',
    latitude: -1.17139,
    longitude: 36.83556,
    population: 147870,
    feature_code: 'PPLA'
}
const DUBAI = {
    name: 'Dubai',
    admin1: 'Dubai',
    country: 'United Arab Emirates',
    country_code: 'AE',
    timezone: 'Asia/Dubai',
    latitude: 25.07725,
    longitude: 55.30927,
    population: 3790000,
    feature_code: 'PPLA'
}

module.exports = function weatherSuite({ section, ok, eq }) {
    section('lib/weather -- continent is read from the IANA zone, not guessed')

    eq('Africa/Nairobi is Africa', weather.continentFor('Africa/Nairobi', 'KE'), 'Africa')
    eq('Asia/Dubai is Asia', weather.continentFor('Asia/Dubai', 'AE'), 'Asia')
    eq('Europe/London is Europe', weather.continentFor('Europe/London', 'GB'), 'Europe')
    eq('Australia/Sydney is Oceania', weather.continentFor('Australia/Sydney', 'AU'), 'Oceania')
    eq('Pacific/Auckland is Oceania', weather.continentFor('Pacific/Auckland', 'NZ'), 'Oceania')
    eq('Antarctica/Casey is Antarctica', weather.continentFor('Antarctica/Casey', 'AQ'), 'Antarctica')

    section('lib/weather -- the one ambiguous area is America')

    eq('America/New_York is North America', weather.continentFor('America/New_York', 'US'), 'North America')
    eq('America/Mexico_City is North America (Central America is part of it)',
        weather.continentFor('America/Mexico_City', 'MX'), 'North America')
    eq('America/Sao_Paulo with BR is South America', weather.continentFor('America/Sao_Paulo', 'BR'), 'South America')
    eq('America/Bogota with CO is South America', weather.continentFor('America/Bogota', 'CO'), 'South America')
    eq('America/Lima with PE is South America', weather.continentFor('America/Lima', 'PE'), 'South America')

    section('lib/weather -- no region is reported as unknown rather than guessed')

    eq('UTC has no region', weather.continentFor('UTC', 'US'), '')
    eq('Etc/GMT has no region', weather.continentFor('Etc/GMT', 'US'), '')
    eq('an empty zone has no region', weather.continentFor('', 'US'), '')

    section('lib/weather -- WMO weather codes')

    eq('0 is clear', weather.describeWeatherCode(0), 'Clear sky')
    eq('3 is overcast', weather.describeWeatherCode(3), 'Overcast')
    eq('65 is heavy rain', weather.describeWeatherCode(65), 'Heavy rain')
    eq('95 is a thunderstorm', weather.describeWeatherCode(95), 'Thunderstorm')
    eq('99 is a thunderstorm with heavy hail', weather.describeWeatherCode(99), 'Thunderstorm with heavy hail')
    eq('an unlisted code is reported as unlisted', weather.describeWeatherCode(999), 'Unknown weather code (999)')
    eq('a missing code is reported as missing', weather.describeWeatherCode(undefined), 'Unknown (no weather code returned)')
    ok('a code is never mapped to something plausible-looking',
        /Unknown/.test(weather.describeWeatherCode(1234)))

    section('lib/weather -- timezones and offsets')

    ok('a real zone is accepted', weather.isTimeZone('Africa/Nairobi') === true)
    ok('a bare place name is not a zone', weather.isTimeZone('Kiambu') === false)
    ok('an invalid zone is rejected', weather.isTimeZone('Not/AZone') === false)
    ok('an empty value is rejected', weather.isTimeZone('') === false)

    eq('Nairobi is UTC+03:00', weather.offsetFor('Africa/Nairobi'), '+03:00')
    eq('Dubai is UTC+04:00', weather.offsetFor('Asia/Dubai'), '+04:00')
    eq('UTC is +00:00', weather.offsetFor('UTC'), '+00:00')
    eq('an invalid zone yields nothing', weather.offsetFor('Not/AZone'), '')

    section('lib/weather -- local time comes from the zone')

    const nairobi = weather.localTimeIn('Africa/Nairobi')
    ok('it returns a time', Boolean(nairobi) && /^\d{2}:\d{2}:\d{2}$/.test(nairobi.time), JSON.stringify(nairobi))
    eq('it reports the zone it used', nairobi.timeZone, 'Africa/Nairobi')
    eq('it reports the offset', nairobi.offset, '+03:00')

    /*
     * Cross-check: the same instant formatted in two zones 1 hour apart must
     * differ by exactly one hour. This proves the value tracks the ZONE and is
     * not just the server's own clock wearing a label.
     */
    const instant = new Date('2026-09-12T00:00:00Z')
    const asNairobi = weather.localTimeIn('Africa/Nairobi', instant)
    const asDubai = weather.localTimeIn('Asia/Dubai', instant)
    eq('Nairobi shows 03:00 for that instant', asNairobi.time, '03:00:00')
    eq('Dubai shows 04:00 for the same instant', asDubai.time, '04:00:00')

    eq('an unknown zone yields null, not the server clock', weather.localTimeIn('Not/AZone'), null)
    eq('an empty zone yields null', weather.localTimeIn(''), null)

    section('lib/weather -- the place breakdown the operator asked for')

    const kiambu = weather.describePlace(KIAMBU)
    eq('village / area', kiambu.name, 'Kiambu')
    eq('county', kiambu.county, 'Kiambu County')
    eq('country', kiambu.country, 'Kenya')
    eq('country code', kiambu.countryCode, 'KE')
    eq('continent', kiambu.continent, 'Africa')
    eq('timezone', kiambu.timeZone, 'Africa/Nairobi')

    const dubai = weather.describePlace(DUBAI)
    eq('Dubai county', dubai.county, 'Dubai')
    eq('Dubai country', dubai.country, 'United Arab Emirates')
    eq('Dubai continent', dubai.continent, 'Asia')

    section('lib/weather -- rendering')

    const rendered = weather.renderWeather(kiambu, {
        current: { weather_code: 3, temperature_2m: 15.6, apparent_temperature: 17.1, relative_humidity_2m: 97, wind_speed_10m: 1.5, precipitation: 0, time: '2026-09-12T00:45' },
        timezone: 'Africa/Nairobi',
        elevation: 1682
    })
    for (const expected of ['KIAMBU', 'Kiambu County', 'Kenya (KE)', 'Africa', 'Overcast', '15.6', '17.1', '97%', '1.5', '1682']) {
        ok(`the weather report includes ${expected}`, rendered.includes(expected), rendered.slice(0, 120))
    }
    ok('it names the source', /Open-Meteo/.test(rendered))

    const timeText = weather.renderTime(kiambu, 'Africa/Nairobi')
    ok('the time report includes the local time', /Local time/.test(timeText))
    ok('the time report includes the zone', timeText.includes('Africa/Nairobi'))
    ok('the time report includes the continent', timeText.includes('Africa'))
    eq('an unusable zone yields no report', weather.renderTime(null, 'Not/AZone'), null)

    section('lib/weather -- failures name the stage and status, never a generic line')

    const unknownPlace = weather.describeFailure({ stage: 'geocoding', status: 200, reason: 'no place matched "Nowhereville"' }, 'Nowhereville')
    ok('an unknown place is called out as unknown', /no place matching/.test(unknownPlace), unknownPlace)
    ok('an unknown place offers a next step', /Try a nearby larger town/.test(unknownPlace))

    const geocodeDown = weather.describeFailure({ stage: 'geocoding', status: 503, reason: 'HTTP 503' }, 'Kiambu')
    ok('a geocoding outage names the stage', /geocoding/i.test(geocodeDown), geocodeDown)
    ok('a geocoding outage names the status', /HTTP 503/.test(geocodeDown), geocodeDown)

    const forecastDown = weather.describeFailure({ stage: 'forecast', status: 500, reason: 'HTTP 500' }, 'Kiambu')
    ok('a forecast outage names the stage', /forecast/i.test(forecastDown), forecastDown)
    ok('a forecast outage names the status', /HTTP 500/.test(forecastDown), forecastDown)

    const noInput = weather.describeFailure({ stage: 'input', status: 0, reason: 'no place was given' }, '')
    ok('no input shows the usage', /Usage:/.test(noInput), noInput)

    for (const message of [unknownPlace, geocodeDown, forecastDown, noInput]) {
        ok('the message never falls back to a vague "not configured" line',
            !/not configured/i.test(message), message)
    }
}
