'use strict'

/*
 * DARKNOTE AI — language and style detection.
 *
 * The provider has no language parameter, so the language has to be inferred
 * locally and stated in the prompt. Everything here is a cheap heuristic: no
 * network calls, no dictionaries to download, and it never throws.
 *
 * Verified behaviour of the underlying model: given a language directive it
 * answers naturally in English, Kiswahili and Sheng. So getting this right is
 * what makes the bot follow the user instead of forcing one language.
 */

// Distinctly Kiswahili words. Chosen to avoid English collisions.
const SWAHILI = [
    'habari', 'nzuri', 'asante', 'karibu', 'vipi', 'wewe', 'mimi', 'yako', 'langu', 'wangu',
    'nataka', 'ninataka', 'unataka', 'una', 'nina', 'kweli', 'sawa', 'pole', 'samahani',
    'kwaheri', 'shikamoo', 'mambo', 'sema', 'jibu', 'unaitwa', 'jina', 'mbona', 'kwani',
    'bado', 'tena', 'sana', 'kidogo', 'vizuri', 'kesho', 'jana', 'leo', 'chakula', 'maji',
    'kazi', 'pesa', 'rafiki', 'ndio', 'hapana', 'nini', 'gani', 'kitu', 'watu', 'mtu',
    'mzuri', 'mbaya', 'nini', 'nini', 'tafadhali', 'hongera', 'pongezi', 'sijui',
    'najua', 'nimefurahi', 'hujambo', 'salama', 'nyumbani', 'shule', 'hospitali'
]

// Sheng: Kenyan urban slang. Overlaps Kiswahili, so these are checked first.
const SHENG = [
    'niaje', 'sasa', 'freshi', 'poa', 'mzee', 'buda', 'dem', 'dame', 'manzi', 'mbogi',
    'chapo', 'ngoma', 'raha', 'choma', 'fiti', 'safi', 'twende', 'wacha', 'noma',
    'mzing', 'kubafu', 'kubaff', 'uko', 'aje', 'msee', 'mzigo', 'sherehe', 'dunda',
    'hepa', 'nyamba', 'keja', 'warembo', 'chapati', 'moto', 'kali', 'buda', 'mding',
    'si', 'ndio', 'gani', 'sasa', 'vipi', 'sema', 'msee', 'wasee', 'bro', 'brathe',
    'kibuda', 'tei', 'doh', 'mula', 'chapaa', 'keroro', 'ngwai', 'mboch', 'sonko'
]

const ENGLISH = [
    'the', 'is', 'are', 'was', 'were', 'you', 'your', 'what', 'how', 'why', 'when', 'where',
    'who', 'i', 'my', 'me', 'we', 'our', 'do', 'does', 'did', 'can', 'could', 'should',
    'would', 'will', 'please', 'thanks', 'thank', 'hello', 'hi', 'hey', 'good', 'bad',
    'and', 'but', 'not', 'have', 'has', 'this', 'that', 'there', 'with', 'about'
]

const tokens = text => String(text || '')
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

function countHits(words, list) {
    const set = new Set(list)
    let hits = 0
    for (const word of words) if (set.has(word)) hits++
    return hits
}

/**
 * Detect the dominant language and style of a message.
 * Returns { code, label, instruction, confidence }.
 * `instruction` is a SHORT directive, because the provider prompt budget is
 * only 302 characters and every character counts.
 */
function detect(text) {
    const words = tokens(text)
    if (!words.length) return { code: 'en', label: 'English', instruction: 'Reply in English.', confidence: 0 }

    const sheng = countHits(words, SHENG)
    const swahili = countHits(words, SWAHILI)
    const english = countHits(words, ENGLISH)

    // Sheng wins when its own slang markers appear: it is the more specific signal.
    if (sheng >= 2 && sheng >= swahili) {
        return { code: 'sheng', label: 'Sheng', instruction: 'Reply in Sheng, Kenyan slang. Short and natural.', confidence: Math.min(1, sheng / 4) }
    }
    if (swahili > english && swahili >= 2) {
        return { code: 'sw', label: 'Kiswahili', instruction: 'Reply in Kiswahili, natural and short.', confidence: Math.min(1, swahili / 4) }
    }
    if (english >= 2 && (swahili >= 1 || sheng >= 1)) {
        return { code: 'mixed', label: 'Mixed English + Kiswahili/Sheng', instruction: 'Reply in the same mixed English/Kiswahili style the user used, and match their slang.', confidence: 0.6 }
    }
    if (english >= 1) {
        return { code: 'en', label: 'English', instruction: 'Reply in English, casual and short.', confidence: Math.min(1, english / 4) }
    }

    // No signal either way: let the model mirror whatever it was sent.
    return { code: 'auto', label: 'Unknown — mirror the user', instruction: 'Reply in the same language and style as the message.', confidence: 0.2 }
}

/** Detect whether the message reads as short/casual rather than a real request. */
function isCasual(text) {
    const value = String(text || '').trim()
    if (!value) return true
    const words = tokens(value)
    if (words.length <= 4 && value.length <= 32) return true
    return /^(hi|hey|hello|yo|sup|niaje|sasa|vipi|mambo|poa|freshi|sawa|ok|okay|lol|😂|🤣|❤️|👍)\b/i.test(value)
}

/** Detect an explicit emoji usage level, so the model can mirror it. */
function emojiLevel(text) {
    const value = String(text || '')
    const matches = value.match(/\p{Extended_Pictographic}/gu)
    const count = matches ? matches.length : 0
    if (count >= 3) return { level: 'heavy', note: 'The user uses emojis a lot. Matching emojis are welcome.' }
    if (count >= 1) return { level: 'some', note: 'A single fitting emoji is fine.' }
    return { level: 'none', note: 'Do not add emojis unless it really fits.' }
}

module.exports = { detect, isCasual, emojiLevel, tokens }
