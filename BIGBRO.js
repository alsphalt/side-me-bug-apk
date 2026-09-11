/*
 * DARKNOTE L2 LICENSE
 * Free to use and modify.
 * Please keep this credit notice in redistributed versions.
 * © DARKNOTE L2 • Bigbrother
 */
const baileys = require('@whiskeysockets/baileys')

const {
    default: makeWASocket,
    proto,
    generateWAMessageFromContent,
    generateWAMessage,
    generateWAMessageContent,
    prepareWAMessageMedia,
    downloadContentFromMessage,
    downloadAndSaveMediaMessage,
    jidNormalizedUser,
    getContentType,
    fetchLatestBaileysVersion,
    useSingleFileAuthState,
    makeInMemoryStore,
    DisconnectReason,
    Browsers
} = baileys

const os = require('os');
const util = require('util');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp')
const { exec } = require('child_process');
const { fileTypeFromBuffer } = require('file-type');
const { writeExif } = require('./lib/StickerMaker.js');
const ytSearch = require('yt-search');
const { ytdlAutoBuffer, ytdlAutoVideoFile, getYouTubeMetadata, extractYouTubeId } = require('./lib/ytdl.js');
const { resolveForDispatch, configureAlias, getRegisteredCommands } = require('./lib/command-system.js');
const { isNativeStatusSave, saveStatus, saveStatusSilent } = require('./lib/status-media.js');
const aiChat = require('./lib/ai-chat.js');
// DARKNOTE AI service. The automatic conversational chatbot lives entirely in
// ./ai and is reached only through this facade. aiChat above stays as-is for the
// legacy prefixed .ai command; this is a separate, independent module.
const aiService = require('./ai/index.js');
const cards = require('./lib/cards.js');
// Smart image/sticker re-edit pipeline (`.edit`).
const imageEdit = require('./lib/image-edit.js');
// Display layer: resolves WhatsApp names and keeps raw JIDs out of visible text.
const display = require('./lib/display.js');
// Destructive confirmed group operation, and the honest `.state` reader.
const evilPain = require('./lib/evil-pain.js');
const userInfo = require('./lib/user-info.js');
// Generated menu (names only, one entry per command) and the runtime monitor.
const menu = require('./lib/menu.js');
// Named runtimeMonitor on purpose: the `.menu` case already has a local
// `runtime` holding process.uptime(), and shadowing the monitor there would be
// an easy way to introduce a very confusing bug.
const runtimeMonitor = require('./lib/runtime.js');
// Protected modules: load the obfuscated build when it is present and fall back
// to the readable source. Generate the protected builds with `npm run protect`.
const requireProtected = (name) => {
    try {
        return require(`./lib/${name}.protected.js`);
    } catch (error) {
        const missing = error?.code === 'MODULE_NOT_FOUND' && String(error.message || '').includes(`${name}.protected`);
        if (!missing) {
            console.error(`[PROTECT] ${name}.protected.js exists but failed to load — using the readable source:`, error?.stack || error);
        }
        return require(`./lib/${name}.js`);
    }
};
const blockStatus = requireProtected('block-status');

// Some Baileys builds (including the installed levvleys fork) do not expose the
// generated protobuf helper constructors, so
// `proto.Message.InteractiveMessage.Header.create({...})` threw
// "Cannot read properties of undefined (reading 'create')".
// imNode() prefers the helper when it exists and falls back to a plain object
// literal, which relayMessage accepts, keeping every interactive message alive.
const imNode = (name, shape) => {
    const holder = cards.interactiveMessage();
    return cards.safeCreate(name ? holder?.[name] : holder, shape);
};
const ownerSystem = require('./lib/owner-system.js');
const antidelete = require('./lib/antidelete.js');
// ONE security engine for the whole anti-feature suite.
const security = require('./lib/security.js');
const groupFeatures = require('./lib/group-features.js');

// Temporary song selections. They expire automatically so memory stays bounded.
const songSelections = new Map();
const SONG_TTL = 10 * 60 * 1000;

// Temporary YouTube video selections and download locks.
const ytVideoSelections = new Map();
const ytVideoLocks = new Set();
const YTVIDEO_TTL = 10 * 60 * 1000;
const YTVIDEO_MAX_SECONDS = 20 * 60;
const YTVIDEO_MAX_BYTES = 200 * 1024 * 1024;

function songKey(m, token) { return `${m.chat}:${getNumber(m.sender)}:${token}`; }
function cleanupSongSelections() {
    const now = Date.now();
    for (const [key, value] of songSelections) if (now - value.createdAt > SONG_TTL) songSelections.delete(key);
}

function cleanupYtVideoSelections() {
    const now = Date.now();
    for (const [key, value] of ytVideoSelections) {
        if (now - value.createdAt > YTVIDEO_TTL) ytVideoSelections.delete(key);
    }
}

function ytVideoKey(m, requestId) {
    return `${m.chat}:${getNumber(m.sender)}:${requestId}`;
}

function isYouTubeUrl(value) {
    return Boolean(extractYouTubeId(String(value || '').trim()));
}

function safeVideoFilename(title = 'DARKNOTE YouTube Video') {
    return String(title).replace(/[\\/:*?"<>|]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 90) || 'DARKNOTE YouTube Video';
}

function formatVideoDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function resolveYtVideoMetadata(url, fallback = {}) {
    const direct = await getYouTubeMetadata(url);
    if (direct?.status) return direct;
    try {
        const search = await ytSearch(url);
        const id = extractYouTubeId(url);
        const found = (search.videos || []).find(v => v.videoId === id);
        if (found) return {
            status: true,
            videoId: found.videoId,
            url: found.url || url,
            title: found.title || fallback.title || 'YouTube video',
            author: found.author?.name || fallback.author || 'YouTube',
            duration: Number(found.seconds || 0),
            thumbnail: found.thumbnail || fallback.thumbnail,
            views: Number(found.views || 0)
        };
    } catch (error) {
        console.error('[YTVIDEO] Metadata fallback failed:', error?.message || error);
    }
    if (Number.isFinite(Number(fallback.duration)) && Number(fallback.duration) > 0) {
        return { ...fallback, status: true, duration: Number(fallback.duration) };
    }
    return { status: false, error: direct?.error || 'Unable to read YouTube video metadata' };
}

async function sendChannelButton(conn, m) {
    const channelLink = String(config.channelLink || '').trim();
    if (!channelLink || channelLink.includes('REPLACE_WITH_YOUR_CHANNEL')) return;
    if (!/^https:\/\/whatsapp\.com\/channel\/[A-Za-z0-9_-]+(?:[/?].*)?$/i.test(channelLink)) return;

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', {
                        text: '📢 *DARKNOTE L2*\n\nFollow our official channel for updates and new features.'
                    }),
                    footer: imNode('Footer', {
                        text: 'DARKNOTE L2 • Bigbrother'
                    }),
                    nativeFlowMessage: imNode('NativeFlowMessage', {
                        buttons: [{
                            name: 'cta_url',
                            buttonParamsJson: JSON.stringify({
                                display_text: '📢 VIEW CHANNEL',
                                url: channelLink,
                                merchant_url: channelLink
                            })
                        }],
                        messageParamsJson: ''
                    })
                })
            }
        }
    };

    const msg = generateWAMessageFromContent(m.chat, content, {
        userJid: conn.user?.id,
        quoted: m
    });
    await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id });
}

async function sendSongCarousel(conn, m, results) {
    cleanupSongSelections();
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    songSelections.set(songKey(m, token), { createdAt: Date.now(), results });

    const cards = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        let media;
        try {
            media = await prepareWAMessageMedia({ image: { url: r.thumbnail } }, { upload: conn.waUploadToServer });
        } catch {
            media = null;
        }
        if (!media?.imageMessage) continue;
        cards.push({
            header: imNode('Header', { title: `🎵 ${i + 1}. ${r.title.slice(0, 55)}`, hasMediaAttachment: true, ...media }),
            body: imNode('Body', { text: `${r.author || 'YouTube'}\n⏱ ${r.timestamp || 'Unknown'}\n👁 ${Number(r.views || 0).toLocaleString()} views` }),
            footer: imNode('Footer', { text: 'DARKNOTE L2 • YouTube Music' }),
            nativeFlowMessage: imNode('NativeFlowMessage', {
                buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🎧 AUDIO', id: `song_audio ${token} ${i}` }) }],
                messageParamsJson: ''
            })
        });
    }
    if (!cards.length) throw new Error('Unable to prepare YouTube thumbnails.');

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', { text: `🎶 *SONG SEARCH*\n\nFound ${cards.length} results for your search.\nSwipe horizontally and tap *🎧 AUDIO* on the song you want.` }),
                    footer: imNode('Footer', { text: 'Swipe → choose → AUDIO' }),
                    carouselMessage: imNode('CarouselMessage', { cards })
                })
            }
        }
    };
    const msg = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, quoted: m });
    await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id });
}


async function sendYtVideoCarousel(conn, m, results, query) {
    cleanupYtVideoSelections();
    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const key = ytVideoKey(m, requestId);
    ytVideoSelections.set(key, { createdAt: Date.now(), userJid: m.sender, chat: m.chat, requestId, query, results });

    const cards = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        let media = null;
        try {
            media = await prepareWAMessageMedia({ image: { url: r.thumbnail } }, { upload: conn.waUploadToServer });
        } catch (error) {
            console.error(`[YTVIDEO] Thumbnail ${i + 1} failed:`, error?.message || error);
        }
        if (!media?.imageMessage) continue;
        cards.push({
            header: imNode('Header', {
                title: `🎬 ${i + 1}. ${String(r.title || 'YouTube video').slice(0, 55)}`,
                hasMediaAttachment: true,
                ...media
            }),
            body: imNode('Body', {
                text: `${r.author || 'YouTube'}\n⏱ ${r.timestamp || formatVideoDuration(r.duration)}\n👁 ${Number(r.views || 0).toLocaleString()} views\n\nSelect this video to download it.`
            }),
            footer: imNode('Footer', { text: 'DARKNOTE L2 • YouTube Video' }),
            nativeFlowMessage: imNode('NativeFlowMessage', {
                buttons: [{
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: '🎬 SELECT VIDEO',
                        id: `ytvideo_select_${requestId}_${i}`
                    })
                }],
                messageParamsJson: ''
            })
        });
    }

    if (!cards.length) {
        ytVideoSelections.delete(key);
        throw new Error('Unable to prepare YouTube thumbnails.');
    }

    const content = {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: imNode(null, {
                    body: imNode('Body', {
                        text: `🎬 *YOUTUBE VIDEO SEARCH*\n\nFound ${cards.length} video${cards.length === 1 ? '' : 's'} for: *${String(query).slice(0, 80)}*\nSwipe horizontally and tap *🎬 SELECT VIDEO*.`
                    }),
                    footer: imNode('Footer', { text: 'Swipe → choose → download' }),
                    carouselMessage: imNode('CarouselMessage', { cards })
                })
            }
        }
    };
    const msg = generateWAMessageFromContent(m.chat, content, { userJid: conn.user?.id, quoted: m });
    await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id });
}

async function processSelectedYtVideo(conn, m, selected) {
    const url = selected.url;
    const metadata = await resolveYtVideoMetadata(url, selected);
    if (!metadata?.status) {
        console.error('[YTVIDEO] Metadata failed:', metadata?.error || 'Unknown metadata error');
        await m.bigboreply('❌ I could not read this YouTube video. Please select another result.');
        return;
    }

    const duration = Number(metadata.duration || 0);
    if (duration > YTVIDEO_MAX_SECONDS) {
        await m.bigboreply('❌ This video is longer than the 20-minute limit.');
        return;
    }
    if (!duration && !selected.duration) {
        console.error('[YTVIDEO] Duration unavailable for:', url);
        await m.bigboreply('❌ I could not verify this video duration. Please select another result.');
        return;
    }

    const tempDir = path.join(__dirname, 'tmp', 'ytvideo');
    const requestToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const filePath = path.join(tempDir, `${requestToken}.mp4`);
    const title = metadata.title || selected.title || 'YouTube video';

    await m.bigboreply(`⏳ Downloading your selected video...\n🎬 ${title}\n⏱ ${formatVideoDuration(duration || selected.duration)}`);
    try {
        await fs.promises.mkdir(tempDir, { recursive: true });
        const result = await ytdlAutoVideoFile(url, filePath, '720', YTVIDEO_MAX_BYTES);
        if (!result?.status || !fs.existsSync(filePath)) {
            console.error('[YTVIDEO] Download failed:', result?.error || 'No output file');
            await m.bigboreply('❌ Failed to download this video. Please select another result.');
            return;
        }

        const stat = await fs.promises.stat(filePath);
        if (!stat.size || stat.size > YTVIDEO_MAX_BYTES) {
            console.error('[YTVIDEO] Output file rejected:', stat.size);
            await m.bigboreply('❌ This video is too large for me to send.');
            return;
        }

        await conn.sendMessage(m.chat, {
            video: { url: filePath },
            mimetype: 'video/mp4',
            fileName: `${safeVideoFilename(title)}.mp4`,
            caption: '✅ Video downloaded successfully.'
        }, { quoted: m });

        await sendChannelButton(conn, m);
    } catch (error) {
        console.error('[YTVIDEO] Download/send failed:', error?.stack || error);
        await m.bigboreply('❌ I could not download or send this video. Please try another result.');
    } finally {
        try { await fs.promises.rm(filePath, { force: true }); } catch (error) { console.error('[YTVIDEO] File cleanup failed:', error?.message || error); }
        try { await fs.promises.rm(`${filePath}.part`, { force: true }); } catch {}
        try {
            const entries = await fs.promises.readdir(tempDir);
            if (!entries.length) await fs.promises.rmdir(tempDir);
        } catch {}
    }
}


const config = require('./config.json');
const ownerPath = path.join(__dirname, 'database', 'owner.json');
const premiumPath = path.join(__dirname, 'database', 'premium.json');

const readJSON = (file) => {
    try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
        return JSON.parse(fs.readFileSync(file));
    } catch {
        return [];
    }
};

const saveJSON = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const getNumber = (jid = '') => String(jid).split('@')[0].replace(/\D/g, '');


// ==================== TAGALL HELPERS ====================
const normalizeJidForCompare = (jid = '') => {
    try {
        return jidNormalizedUser(String(jid || ''));
    } catch {
        return String(jid || '').split(':')[0];
    }
};

const isGroupAdmin = (metadata, senderJid) => {
    if (!metadata?.participants?.length || !senderJid) return false;

    const sender = String(senderJid || '').trim();
    const senderNormalized = normalizeJidForCompare(sender);
    const senderNumber = getNumber(sender);

    const participant = metadata.participants.find(p => {
        const ids = [p?.id, p?.jid, p?.lid]
            .filter(Boolean)
            .map(value => String(value).trim());

        return ids.some(id => {
            if (normalizeJidForCompare(id) === senderNormalized) return true;

            // Handles WhatsApp LID -> normal JID mappings when the message
            // sender and group participant use different identifiers.
            if (senderNumber && id.endsWith('@s.whatsapp.net')) {
                return getNumber(id) === senderNumber;
            }

            return false;
        });
    });

    if (!participant) return false;

    // Baileys normally uses 'admin' / 'superadmin'. Some forks expose the
    // role slightly differently, so accept the equivalent values as well.
    const role = participant.admin ?? participant.role ?? participant.isAdmin;
    return role === 'admin' ||
           role === 'superadmin' ||
           role === 'administrator' ||
           role === true;
};

const buildTagAllMentionChunks = (jids, size = 50) => {
    const chunks = [];
    for (let i = 0; i < jids.length; i += size) {
        chunks.push(jids.slice(i, i + size));
    }
    return chunks;
};

// Central authorization: the primary creator plus persisted added owners.
// Existing command permission checks continue to use these helpers, so SELF
// mode and owner-controlled commands recognize added owners without per-command
// hard-coding.
const isCreator = (m) => ownerSystem.isOwner(m, config);
const isOwner = (m) => ownerSystem.isOwner(m, config);
const isPrimaryCreator = (m) => ownerSystem.isPrimaryCreator(m, config);

const isPremium = (m) => {
    const sender = getNumber(m.sender);
    const premiumDB = readJSON(premiumPath);
    return isOwner(m) || premiumDB.includes(sender);
};

// System executeEval
const executeEval = async (code, conn, m) => {
    try {
        let result

        if (code.includes('\n') || code.includes(';')) {
            result = await eval(`
                (async (conn, m, require, fs, util) => {
                    ${code}
                })(conn, m, require, fs, util)
            `)
        } else {
            result = await eval(`
                (async (conn, m, require, fs, util) => {
                    return (${code})
                })(conn, m, require, fs, util)
            `)
        }

        if (typeof result !== 'string') {
            result = util.inspect(result, {
                depth: 1
            })
        }

        m.bigboreply(result || 'undefined')
    } catch (e) {
        m.bigboreply(String(e))
    }
}

//System Detect id all Button, id button gapake titik (.)
const extractCommandFromMessage = (m) => {
    if (m?.__darknoteSyntheticCommand) {
        return { body: String(m.__darknoteSyntheticCommand), isButtonResponse: false };
    }
    let body = '';
    let isButtonResponse = false;
    try {
        if (m.message) {
            if (m.message.conversation) body = m.message.conversation;
            else if (m.message.extendedTextMessage?.text) body = m.message.extendedTextMessage.text;
            else if (m.message.imageMessage?.caption) body = m.message.imageMessage.caption;
            else if (m.message.videoMessage?.caption) body = m.message.videoMessage.caption;
            else if (m.message.documentMessage?.caption) body = m.message.documentMessage.caption;
            else if (m.message.interactiveResponseMessage) {
                const inter = m.message.interactiveResponseMessage;
                if (inter.nativeFlowResponseMessage) {
                    const flow = inter.nativeFlowResponseMessage;
                    if (flow.paramsJson) {
                        try {
                            const params = JSON.parse(flow.paramsJson);
                            body = params.id || params.buttonId || params.rowId || params.index || '';
                        } catch { body = flow.name || ''; }
                    } else body = flow.name || '';
                    isButtonResponse = true;
                } else if (inter.buttonReply) {
                    body = inter.buttonReply.selectedButtonId || '';
                    isButtonResponse = true;
                } else if (inter.singleSelectReply) {
                    body = inter.singleSelectReply.selectedRowId || '';
                    isButtonResponse = true;
                }
            } else if (m.message.templateButtonReplyMessage) {
                body = m.message.templateButtonReplyMessage.selectedId || '';
                isButtonResponse = true;
            } else if (m.message.buttonsResponseMessage) {
                body = m.message.buttonsResponseMessage.selectedButtonId || '';
                isButtonResponse = true;
            }
        }
    } catch (error) {
        console.error('Error parsing message:', error);
    }
    return { body, isButtonResponse };
};






const isLikelyLinkMessage = (text = '') => {
    const value = String(text || '');
    return /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|t\.me\/|discord\.gg\/|\b[a-z0-9-]+\.(?:com|net|org|co\.[a-z]{2}|ke|io|me|xyz)\b)/i.test(value);
};

const getQuotedImageMessage = (m) => {
    let q = m?.quoted;
    if (!q) return null;

    // Normal quoted image from smsg().
    if (q.mtype === 'imageMessage') return q.msg || q.message?.imageMessage || q;

    // Also support quoted view-once/ephemeral wrappers.
    let current = q.msg || q.message || q;
    for (let i = 0; i < 4 && current; i++) {
        if (current.imageMessage) return current.imageMessage;
        if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue; }
        if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue; }
        if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue; }
        if (current.documentWithCaptionMessage?.message) { current = current.documentWithCaptionMessage.message; continue; }
        break;
    }
    return null;
};

const resolveParticipantDisplayName = async (conn, participant, resolvedJid = '') => {
    const candidates = [
        participant?.notify,
        participant?.name,
        participant?.verifiedName,
        participant?.displayName
    ];
    for (const value of candidates) {
        const name = String(value || '').replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    const ids = [
        resolvedJid,
        participant?.id,
        participant?.jid,
        participant?.lid
    ].filter(Boolean);

    for (const id of ids) {
        const raw = String(id);
        const normalized = normalizeJidForCompare(raw);
        const contact = conn?.contacts?.[normalized] || conn?.contacts?.[raw];
        const chat = conn?.chats?.[normalized] || conn?.chats?.[raw];
        const name = String(
            contact?.notify || contact?.name || contact?.verifiedName ||
            chat?.name || chat?.notify || ''
        ).replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    // Last safe fallback: use a real WhatsApp number, never a JID/LID string.
    const number = getNumber(resolvedJid || participant?.id || participant?.jid || '');
    return number ? number : 'WhatsApp member';
};

const getParticipantDisplayName = (conn, participant) => {
    const candidates = [participant?.notify, participant?.name, participant?.verifiedName, participant?.displayName];
    for (const value of candidates) {
        const name = String(value || '').replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    const ids = [participant?.id, participant?.jid, participant?.lid].filter(Boolean);
    for (const id of ids) {
        const normalized = normalizeJidForCompare(id);
        const contact = conn?.contacts?.[normalized] || conn?.contacts?.[id];
        const name = String(contact?.notify || contact?.name || contact?.verifiedName || '').replace(/[\r\n]+/g, ' ').trim();
        if (name) return name.slice(0, 45);
    }

    return 'WhatsApp member';
};

const handleAutomaticViewOnce = async (conn, rawMessage) => {
    try {
        if (!config.vv2Auto || !rawMessage?.message || rawMessage.key?.fromMe) return;
        if (rawMessage.key?.remoteJid === 'status@broadcast') return;

        let current = rawMessage.message;
        // Support all view-once wrappers used by the current Baileys/fork builds.
        for (let i = 0; i < 5 && current; i++) {
            if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue; }
            if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue; }
            if (current.viewOnceMessageV2Extension?.message) { current = current.viewOnceMessageV2Extension.message; continue; }
            if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue; }
            break;
        }

        const type = Object.keys(current || {}).find(k => /^(image|video|audio|document)Message$/.test(k));
        if (!type) return;
        const media = current[type];
        if (!media) return;

        // Some builds unwrap the view-once wrapper and leave the flag on the media node.
        const wasViewOnce = !!media.viewOnce || /viewOnceMessage/i.test(Object.keys(rawMessage.message || {}).join(' '));
        if (!wasViewOnce && !rawMessage.message.viewOnceMessageV2 && !rawMessage.message.viewOnceMessage && !rawMessage.message.viewOnceMessageV2Extension) return;

        const selfJid = jidNormalizedUser(conn.user?.id || '');
        if (!selfJid) return;

        // Download immediately while the one-time media is still available. This
        // buffer is retained in memory until the send completes, so a later delete
        // event cannot make an already-received view-once unavailable to VV2AUTO.
        const mediaType = type.replace('Message', '').toLowerCase();
        const stream = await downloadContentFromMessage(media, mediaType);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) throw new Error('View-once media download returned no data');

        if (type === 'imageMessage') {
            await conn.sendMessage(selfJid, { image: buffer, caption: media.caption || undefined });
        } else if (type === 'videoMessage') {
            await conn.sendMessage(selfJid, { video: buffer, mimetype: media.mimetype || 'video/mp4', caption: media.caption || undefined });
        } else if (type === 'audioMessage') {
            await conn.sendMessage(selfJid, { audio: buffer, mimetype: media.mimetype || 'audio/mpeg', ptt: !!media.ptt });
        } else {
            await conn.sendMessage(selfJid, {
                document: buffer,
                mimetype: media.mimetype || 'application/octet-stream',
                fileName: media.fileName || 'DARKNOTE-file'
            });
        }
    } catch (error) {
        console.error('[VV2 AUTO] Error:', error?.stack || error);
    }
};

const normalizeBlockNumber = (value = '') => {
    let number = String(value || '').trim().replace(/\D/g, '');
    if (number.startsWith('00')) number = number.slice(2);
    // Preserve the project's existing international-number convention while also
    // accepting a normal Kenyan local mobile format such as 07XXXXXXXX.
    if (/^0\d{9}$/.test(number)) number = `254${number.slice(1)}`;
    return number;
};

const sanitizeBlockError = (error, targetNumber) => {
    let message = String(error?.message || error || 'Unknown WhatsApp error');
    if (targetNumber) message = message.replace(new RegExp(`${targetNumber}@(?:s\\.whatsapp\\.net|lid|g\\.us)`, 'gi'), targetNumber);
    message = message.replace(/\b\d{8,15}@(s\.whatsapp\.net|lid|g\.us)\b/gi, (match) => match.split('@')[0]);
    return message.slice(0, 220);
};

const resolveBlockTarget = async (conn, m, args) => {
    const contextInfo = m.message?.extendedTextMessage?.contextInfo || m.msg?.contextInfo || {};
    let target = contextInfo.mentionedJid?.[0] || m.mentionedJid?.[0] || m.quoted?.sender;

    if (!target) {
        const number = normalizeBlockNumber(args.join(' '));
        if (/^\d{8,15}$/.test(number)) target = `${number}@s.whatsapp.net`;
    }
    if (!target) return null;

    target = conn.decodeJid(target);
    if (target?.endsWith('@lid') && typeof conn.resolveLidEnhanced === 'function') {
        target = await conn.resolveLidEnhanced(target);
    }
    target = conn.decodeJid(target);

    if (!target || !/@s\.whatsapp\.net$/i.test(target)) {
        throw new Error('Unable to resolve the target WhatsApp account');
    }
    return target;
};

// Owner-selectable delivery for member lists. "auto" tries the native
// horizontal carousel first and falls back to paginated text with real
// mentions; "text" forces the guaranteed-mention text pages; "carousel"
// only uses the carousel.
// config.json re-read from disk. The module-level `config` object is a load-time
// snapshot, so anything that must react to an edit (a security guard especially)
// has to read the file itself.
const liveConfig = () => {
    const configPath = path.join(__dirname, 'config.json');
    try {
        delete require.cache[require.resolve(configPath)];
        return require(configPath) || {};
    } catch (error) {
        console.error('[CONFIG] live read failed, using the loaded config:', error?.message || error);
        return config || {};
    }
};

const cardsMode = () => {
    const mode = String(liveConfig()?.cards?.mode || 'auto').toLowerCase();
    return ['auto', 'text', 'carousel'].includes(mode) ? mode : 'auto';
};

// Numbers that must never be blocked. Configured in
// config.json -> "protectedBlockJids" (string or array); the bot's own number
// and config.ownerNumber are always included. Nothing is hard-coded here.
const protectedBlockNumbers = (conn) => {
    const live = liveConfig();
    const configured = Array.isArray(live?.protectedBlockJids)
        ? live.protectedBlockJids
        : [live?.protectedBlockJids];
    const numbers = configured
        .map(value => getNumber(String(value || '')))
        .filter(value => /^\d{8,15}$/.test(value));
    for (const extra of [getNumber(live?.ownerNumber || config?.ownerNumber || ''), getNumber(conn?.user?.id || '')]) {
        if (/^\d{8,15}$/.test(extra)) numbers.push(extra);
    }
    return [...new Set(numbers)];
};

module.exports = async (conn, m) => {
    // The owner layer needs the live connection to know which number this bot is
    // paired to: that number is always an owner, and it keys the per-session
    // owner store. Without this line owner-system falls back to "unpaired".
    m.__darknoteConn = conn;
    try {
        /*
         * ANTI-FEATURE HOOK. Runs before the body check on purpose: a sticker or
         * a bare image has NO text, so checking after `if (!body) return` would
         * mean antisticker and antimedia could never see the very messages they
         * exist to police. This is the ONE message-side entry into the security
         * engine - there is no second messages.upsert listener anywhere.
         */
        if (m.isGroup && !m.key?.fromMe) {
            try {
                await security.handleMessage(conn, m, {
                    selfIds: [conn.user?.id, conn.user?.lid].filter(Boolean),
                    isOwner: jid => ownerSystem.isOwner({ sender: jid, chat: m.chat }, config),
                    deleteMessage: async () => {
                        if (typeof conn.sendMessage !== 'function') return
                        await conn.sendMessage(m.chat, { delete: m.key })
                    }
                })
            } catch (error) {
                console.error('[SECURITY] message handling failed:', error?.message || error);
            }
        }

        const { body, isButtonResponse } = extractCommandFromMessage(m);
        if (!body) return;
        if (body) m.text = body;

        let command = '';
        let args = [];

        if (isButtonResponse) {
            const parts = body.split(/ +/);
            command = parts[0].toLowerCase();
            args = parts.slice(1);
            if (command.startsWith('ytvideo_select_')) {
                const match = command.match(/^ytvideo_select_([a-z0-9]+)_([0-9]+)$/i);
                if (match) { command = 'ytvideo_select'; args = [match[1], match[2]]; }
            }
            // Shazam card buttons: shazam_audio_<resultIndex>_<sessionId>
            // The button only carries the session id and the result number, never
            // the YouTube URL.
            if (/^shazam_(audio|play|file|video)_/i.test(command)) {
                const match = command.match(/^shazam_(audio|play|file|video)_([0-9]+)_([a-z0-9]+)$/i);
                if (match) {
                    command = `shazam_${match[1].toLowerCase()}`;
                    args = [match[2], match[3]];
                }
            }
        } else {
            const trimmed = body.trim();
            if (trimmed.startsWith(']>')) {
                if (!isCreator(m)) return m.bigboreply('The eval command is for the creator only.');
                const evalCode = trimmed.slice(2).trim();
                if (!evalCode) return m.bigboreply('Example:\n]> 1+1');
                return await executeEval(evalCode, conn, m);
            }
            if (trimmed.startsWith('$')) {
                if (!isCreator(m)) return m.bigboreply('❌ The shell command is for the creator only.');
                const shellCmd = trimmed.slice(1).trim();
                if (!shellCmd) return m.bigboreply('Example: $ ls -la');
                m.bigboreply('⏳ Running the shell command...');
                exec(shellCmd, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
                    let output = stdout || stderr || error?.message || '✅ Finished (no output)';
                    if (output.length > 2000) output = output.slice(0, 2000) + '\n... (output truncated)';
                    m.bigboreply(`💻 Output:\n${output}`);
                });
                return;
            }
            if (body.startsWith(config.prefix || '.')) {
                const cleanBody = body.slice(1).trim();
                const parts = cleanBody.split(/ +/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            } else {
                // PREFIX-FREE PATH - the AI chatbot is the ONLY feature allowed
                // to run without the command prefix. This sits in the existing
                // single dispatcher, AFTER the command check, so it can never
                // shadow a registered command. aiService.handle() decides for
                // itself whether this message qualifies (DM, or a real mention
                // in a group) and returns immediately when it does not.
                try {
                    await aiService.handle(conn, m, {
                        isOwner: isOwner(m),
                        mode: config.mode,
                        prefix: config.prefix
                    });
                } catch (error) {
                    console.error('[AI] dispatcher hand-off failed:', error?.stack || error);
                }
                return;
            }
        }

        // Resolve aliases through the existing dispatcher. A native .ss status
        // reply keeps priority so .cmdset vv ss can coexist with Status Save.
        if (!isButtonResponse && command && !(command === 'ss' && isNativeStatusSave(m))) {
            const resolvedCommand = resolveForDispatch(command, conn);
            if (resolvedCommand) command = resolvedCommand;
        }
        m.prefix = config.prefix || '.';

        if (!m.__darknoteChannelResponseAttached && typeof m.bigboreply === 'function') {
            const originalReply = m.bigboreply.bind(m);
            m.bigboreply = async (text, chatId, options) => {
                const sent = await originalReply(text, chatId, options);
                try { await sendChannelButton(conn, m); } catch (error) { console.error('[CHANNEL] Button failed:', error?.message || error); }
                return sent;
            };
            m.__darknoteChannelResponseAttached = true;
        }
        const { bigboreply } = m;

        // Resolved against the project root so the bot still starts when it is
        // launched from another working directory.
        const thumb = await sharp(path.join(__dirname, 'src', 'img', 'menu.jpg'))
        .resize(300, 300)
        .jpeg({ quality: 80 })
        .toBuffer()

       // Self
       if (config.mode === 'self' && !isCreator(m)) return
       //Case
        switch (command) {

        case 'menu': {
    const runtime = process.uptime()

    const days = Math.floor(runtime / 86400)
    const hours = Math.floor((runtime % 86400) / 3600)
    const minutes = Math.floor((runtime % 3600) / 60)
    const seconds = Math.floor(runtime % 60)

    // Baileys can hand back a protobuf Long here, which Number() turns into
    // NaN. Normalise it before computing the round trip.
    const rawStamp = m.messageTimestamp
    const stampSeconds = (rawStamp && typeof rawStamp === 'object' && typeof rawStamp.toNumber === 'function')
        ? rawStamp.toNumber()
        : Number(rawStamp && typeof rawStamp === 'object' && rawStamp.low !== undefined ? rawStamp.low : rawStamp)
    const ping = Number.isFinite(stampSeconds) && stampSeconds > 0 ? Math.max(0, Date.now() - stampSeconds * 1000) : 0
    const mode = config.mode === 'self' ? 'SELF' : 'PUBLIC'

    await conn.relayMessage(
        m.chat,
        {
            buttonsMessage: {
                locationMessage: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    name: 'DARKNOTE L2',
                    address: 'Bigbrother',
                    jpegThumbnail: thumb
                },
contentText: menu.build(config, {
                    mode,
                    number: String(m.sender).replace(/@.+/g, ''),
                    ping,
                    runtime: `${days}H ${hours}J ${minutes}M ${seconds}D`
                }).text,
                footerText: 'DARKNOTE L2 • Bigbrother',
                buttons: [
                    {
                        buttonId: 'allmenu',
                        buttonText: {
                            displayText: 'All Menu'
                        },
                        type: 1
                    }
                ],
                headerType: 6
            }
        },
        {
            quoted: m,
            messageId: conn.generateMessageTag()
        }
    )
    break
}

        /*
         * AUTO HUMAN REPLY. Persistent: written through the existing AI settings
         * layer into config.json, so it survives a restart or a reconnect. It is
         * its own switch - it does not touch `.chatbot`.
         */
        case 'autohuman': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                return bigboreply(`${aiService.autohuman.statusText()}\n\nUsage: ${config.prefix || '.'}autohuman on|off\n\nWhen ON, DARKNOTE continues DMs in the other person's own style using the last ${aiService.config.getAiSettings().autohumanContextMessages} messages. It never replies to commands.`);
            }
            aiService.config.writeAiSetting('autohumanEnabled', mode === 'on');
            if (mode === 'on') {
                return bigboreply('✅ Auto Human Reply is now ON.\n\nDARKNOTE will read the recent conversation per contact and reply like a person. Commands still take priority.');
            }
            return bigboreply('✅ Auto Human Reply is now OFF.\n\nNo AI replies will be generated.');
        }

        // Runtime Alive status - the real socket state, not a guess.
        case 'runtime':
        case 'alive': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const health = runtimeMonitor.getState();
            return bigboreply(`${runtimeMonitor.statusText()}\n\nLast error: ${health.lastError || 'none'}\nReconnects: ${health.reconnects}`);
        }

        // Telegram controller status.
        case 'tgstatus': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            let text = 'TELEGRAM CONTROLLER\n\nNot loaded.';
            try { text = require('./lib/telegram.js').statusText(); } catch (error) {
                console.error('[TELEGRAM] status failed:', error?.message || error);
            }
            return bigboreply(text);
        }

        case 'tagall': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                if (!isGroupAdmin(metadata, m.sender)) return bigboreply('❌ Only group admins can use .tagall.');
                // Bot identities in the same form resolveMembers() compares, so
                // the bot never tags itself.
                const botJid = display.bare(conn.user?.id || '');
                const botLid = display.bare(conn.user?.lid || '');
                /*
                 * VERTICAL PLAIN TEXT, not cards.
                 *
                 * resolveMembers() returns one entry per real member with the
                 * WhatsApp display name and a mention token. The JIDs go into
                 * `mentions` ONLY - the visible text carries the token, which
                 * WhatsApp replaces with the person's own name, so no number and
                 * no JID is ever displayed.
                 *
                 * Sent with one sendMessage call, so one command produces exactly
                 * one message.
                 */
                const members = display.resolveMembers(conn, metadata.participants, { excludeJids: [botJid, botLid].filter(Boolean) });
                if (!members.length) return bigboreply('❌ No members were found to mention.');

                const text = display.memberBox('TAGALL', members, {
                    summary: `Total: ${members.length} member${members.length === 1 ? '' : 's'}`
                });
                if (display.containsJid(text)) {
                    // Should be impossible; if it ever happens, refuse to send
                    // rather than leak an identifier.
                    console.error('[TAGALL] refusing to send text containing a JID');
                    return bigboreply('❌ Failed to tag the group members. Please try again.');
                }
                await conn.sendMessage(m.chat, { text, mentions: display.mentionsOf(members) }, { quoted: m });
            } catch (error) {
                console.error('[TAGALL] Error:', error?.stack || error);
                return bigboreply('❌ Failed to tag the group members. Please try again.');
            }
            break;
        }


        case 'listonline': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                const botJid = normalizeJidForCompare(conn.user?.id || '');
                const online = groupFeatures.getOnlineParticipants(conn, metadata)
                    .filter(p => normalizeJidForCompare(groupFeatures.participantJid(p)) !== botJid);
                if (!online.length) return bigboreply('ℹ️ No group participants are currently detected as online.\n\nTip: presence is based on the latest WhatsApp presence updates received by the bot.');
                const entries = online.map(p => cards.participantEntry(conn, p, '🟢 Online'));
                const cardResult = await cards.sendMemberPages(conn, m, {
                    heading: '🟢 ONLINE MEMBERS',
                    entries,
                    mode: cardsMode(),
                    summary: `Total online: ${entries.length}`,
                    emptyMessage: 'ℹ️ No group participants are currently detected as online.',
                    failureMessage: '❌ Failed to read the group online list.',
                    reply: bigboreply
                });
                if (!cardResult.ok) {
                    console.error(`[LISTONLINE] member cards failed: ${cardResult.code} ${cardResult.reason || ''}`);
                    return bigboreply('❌ Failed to read the group online list.');
                }
                return;
            } catch (error) {
                console.error('[LISTONLINE] Error:', error?.stack || error);
                return bigboreply('❌ Failed to read the group online list.');
            }
        }

        case 'listinactive':
        case 'listactive': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                const activity = groupFeatures.getTodayActivity(m.chat);
                const botJid = normalizeJidForCompare(conn.user?.id || '');
                const members = (metadata.participants || []).filter(p => normalizeJidForCompare(groupFeatures.participantJid(p)) !== botJid);
                const rows = members.map(p => {
                    const jid = groupFeatures.participantJid(p);
                    const key = normalizeJidForCompare(jid);
                    return { p, jid, count: Number(activity[key] || activity[String(jid).split(':')[0].toLowerCase()] || 0) };
                });
                if (command === 'listinactive') {
                    const inactive = rows.filter(r => r.count === 0);
                    if (!inactive.length) return bigboreply('✅ Everyone in the group has sent at least one message today.');
                    const entries = inactive.map(r => cards.participantEntry(conn, r.p, '0 msgs today'));
                    const cardResult = await cards.sendMemberPages(conn, m, {
                        heading: '🔴 INACTIVE TODAY',
                        entries,
                        mode: cardsMode(),
                        summary: `Total inactive: ${entries.length}`,
                        emptyMessage: '✅ Everyone in the group has sent at least one message today.',
                        failureMessage: '❌ Failed to generate the listinactive report.',
                        reply: bigboreply
                    });
                    if (!cardResult.ok) {
                        console.error(`[LISTINACTIVE] member cards failed: ${cardResult.code} ${cardResult.reason || ''}`);
                        return bigboreply('❌ Failed to generate the listinactive report.');
                    }
                    return;
                }
                const active = rows.filter(r => r.count > 0).sort((a, b) => b.count - a.count);
                if (!active.length) return bigboreply('ℹ️ No member messages have been recorded today.');
                const total = active.reduce((sum, r) => sum + r.count, 0);
                const entries = active.map(r => cards.participantEntry(conn, r.p, `${r.count} msg${r.count === 1 ? '' : 's'}`));
                const cardResult = await cards.sendMemberPages(conn, m, {
                    heading: '🟢 ACTIVE MEMBERS TODAY',
                    entries,
                    mode: cardsMode(),
                    summary: `Total = ${total} messages\nActive members = ${entries.length}`,
                    emptyMessage: 'ℹ️ No member messages have been recorded today.',
                    failureMessage: '❌ Failed to generate the listactive report.',
                    reply: bigboreply
                });
                if (!cardResult.ok) {
                    console.error(`[LISTACTIVE] member cards failed: ${cardResult.code} ${cardResult.reason || ''}`);
                    return bigboreply('❌ Failed to generate the listactive report.');
                }
                return;
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to generate the ${command} report.`);
            }
        }

        case 'groupadmins':
        case 'groupadmin':
        case 'admin': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                /*
                 * `admin` keeps its existing meaning (the group creator when
                 * WhatsApp marks one, otherwise the admins); `groupadmin` and
                 * `groupadmins` list every admin. The creator is never invented:
                 * when WhatsApp does not mark one, the admins are listed with an
                 * explicit note.
                 */
                const allAdmins = display.resolveMembers(conn, metadata.participants, { adminOnly: true });
                if (!allAdmins.length) return bigboreply('ℹ️ No group admins were found.');
                const creator = allAdmins.find(member => member.isCreator);
                const target = command === 'admin' ? (creator ? [creator] : allAdmins) : allAdmins;

                const heading = command === 'admin'
                    ? (creator ? 'ADMIN' : 'GROUP ADMINS')
                    : 'GROUPADMIN';
                const note = command === 'admin' && !creator ? 'No creator found. Group admins:' : '';
                const text = display.memberBox(heading, target, {
                    summary: [note, `Total: ${target.length}`].filter(Boolean).join('\n')
                });
                if (display.containsJid(text)) {
                    console.error(`[${command.toUpperCase()}] refusing to send text containing a JID`);
                    return bigboreply(`❌ Failed to retrieve the group admins.`);
                }
                await conn.sendMessage(m.chat, { text, mentions: display.mentionsOf(target) }, { quoted: m });
                return;
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to retrieve the group admins.`);
            }
        }

        /*
         * EVIL_PAIN - destructive, so it is owner-only, group-only, admin-checked
         * and confirmation-gated. `evil_pain` alone only prints the warning;
         * nothing is removed until `evil_pain confirm`.
         */
        case 'evil_pain': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            if (!m.isGroup) return bigboreply('❌ This command only works inside a group.');

            const action = String(args[0] || '').toLowerCase();
            if (action !== 'confirm') {
                evilPain.markWarned(m.chat);
                return bigboreply(evilPain.warningText());
            }

            if (evilPain.isRunning(m.chat)) {
                return bigboreply('⏳ This is already running in this group.');
            }

            // Verify BEFORE doing anything irreversible, and name the real reason.
            const check = await evilPain.checkRequirements(conn, m);
            if (!check.ok) return bigboreply(evilPain.reasonText(check.reason));

            // The executor's own push name - never their number or JID.
            const ownerName = display.senderName(conn, m);
            await bigboreply(`☬ EVIL_PAIN started. Acting as: ${ownerName}`);

            const results = await evilPain.execute(conn, m, ownerName, {
                notify: text => conn.sendMessage(m.chat, { text })
            });

            if (!results.ok) {
                return bigboreply(evilPain.reasonText(results.reason) || '❌ The operation could not be completed.');
            }
            // The summary was already delivered inside the sequence, before the
            // bot left the group. Nothing more is sent here.
            break;
        }

        /*
         * STATE - honest snapshot of one person, using only what the live
         * connection actually exposes. In a DM it reports the other participant;
         * in a group it reports whoever was quoted or mentioned.
         */
        case 'state': {
            let target = '';
            if (!m.isGroup) {
                // In a DM the "other participant" is the chat itself.
                target = display.bare(m.chat);
            } else if (m.quoted?.sender) {
                target = display.bare(m.quoted.sender);
            } else if (Array.isArray(m.mentionedJid) && m.mentionedJid.length) {
                target = display.bare(m.mentionedJid[0]);
            }
            if (!target || target.endsWith('@g.us')) {
                return bigboreply([
                    '❌ *STATE* needs a person.',
                    '',
                    `• In a DM, just send ${config.prefix || '.'}state`,
                    `• In a group, reply to someone's message with ${config.prefix || '.'}state`
                ].join('\n'));
            }

            try {
                const snapshot = await userInfo.stateText(conn, target);
                if (!snapshot.ok) return bigboreply('❌ I could not read that contact.');
                return bigboreply(userInfo.renderState(snapshot));
            } catch (error) {
                console.error('[STATE] Error:', error?.stack || error);
                return bigboreply('❌ I could not read that contact right now.');
            }
        }

        // GPPP - send the current group's picture. The group is taken from the
        // message context; the user never supplies a JID and never sees one.
        case 'gppp': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const picture = await userInfo.groupPicture(conn, m.chat);
                if (!picture.ok) {
                    if (picture.reason === 'no-picture') {
                        return bigboreply('ℹ️ This group has no profile picture set.');
                    }
                    return bigboreply("❌ I couldn't fetch this group's picture. Please try again.");
                }
                await conn.sendMessage(m.chat, { image: picture.buffer }, { quoted: m });
            } catch (error) {
                console.error('[GPPP] Error:', error?.stack || error);
                return bigboreply("❌ I couldn't fetch this group's picture. Please try again.");
            }
            break;
        }

        case 'groupjid': {
            try {
                if (m.isGroup && !args[0]) return bigboreply(`📌 Group JID:\n${m.chat}`);
                if (args[0] && !/^https?:\/\/|^chat\.whatsapp\.com\//i.test(args[0])) {
                    const groups = groupFeatures.getSelection(m);
                    const index = Number(args[0]);
                    if (groups && Number.isInteger(index) && index >= 1 && index <= groups.length) return bigboreply(`📌 Group JID:\n${groups[index - 1].id}`);
                }
                if (args[0]) {
                    const resolved = await groupFeatures.resolveGroupInvite(conn, args[0]);
                    if (!resolved) return bigboreply(`Usage: ${config.prefix || '.'}groupjid <group invite link>`);
                    return bigboreply(`📌 Group JID:\n${resolved.jid}`);
                }
                if (!m.isGroup) {
                    const groups = Object.values(conn.chats || {}).filter(c => c?.id?.endsWith('@g.us')).map(c => ({ id: c.id, name: c.subject || c.name || c.id }));
                    if (!groups.length) return bigboreply('❌ No groups are available in this session.');
                    groupFeatures.saveSelection(m, groups);
                    const text = groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
                    return bigboreply(`📋 *SELECT A GROUP*\n\n${text}\n\nReply with: ${config.prefix || '.'}groupjid <number>`);
                }
            } catch (error) {
                console.error('[GROUPJID] Error:', error?.stack || error);
                const message = String(error?.message || '');
                if (/permission|forbidden|admin/i.test(message)) return bigboreply('❌ Only admins can share/have the group link.');
                return bigboreply(`❌ Could not resolve that group link. ${message}`.trim());
            }
            break;
        }

        case 'channeljid': {
            try {
                if (!args[0] && (m.chat || '').endsWith('@newsletter')) return bigboreply(`📢 Channel JID:\n${m.chat}`);
                if (!args[0]) return bigboreply(`Usage: ${config.prefix || '.'}channeljid <channel link>`);
                const resolved = await groupFeatures.resolveChannelLink(conn, args[0]);
                if (!resolved) return bigboreply(`Usage: ${config.prefix || '.'}channeljid <channel link>`);
                return bigboreply(`📢 Channel JID:\n${resolved.jid}`);
            } catch (error) {
                console.error('[CHANNELJID] Error:', error?.stack || error);
                return bigboreply('❌ Could not resolve that channel link with the current Baileys build.');
            }
        }

        case 'avs':
        case 'als':
        case 'ars': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[args.length - 1] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                const current = config.statusAutomation?.[command] || (command === 'ars' ? { enabled: false, emoji: '😊' } : { enabled: false });
                return bigboreply(`Usage: ${config.prefix || '.'}${command}${command === 'ars' ? ' 😊' : ''} on|off\n\nCurrent: ${current.enabled ? 'ON' : 'OFF'}${command === 'ars' ? `\nEmoji: ${current.emoji || '😊'}` : ''}`);
            }
            config.statusAutomation = config.statusAutomation || {};
            if (command === 'ars') {
                const suppliedEmoji = args.length > 1 ? String(args[0] || '').trim() : '';
                if (args.length > 1 && !['on', 'off'].includes(String(args[1]).toLowerCase())) return bigboreply(`Usage: ${config.prefix || '.'}ars 😊 on|off`);
                const emoji = suppliedEmoji && !['on', 'off'].includes(suppliedEmoji.toLowerCase())
                    ? suppliedEmoji
                    : (config.statusAutomation.ars?.emoji || '😊');
                config.statusAutomation.ars = { enabled: mode === 'on', emoji };
            } else {
                config.statusAutomation[command] = { enabled: mode === 'on' };
            }
            fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
            const state = config.statusAutomation[command];
            return bigboreply(`✅ ${command.toUpperCase()} is now ${state.enabled ? 'ON' : 'OFF'}${command === 'ars' ? `\nReaction: ${state.emoji}` : ''}`);
        }

        // Presence and group control. Delegated to the AI service because that is
        // where the ONE safe scheduler lives, so an online cycle or a group timer
        // can never spawn duplicate loops.
        case 'online': {
            try {
                const handled = await aiService.runCommand(conn, m, 'online', args, bigboreply, {
                    isOwner: isOwner(m), mode: config.mode, prefix: config.prefix
                });
                if (handled) break;
            } catch (error) {
                console.error('[ONLINE] failed:', error?.stack || error);
                return bigboreply('❌ The online command failed.');
            }
            break;
        }

        case 'close':
        case 'open': {
            try {
                const handled = await aiService.runCommand(conn, m, command, args, bigboreply, {
                    isOwner: isCreator(m), mode: config.mode, prefix: config.prefix
                });
                if (handled) break;
            } catch (error) {
                console.error('[GROUPCONTROL] failed:', error?.stack || error);
                return bigboreply('❌ The group control command failed.');
            }
            break;
        }

        case 'autoread':
        case 'autotyping':
        case 'autorecoding': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const enabled = config[command] === true;
            const mode = String(args[args.length - 1] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                return bigboreply(`Usage: ${config.prefix || '.'}${command} on|off\n\nCurrent: ${enabled ? 'ON' : 'OFF'}`);
            }
            config[command] = mode === 'on';
            fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
            return bigboreply(`✅ ${command.toUpperCase()} is now ${config[command] ? 'ON' : 'OFF'}`);
        }

        case 'setstatus': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            try {
                const q = m.quoted;
                if (!q) return bigboreply(`Reply to a text, image, or video, then use ${config.prefix || '.'}setstatus.`);
                // Status needs an audience list. Inside a group the participants
                // are the natural audience; in a direct chat the list is left out
                // so WhatsApp applies the account's own Status privacy settings.
                let statusJidList = [];
                if (m.isGroup) {
                    const metadata = await conn.groupMetadata(m.chat);
                    statusJidList = (metadata.participants || [])
                        .map(p => p.id || p.jid || p.lid)
                        .filter(Boolean)
                        .filter(j => normalizeJidForCompare(j) !== normalizeJidForCompare(conn.user?.id || ''));
                }
                const sendOptions = statusJidList.length ? { statusJidList } : {};
                // q.mtype arrives in mixed case, so normalise it and compare in
                // lower case.
                const mediaType = String(q.mtype || '').toLowerCase();
                if (mediaType === 'imagemessage' || mediaType === 'videomessage') {
                    const buffer = await q.download();
                    if (!buffer?.length) throw new Error('Could not download the replied media.');
                    const payload = mediaType === 'imagemessage'
                        ? { image: buffer, caption: q.caption || undefined }
                        : { video: buffer, mimetype: q.mimetype || 'video/mp4', caption: q.caption || undefined };
                    await conn.sendMessage('status@broadcast', payload, sendOptions);
                } else {
                    const text = String(q.text || q.caption || '').trim();
                    if (!text) return bigboreply('❌ The replied message does not contain usable text/media.');
                    await conn.sendMessage('status@broadcast', { text }, sendOptions);
                }
                return bigboreply('✅ Posted to your WhatsApp Status.');
            } catch (error) {
                console.error('[SETSTATUS] Error:', error?.stack || error);
                return bigboreply('❌ Failed to post the replied content to WhatsApp Status.');
            }
        }

        case 'gpstatus': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used inside a group.');
            try {
                const q = m.quoted;
                if (!q) return bigboreply(`Reply to a text, image, or video, then use ${config.prefix || '.'}gpstatus.`);
                const metadata = await conn.groupMetadata(m.chat);
                const statusJidList = (metadata.participants || []).map(p => p.id || p.jid || p.lid).filter(Boolean).filter(j => normalizeJidForCompare(j) !== normalizeJidForCompare(conn.user?.id || ''));
                // q.mtype is lower-cased on the line above, so the comparison must
                // be lower case too. The original mixed-case test never matched and
                // every image/video reply fell through to the text branch.
                const type = String(q.mtype || '').toLowerCase();
                if (type === 'imagemessage' || type === 'videomessage') {
                    const buffer = await q.download();
                    if (!buffer?.length) throw new Error('Could not download the replied media.');
                    const payload = type === 'imagemessage' ? { image: buffer, caption: q.caption || undefined } : { video: buffer, mimetype: q.mimetype || 'video/mp4', caption: q.caption || undefined };
                    await conn.sendMessage('status@broadcast', payload, { statusJidList });
                } else {
                    const text = String(q.text || q.caption || '').trim();
                    if (!text) return bigboreply('❌ The replied message does not contain usable text/media.');
                    await conn.sendMessage('status@broadcast', { text }, { statusJidList });
                }
                return bigboreply('✅ Group content has been posted to your WhatsApp Status.');
            } catch (error) {
                console.error('[GPSTATUS] Error:', error?.stack || error);
                return bigboreply('❌ Failed to post the group content to WhatsApp Status.');
            }
        }

        case 'hidetag': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                if (!isGroupAdmin(metadata, m.sender)) return bigboreply('❌ Only group admins can use .hidetag.');
                const botJid = normalizeJidForCompare(conn.user?.id || '');
                const mentions = (metadata.participants || []).map(p => p.id || p.jid).filter(Boolean).filter(jid => normalizeJidForCompare(jid) !== botJid);
                await conn.sendMessage(m.chat, { text: args.join(' ').trim() || 'ㅤ', mentions }, { quoted: m });
            } catch (error) { console.error('[HIDETAG] Error:', error?.stack || error); return bigboreply('❌ Failed to hide-tag the group.'); }
            break;
        }

        case 'kick': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            try {
                const metadata = await conn.groupMetadata(m.chat);
                if (!isGroupAdmin(metadata, m.sender)) return bigboreply('❌ Only group admins can use .kick.');
                if (!isGroupAdmin(metadata, conn.user?.id || '')) return bigboreply('❌ DARKNOTE must be a group admin to kick members.');
                let target = m.quoted?.sender || m.mentionedJid?.[0] || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                const raw = String(args[0] || '').replace(/\D/g, '');
                if (!target && /^\d{8,15}$/.test(raw)) target = `${raw}@s.whatsapp.net`;
                if (!target) return bigboreply(`❌ Reply to, mention, or provide the member number.\n\nUsage: ${config.prefix || '.'}kick 2547XXXXXXXX`);
                const p = (metadata.participants || []).find(x => [x.id, x.jid, x.lid].filter(Boolean).some(id => normalizeJidForCompare(id) === normalizeJidForCompare(target) || getNumber(id) === getNumber(target)));
                if (!p) return bigboreply('❌ That user is not in this group.');
                if (isGroupAdmin(metadata, p.id || p.jid || target)) return bigboreply('❌ I cannot kick a group admin.');
                await conn.groupParticipantsUpdate(m.chat, [p.id || p.jid || target], 'remove');
            } catch (error) { console.error('[KICK] Error:', error?.stack || error); return bigboreply('❌ Failed to remove that member.'); }
            break;
        }

        case 'add': {
            try {
                const { dispatchGroup } = require('./lib/protected-group.js');
                await dispatchGroup(conn, m, args, command, bigboreply, isOwner);
            } catch (error) {
                console.error('[ADD] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to process .add.');
            }
            break;
        }

        case 'promote':
        case 'demote': {
            try {
                const { dispatchGroup } = require('./lib/protected-group.js');
                await dispatchGroup(conn, m, args, command, bigboreply, isOwner);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] integration error:`, error?.stack || error);
                return bigboreply(`❌ Failed to process .${command}.`);
            }
            break;
        }

        case 'leave': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            try { await conn.groupLeave(m.chat); } catch (error) { console.error('[LEAVE] Error:', error?.stack || error); return bigboreply('❌ Failed to leave this group.'); }
            break;
        }

        case 'join': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            const value = String(args[0] || '').trim();
            const match = value.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
            const code = match?.[1] || (/^[A-Za-z0-9_-]{8,}$/.test(value) ? value : '');
            if (!code) return bigboreply(`❌ Provide a WhatsApp group invite link.\n\nUsage: ${config.prefix || '.'}join https://chat.whatsapp.com/XXXXXXXX`);
            try { await conn.groupAcceptInvite(code); await bigboreply('✅ Joined the group successfully.'); } catch (error) { console.error('[JOIN] Error:', error?.stack || error); return bigboreply('❌ Invalid, expired, revoked, or unavailable group invite link.'); }
            break;
        }

        case 'cmdset': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            if (args.length !== 2) return bigboreply(`Usage: ${config.prefix || '.'}cmdset <existing-command> <new-name>`);
            const result = configureAlias(args[0], args[1], conn);
            if (!result.ok) return bigboreply(result.message);
            return bigboreply(`✅ Alias created: ${config.prefix || '.'}${result.alias} → ${config.prefix || '.'}${result.target}`);
        }

        case 'stckcmd': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            if (args.length !== 1) return bigboreply(`Usage: ${config.prefix || '.'}stckcmd <command>

Reply to a sticker when using this command.`);
            try {
                const { getStickerMessage, setStickerCommand } = require('./lib/sticker-commands.js');
                const sticker = getStickerMessage(m);
                if (!sticker || m?.quoted?.mtype !== 'stickerMessage') return bigboreply(`❌ Reply to a sticker.

Usage: ${config.prefix || '.'}stckcmd <command>`);
                const result = await setStickerCommand(sticker, args[0], conn);
                if (!result.ok) return bigboreply(result.message);
                return bigboreply(`✅ Sticker command set to ${config.prefix || '.'}${result.command}.`);
            } catch (error) {
                console.error('[STCKCMD] Error:', error?.stack || error);
                return bigboreply('❌ Failed to save that sticker command.');
            }
        }

        case 'setprefix': {
            try {
                const { setPrefix } = require('./lib/config-commands.js');
                await setPrefix(conn, m, args, bigboreply, isOwner, config);
            } catch (error) {
                console.error('[SETPREFIX] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to change the prefix.');
            }
            break;
        }

        case 'setgcpp': {
            try {
                const { setGroupPhoto } = require('./lib/config-commands.js');
                await setGroupPhoto(conn, m, args, bigboreply, isOwner, config);
            } catch (error) {
                console.error('[SETGCPP] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update the group photo.');
            }
            break;
        }

        case 'ss': {
            try {
                await saveStatus(conn, m, bigboreply);
            } catch (error) {
                console.error('[SS] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to retrieve that Status media.');
            }
            break;
        }

        case 'sss': {
            // Intentionally no reply/reaction/success message. Only media that
            // is actually available in the quoted Status is forwarded to the
            // paired account's private/self chat.
            try {
                await saveStatusSilent(conn, m);
            } catch (error) {
                console.error('[SSS] integration error:', error?.stack || error);
            }
            break;
        }

        case 'vv':
        case 'vv2': {
            if (!isCreator(m)) return command === 'vv2' ? undefined : bigboreply('❌ Creator only.');
            try {
                const { dispatchMedia } = require('./lib/protected-media.js');
                await dispatchMedia(conn, m, command, bigboreply);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] integration error:`, error?.stack || error);
                if (command === 'vv') return bigboreply('❌ Failed to retrieve that view-once message.');
            }
            break;
        }

        case 'conver': {
            try {
                const { dispatchMedia } = require('./lib/protected-media.js');
                await dispatchMedia(conn, m, command, bigboreply);
            } catch (error) {
                console.error('[CONVER] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to convert that sticker.');
            }
            break;
        }

        case 'contact': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const contactTools = require('./lib/contact-save.js');
            const first = String(args[0] || '').trim();
            const numberLike = /^[+]?\d[\d\s().-]*$/.test(first) || /^00\d+$/.test(first);
            let target = '';
            let text = '';

            if (args.length >= 2 && numberLike) {
                const number = contactTools.normalizeNumber(first);
                if (!contactTools.isNumber(number)) return bigboreply(`❌ Invalid number.\n\nUsage: ${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
                text = args.slice(1).join(' ').trim();
                try {
                    target = await contactTools.resolveUserJid(`${number}@s.whatsapp.net`, conn);
                } catch (error) {
                    console.error('[CONTACT] Number resolution failed:', error?.stack || error);
                    return bigboreply('❌ Could not validate that WhatsApp number.');
                }
            } else if (m.quoted?.sender) {
                text = args.join(' ').trim();
                try {
                    target = await contactTools.resolveUserJid(m.quoted.sender, conn);
                } catch (error) {
                    console.error('[CONTACT] Quoted sender resolution failed:', error?.stack || error);
                    return bigboreply('❌ Could not resolve the replied contact.');
                }
            } else {
                if (args.length >= 2 && !numberLike) return bigboreply(`❌ Invalid number.\n\nUsage: ${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
                return bigboreply(`Usage: ${config.prefix || '.'}contact <text> (reply to a user)\n${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
            }

            if (!text) return bigboreply(`Usage: ${config.prefix || '.'}contact <text> (reply to a user)\n${config.prefix || '.'}contact 2547XXXXXXXX <text>`);
            const targetNumber = contactTools.numberFromJid(target);
            const senderNumber = contactTools.normalizeNumber(m.sender);
            const selfNumber = contactTools.normalizeNumber(conn.user?.id);
            if (!target || !targetNumber || targetNumber === senderNumber || targetNumber === selfNumber) {
                return bigboreply('❌ Invalid contact target.');
            }
            try {
                await contactTools.sendContactText(conn, target, text);
                return bigboreply(`✅ Message sent to ${targetNumber}.`);
            } catch (error) {
                console.error('[CONTACT] Send failed:', error?.stack || error);
                return bigboreply('❌ Failed to send the contact message.');
            }
        }

        case 'save': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const contactTools = require('./lib/contact-save.js');
            const first = String(args[0] || '').trim();
            const numberLike = /^[+]?\d[\d\s().-]*$/.test(first) || /^00\d+$/.test(first);
            const explicit = args.length >= 2 && numberLike;
            let target = '';
            let name = '';

            if (explicit) {
                const number = contactTools.normalizeNumber(first);
                if (!contactTools.isNumber(number)) return bigboreply(`❌ Invalid number.\n\nUsage: ${config.prefix || '.'}save 2547XXXXXXXX <name>`);
                name = args.slice(1).join(' ').trim();
                try {
                    target = await contactTools.resolveUserJid(`${number}@s.whatsapp.net`, conn);
                } catch (error) {
                    console.error('[SAVE] Number resolution failed:', error?.stack || error);
                    return bigboreply('❌ Could not validate that WhatsApp number.');
                }
            } else if (m.quoted?.sender) {
                target = await contactTools.resolveUserJid(m.quoted.sender, conn).catch(error => {
                    console.error('[SAVE] Quoted sender resolution failed:', error?.stack || error);
                    return '';
                });
                name = args.join(' ').trim();
            } else if (!m.isGroup && /@s\.whatsapp\.net$/i.test(String(m.chat || ''))) {
                target = await contactTools.resolveUserJid(m.chat, conn).catch(error => {
                    console.error('[SAVE] DM participant resolution failed:', error?.stack || error);
                    return '';
                });
                name = args.join(' ').trim();
            } else {
                return bigboreply(`Usage: ${config.prefix || '.'}save <name> (reply to a user or use in their DM)\n${config.prefix || '.'}save 2547XXXXXXXX <name>`);
            }

            if (!name) return bigboreply(`Usage: ${config.prefix || '.'}save <name> (reply to a user or use in their DM)\n${config.prefix || '.'}save 2547XXXXXXXX <name>`);
            const targetNumber = contactTools.numberFromJid(target);
            const senderNumber = contactTools.normalizeNumber(m.sender);
            const selfNumber = contactTools.normalizeNumber(conn.user?.id);
            if (!target || !targetNumber || targetNumber === senderNumber || targetNumber === selfNumber) {
                return bigboreply('❌ Invalid contact target.');
            }
            try {
                const result = await contactTools.saveContact(conn, target, name);
                return bigboreply(`✅ Contact saved/updated in DARKNOTE.\nName: ${result.name}\nNumber: ${result.number}`);
            } catch (error) {
                console.error('[SAVE] Contact save failed:', error?.stack || error);
                return bigboreply('❌ Failed to save the contact.');
            }
        }

        case 'block':
        case 'unblock': {
            if (!isOwner(m)) return bigboreply('❌ Owner only!');
            let target;
            try {
                const contextInfo = m.message?.extendedTextMessage?.contextInfo || m.msg?.contextInfo || {};
                target = contextInfo.mentionedJid?.[0] || m.mentionedJid?.[0] || m.quoted?.sender;
                // In a private DM, a bare .block targets the current chat.
                // In a group, never guess a target.
                if (!target && !m.isGroup && m.chat && /@s\.whatsapp\.net$/i.test(String(m.chat))) target = m.chat;
                if (!target) {
                    const n = normalizeBlockNumber(args.join(' '));
                    if (!/^\d{8,15}$/.test(n)) {
                        return bigboreply(`❌ Reply to a user, mention a user, or provide a valid number.\n\nUsage: ${config.prefix || '.'}${command} 2547XXXXXXXX`);
                    }
                    if (typeof conn.onWhatsApp === 'function') {
                        const found = await conn.onWhatsApp(n);
                        const account = Array.isArray(found) ? found.find(x => x?.jid && (x.exists !== false)) : null;
                        if (account?.jid) target = account.jid;
                        else if (Array.isArray(found) && (found.length === 0 || found.every(x => x?.exists === false))) return bigboreply('❌ That number is not a valid WhatsApp account.');
                    }
                    if (!target) target = `${n}@s.whatsapp.net`;
                }
                target = conn.decodeJid ? conn.decodeJid(target) : target;
                // A LID target is perfectly usable on its own: the blocklist RPC
                // wants the LID. Adding the phone-number form is a bonus, so a
                // missing mapping must not abort the command (that produced
                // "Unable to resolve the target WhatsApp account" for LID targets).
                if (String(target || '').endsWith('@lid') && typeof conn.resolveLidEnhanced === 'function') {
                    try {
                        const mapped = await conn.resolveLidEnhanced(target);
                        if (mapped && /@s\.whatsapp\.net$/i.test(String(mapped))) {
                            target = conn.decodeJid ? conn.decodeJid(mapped) : mapped;
                        }
                    } catch (mappingError) {
                        console.error(`[${command.toUpperCase()}] LID -> PN mapping unavailable, continuing with the LID:`, mappingError?.message || mappingError);
                    }
                }
                target = conn.decodeJid ? conn.decodeJid(target) : target;
                if (!/@(s\.whatsapp\.net|lid)$/i.test(String(target || ''))) throw new Error('Unable to resolve the target WhatsApp account');
                // Only meaningful for a phone-number target: asking WhatsApp about
                // a LID's digits would return nothing useful.
                if (/@s\.whatsapp\.net$/i.test(String(target || '')) && typeof conn.onWhatsApp === 'function') {
                    try {
                        const resolved = await conn.onWhatsApp(getNumber(target));
                        if (Array.isArray(resolved) && resolved[0]?.jid) target = conn.decodeJid(resolved[0].jid);
                    } catch (resolutionError) {
                        console.error(`[${command.toUpperCase()}] WhatsApp number resolution fallback:`, resolutionError?.message || resolutionError);
                    }
                }
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Target resolution error:`, error?.stack || error);
                return bigboreply(`❌ ${sanitizeBlockError(error)}`);
            }

            const targetNumber = getNumber(target);
            const selfNumber = getNumber(conn.user?.id || '');
            const senderNumber = getNumber(m.sender || '');
            if (!targetNumber || targetNumber === selfNumber || targetNumber === senderNumber) {
                return bigboreply(`❌ You cannot ${command} the bot's own account or the command sender.`);
            }
            // Protected numbers come from config.json -> "protectedBlockJids",
            // never from a value hard-coded in this command.
            if (protectedBlockNumbers(conn).includes(targetNumber)) {
                console.error(`[${command.toUpperCase()}] refused: ${targetNumber} is protected`);
                return bigboreply('No, 🙂‍↕🙂‍↔');
            }

            try {
                const action = command === 'block' ? 'block' : 'unblock';

                // WhatsApp migrated accounts to LID addressing. The blocklist RPC
                // needs the target's LID (plus its phone-number JID when blocking),
                // which the installed Baileys build does not send, so the request
                // is issued directly through conn.query. See lib/block-status.js.
                const identity = await blockStatus.resolveIdentity(conn, target);
                if (!identity.pn && !identity.lid) throw new Error('Unable to resolve the target WhatsApp account');

                const label = identity.pn ? getNumber(identity.pn) : identity.lid.split('@')[0];
                const selfLid = String(conn.user?.lid || '').split(':')[0].toLowerCase();
                if (identity.lid && selfLid && identity.lid === selfLid) {
                    return bigboreply(`❌ You cannot ${command} the bot's own account or the command sender.`);
                }

                const beforeList = await blockStatus.readBlocklist(conn);
                const before = beforeList ? blockStatus.matches(beforeList, identity) : null;
                if (command === 'block' && before === true) return bigboreply(`ℹ️ ${label} is already blocked.`);
                if (command === 'unblock' && before === false) return bigboreply(`ℹ️ ${label} is not blocked.`);

                const applied = await blockStatus.setBlockStatus(conn, identity, action);
                if (!applied.ok) {
                    console.error(`[${command.toUpperCase()}] WhatsApp rejected the request: ${applied.code}${applied.serverCode ? ` (server code ${applied.serverCode})` : ''} — ${applied.reason || ''}`);
                    if (applied.code === 'NO_IDENTITY') {
                        return bigboreply(`❌ I could not find a WhatsApp identity for ${label}. Reply to one of their messages and try again.`);
                    }
                    // Without a LID the phone-number-only form is what WhatsApp
                    // now rejects, so point the owner at the reliable route.
                    const hint = identity.lid ? '' : `\n\nTip: reply to one of their messages with ${config.prefix || '.'}${command} so their LID can be resolved from the chat.`;
                    return bigboreply(`❌ WhatsApp refused to ${command} ${label}.\n\n${sanitizeBlockError({ message: applied.reason || applied.code }, targetNumber)}${hint}`);
                }

                // Confirm against the real blocklist rather than trusting the call.
                const afterList = await blockStatus.readBlocklist(conn);
                const after = afterList ? blockStatus.matches(afterList, identity) : null;
                if (after !== null && ((action === 'block' && !after) || (action === 'unblock' && after))) {
                    console.error(`[${command.toUpperCase()}] request accepted but the blocklist did not change for ${label}`);
                    return bigboreply(`⚠️ WhatsApp accepted the request but ${label} does not appear in the blocklist. Please check on your phone.`);
                }

                return bigboreply(action === 'block' ? `✅ Blocked ${label}` : `✅ Unblocked ${label}`);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to ${command} ${targetNumber || 'that number'}.\n\n${sanitizeBlockError(error, targetNumber)}`);
            }
        }

        case 'getpp':
        case 'steal': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            try {
                const { runProfileCommand } = require('./lib/profile-core.js');
                await runProfileCommand(conn, m, command, args, bigboreply, getNumber);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                if (command === 'getpp') return bigboreply('❌ Failed to retrieve that profile picture.');
            }
            break;
        }

        case 'pp': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            try {
                const { dispatchMedia } = require('./lib/protected-media.js');
                await dispatchMedia(conn, m, command, bigboreply);
            } catch (error) {
                console.error('[PP] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update the profile picture.');
            }
            break;
        }

        case 'approveall':
        case 'rejectall': {
            if (!m.isGroup) return bigboreply('❌ This command can only be used in groups.');
            if (!isGroupAdmin(await conn.groupMetadata(m.chat), m.sender)) return bigboreply(`❌ Only group admins can use ${config.prefix || '.'}${command}.`);
            try {
                const metadata = await conn.groupMetadata(m.chat);
                if (!isGroupAdmin(metadata, conn.user?.id || '')) return bigboreply('❌ DARKNOTE must be a group admin.');
                if (typeof conn.groupRequestParticipantsList !== 'function' || typeof conn.groupRequestParticipantsUpdate !== 'function') {
                    throw new Error('This Baileys build does not expose group request approval methods');
                }
                const requests = await conn.groupRequestParticipantsList(m.chat);
                const list = Array.isArray(requests) ? requests : (requests?.participants || []);
                const targets = list.map(p => p?.jid || p?.id || p).filter(Boolean);
                if (!targets.length) return bigboreply(command === 'approveall' ? 'ℹ️ No pending join requests.' : 'ℹ️ No pending join requests.');
                const action = command === 'approveall' ? 'approve' : 'reject';
                const result = await conn.groupRequestParticipantsUpdate(m.chat, targets, action);
                const accepted = Array.isArray(result) ? result.filter(x => x?.status === '200' || x?.status === 200).length : targets.length;
                return bigboreply(`✅ ${command === 'approveall' ? 'Approved' : 'Rejected'} ${accepted || targets.length} pending join request${targets.length === 1 ? '' : 's'}.`);
            } catch (error) {
                console.error(`[${command.toUpperCase()}] Error:`, error?.stack || error);
                return bigboreply(`❌ Failed to ${command === 'approveall' ? 'approve' : 'reject'} the pending join requests.`);
            }
            break;
        }

        /*
         * ANTI-FEATURE SUITE. All eight share ONE engine in lib/security.js and
         * ONE setting each, persisted to config.json. Every enforcement decision
         * re-reads the setting at the moment it would act, so switching a feature
         * off stops it immediately and it stays off across a restart.
         */
        case 'antidemote':
        case 'antikick':
        case 'antisticker':
        case 'antimedia':
        case 'antiadd':
        case 'antipromote':
        case 'antiviewonce':
        case 'antimentionstatus': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[args.length - 1] || '').toLowerCase();
            const feature = security.FEATURES[command];
            if (!feature) return bigboreply('❌ Unknown anti-feature.');
            if (!['on', 'off'].includes(mode)) {
                const current = security.getSettings()[command];
                return bigboreply(`*${feature.label}: ${current?.enabled ? 'ON' : 'OFF'}*\n\nUsage: ${config.prefix || '.'}${command} on|off\n\nEscalation: warn → delete → kick`);
            }
            security.setFeature(command, mode === 'on');
            return bigboreply(`✅ ${feature.label} is now ${mode === 'on' ? 'ON' : 'OFF'}`);
        }

        case 'antiall': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[args.length - 1] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) {
                const rows = security.describe().map(r => `${r.enabled ? '✅' : '▫️'} ${r.label}`);
                const e = security.getSettings().enforcement;
                return bigboreply(`*🛡️ ANTI-FEATURES*\n\n${rows.join('\n')}\n\nEscalation: warn ${e.warn ? 'ON' : 'OFF'} · delete ${e.delete ? 'ON' : 'OFF'} · kick ${e.kick ? 'ON' : 'OFF'}\n\nUsage: ${config.prefix || '.'}antiall on|off`);
            }
            const names = security.setAll(mode === 'on');
            return bigboreply(`✅ All ${names.length} anti-features are now ${mode === 'on' ? 'ON' : 'OFF'}.`);
        }

        case 'antienforce': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            const level = String(args[0] || '').toLowerCase();
            const mode = String(args[1] || '').toLowerCase();
            const e = security.getSettings().enforcement;
            if (!['warn', 'delete', 'kick'].includes(level) || !['on', 'off'].includes(mode)) {
                return bigboreply(`*Escalation*\nwarn ${e.warn ? 'ON' : 'OFF'} · delete ${e.delete ? 'ON' : 'OFF'} · kick ${e.kick ? 'ON' : 'OFF'}\n\nUsage: ${config.prefix || '.'}antienforce warn|delete|kick on|off`);
            }
            security.setEnforcement(level, mode === 'on');
            return bigboreply(`✅ ${level} enforcement is now ${mode === 'on' ? 'ON' : 'OFF'}.`);
        }

        case 'call': {
            if (!isOwner(m) && !isCreator(m)) return bigboreply('❌ Owner only.');
            /*
             * VERIFIED against the installed build: makeMessagesRecvSocket returns
             * offerCall and it is spread onto the socket, so genuine outbound 1:1
             * calling IS available. There is NO group-call API in this version, so
             * a group call is refused rather than faked with an audio message.
             */
            // Group first: that answer is about WhatsApp's protocol, so it is the
            // more useful message even if the call API were also missing.
            if (m.isGroup) {
                return bigboreply('❌ Outbound GROUP calls are not supported by this Baileys build.\n\nThe installed version exposes offerCall for a single JID only. No group-call API exists, so this is refused instead of faking a call with a voice note.');
            }
            if (typeof conn.offerCall !== 'function') {
                return bigboreply('❌ This Baileys build does not expose outbound calling.');
            }
            const target = m.quoted?.sender || (args[0] ? `${String(args[0]).replace(/[^0-9]/g, '')}@s.whatsapp.net` : m.chat);
            if (!target) return bigboreply(`Usage: send this in a DM, or quote the person with ${config.prefix || '.'}call`);
            try {
                await conn.offerCall(target);
                return bigboreply(`📞 Calling ${String(target).split('@')[0]}…`);
            } catch (error) {
                console.error('[CALL] failed:', error?.stack || error);
                return bigboreply('❌ The call could not be started.');
            }
        }

        case 'antidelete':
        case 'antidelete1': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const arg = String(args[0] || '').toLowerCase();
            const mode = arg === 'all' ? String(args[1] || '').toLowerCase() : arg;
            const settings = antidelete.getSettings(conn);
            const panel = [
                `1 · in-chat repost: ${settings.antidelete ? 'ON' : 'OFF'}`,
                `2 · self DM: ${settings.antidelete2 ? 'ON' : 'OFF'}`,
                `3 · custom number: ${settings.antidelete3 || 'not set'}`,
                `4 · archive group: ${settings.antidelete4 || 'not set'}`
            ].join('\n');

            if (arg === 'all') {
                if (!['on', 'off'].includes(mode)) {
                    return bigboreply(`*🧹 ANTIDELETE*\n\n${panel}\n\nUsage: ${config.prefix || '.'}antidelete all on|off`);
                }
                const after = antidelete.setAll(conn, mode === 'on');
                const note = mode === 'off'
                    ? '\n\nDestinations were cleared, so 3 and 4 must be configured again before they can be re-enabled. Nothing is recovered while OFF.'
                    : '';
                return bigboreply(`✅ All antidelete modes are now ${mode.toUpperCase()}.\n\n1 · in-chat: ${after.antidelete ? 'ON' : 'OFF'}\n2 · self DM: ${after.antidelete2 ? 'ON' : 'OFF'}${note}`);
            }

            if (!['on', 'off'].includes(mode)) {
                return bigboreply(`*🧹 ANTIDELETE*\n\n${panel}\n\nUsage: ${config.prefix || '.'}antidelete1 on|off\n       ${config.prefix || '.'}antidelete all on|off`);
            }
            antidelete.configure(conn, 'antidelete', mode === 'on');
            return bigboreply(`✅ Antidelete 1 (in-chat) is now ${mode.toUpperCase()}.`);
        }

        case 'antidelete4': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const raw = String(args[0] || '').trim();
            const mode = String(args[1] || '').toLowerCase();
            if (raw.toLowerCase() === 'off') {
                antidelete.disable4(conn);
                return bigboreply('✅ Antidelete4 is now OFF. Nothing will be archived.');
            }
            const usage = `*🧹 ANTIDELETE 4 (archive group)*\n\nCurrent: ${antidelete.getSettings(conn).antidelete4 || 'not set'}\n\nUsage: ${config.prefix || '.'}antidelete4 <grouplink> on\n       ${config.prefix || '.'}antidelete4 off\n\nDeleted messages are forwarded to that group SILENTLY - nothing is announced in the original chat.`;
            const link = raw.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/i);
            if (!link || mode !== 'on') return bigboreply(usage);
            if (typeof conn.groupGetInviteInfo !== 'function') {
                return bigboreply('❌ This Baileys build cannot resolve WhatsApp invite links.');
            }
            try {
                const info = await conn.groupGetInviteInfo(link[1]);
                const jid = info?.id || info?.jid;
                if (!jid) return bigboreply('❌ That invite link could not be resolved to a group.');
                // The bot must ALREADY be in the group, otherwise it cannot post
                // to it and the archive would silently fail at delivery time.
                try {
                    await conn.groupMetadata(jid);
                } catch (error) {
                    return bigboreply('❌ DARKNOTE is not a member of that group, so it cannot archive into it. Add the bot to that group first.');
                }
                antidelete.configure(conn, 'antidelete4', jid);
                return bigboreply('✅ Antidelete4 archive group set. Deleted messages will be forwarded there silently.');
            } catch (error) {
                console.error('[ANTIDELETE4] invite resolution failed:', error?.stack || error);
                return bigboreply('❌ That invite link could not be resolved. Check the link and try again.');
            }
        }

        case 'antidelete2': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const mode = String(args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) return bigboreply(`Usage: ${config.prefix || '.'}antidelete2 on|off\n\nCurrent: ${antidelete.getSettings(conn).antidelete2 ? 'ON' : 'OFF'}`);
            antidelete.configure(conn, 'antidelete2', mode === 'on');
            return bigboreply(`✅ Antidelete2 is now ${mode.toUpperCase()}.`);
        }

        case 'antidelete3': {
            if (!isOwner(m)) return bigboreply('❌ Owner only.');
            const raw = String(args[0] || '').trim();
            if (raw.toLowerCase() === 'off') {
                antidelete.disable3(conn);
                return bigboreply('✅ Antidelete3 is now OFF.');
            }
            const number = antidelete.normalizeNumber(raw);
            if (!/^\d{8,15}$/.test(number)) return bigboreply(`❌ Invalid destination number.\n\nUsage: ${config.prefix || '.'}antidelete3 2547XXXXXXXX`);
            if (number === antidelete.normalizeNumber(conn.user?.id)) return bigboreply('❌ The custom destination cannot be the paired DARKNOTE account. Use .antidelete2 for self-archive.');
            try {
                if (typeof conn.onWhatsApp === 'function') {
                    const found = await conn.onWhatsApp(number);
                    if (Array.isArray(found) && found.length && !found[0]?.jid) return bigboreply('❌ That number is not a valid WhatsApp account.');
                    if (Array.isArray(found) && found.length === 0) return bigboreply('❌ That number is not a valid WhatsApp account.');
                }
            } catch (error) {
                console.error('[ANTIDELETE3] destination validation failed:', error?.message || error);
                return bigboreply('❌ Could not validate that WhatsApp destination.');
            }
            antidelete.configure(conn, 'antidelete3', number);
            return bigboreply(`✅ Antidelete3 destination set to ${number}.`);
        }

        case 'anticall': {
            try {
                const { configure } = require('./lib/protected-anticall.js');
                await configure(args, bigboreply, isCreator, m);
            } catch (error) {
                console.error('[ANTICALL] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update AntiCall settings.');
            }
            break;
        }

        case 'antilink': {
            try {
                const { configureAntiLink } = require('./lib/protected-antilink.js');
                await configureAntiLink(conn, m, args, bigboreply);
            } catch (error) {
                console.error('[ANTILINK] integration error:', error?.stack || error);
                return bigboreply('❌ Failed to update AntiLink settings.');
            }
            break;
        }

        case 'vv2auto': {
            if (!isCreator(m)) return bigboreply('❌ Creator only.');
            const mode = String(args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(mode)) return bigboreply(`Usage: ${config.prefix || '.'}vv2auto on|off\n\nCurrent: ${config.vv2Auto ? 'ON' : 'OFF'}`);
            config.vv2Auto = mode === 'on';
            fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
            await bigboreply(`✅ VV2 automatic mode is now ${config.vv2Auto ? 'ON' : 'OFF'}.`);
            break;
        }

        case 'allmenu': {
            await conn.relayMessage(
        m.chat,
        {
            buttonsMessage: {
                locationMessage: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    name: 'DARKNOTE L2',
                    address: 'Bigbrother',
                    jpegThumbnail: thumb
                },
                contentText: menu.build(config, {
                    mode: config.mode === 'self' ? 'SELF' : 'PUBLIC',
                    number: String(m.sender).replace(/@.+/g, ''),
                    runtime: (() => {
                        const up = process.uptime()
                        return `${Math.floor(up / 86400)}H ${Math.floor((up % 86400) / 3600)}J ${Math.floor((up % 3600) / 60)}M ${Math.floor(up % 60)}D`
                    })()
                }).text,
                footerText: 'DARKNOTE L2 • Bigbrother',
                buttons: [
                    {
                        buttonId: 'menu',
                        buttonText: {
                            displayText: 'Back Menu'
                        },
                        type: 1
                    },
                    {
                        buttonId: 'owner',
                        buttonText: {
                            displayText: 'Owner Menu'
                        },
                        type: 1
                    }
                ],
                headerType: 6
            }
        },
        {
            quoted: m,
            messageId: conn.generateMessageTag()
        }
    )
    break
}

            case 'ytvideo': {
                const query = args.join(' ').trim();
                if (!query) return bigboreply(`❌ Please provide a search query.\n\nUsage: ${config.prefix || '.'}ytvideo <song, artist, or video name>`);
                if (query.length > 150) return bigboreply('❌ Your YouTube search query is too long.');

                if (isYouTubeUrl(query)) {
                    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
                    const key = ytVideoKey(m, requestId);
                    cleanupYtVideoSelections();
                    const metadata = await resolveYtVideoMetadata(query);
                    if (!metadata?.status) {
                        console.error('[YTVIDEO] Direct URL metadata failed:', metadata?.error || 'Unknown error');
                        return bigboreply('❌ I could not read that YouTube video. Please check the URL and try again.');
                    }
                    ytVideoSelections.set(key, {
                        createdAt: Date.now(), userJid: m.sender, chat: m.chat, requestId, query,
                        results: [{ videoId: metadata.videoId || extractYouTubeId(query), url: metadata.url || query, title: metadata.title, thumbnail: metadata.thumbnail, author: metadata.author, duration: metadata.duration, timestamp: formatVideoDuration(metadata.duration), views: metadata.views }]
                    });
                    const lockKey = `${key}:0`;
                    if (ytVideoLocks.has(lockKey)) return;
                    ytVideoLocks.add(lockKey);
                    try {
                        await processSelectedYtVideo(conn, m, ytVideoSelections.get(key).results[0]);
                    } finally {
                        ytVideoLocks.delete(lockKey);
                        ytVideoSelections.delete(key);
                    }
                    break;
                }

                await bigboreply('🔎 Searching YouTube...');
                try {
                    const search = await ytSearch(query);
                    const results = (search.videos || [])
                        .filter(v => v.videoId && v.url && v.thumbnail)
                        .slice(0, 3)
                        .map(v => ({
                            videoId: v.videoId,
                            url: v.url,
                            title: v.title || 'YouTube video',
                            thumbnail: v.thumbnail,
                            author: v.author?.name || 'YouTube',
                            timestamp: v.timestamp || formatVideoDuration(v.seconds),
                            duration: Number(v.seconds || 0),
                            views: v.views || 0
                        }));
                    if (!results.length) return bigboreply('❌ No YouTube videos were found for that search.');
                    await sendYtVideoCarousel(conn, m, results, query);
                } catch (error) {
                    console.error('[YTVIDEO] Search failed:', error?.stack || error);
                    await bigboreply('❌ Failed to search YouTube. Please try again.');
                }
                break;
            }

            case 'ytvideo_select': {
                const requestId = args[0];
                const index = Number(args[1]);
                if (!requestId || !Number.isInteger(index) || index < 0 || index > 2) return bigboreply('❌ Invalid video selection.');
                cleanupYtVideoSelections();
                const key = ytVideoKey(m, requestId);
                const session = ytVideoSelections.get(key);
                if (!session || session.userJid !== m.sender || session.chat !== m.chat) return bigboreply('❌ This video selection has expired or does not belong to you. Use .ytvideo again.');
                const selected = session.results?.[index];
                if (!selected) return bigboreply('❌ This video selection is no longer available. Use .ytvideo again.');
                const lockKey = `${key}:${index}`;
                if (ytVideoLocks.has(lockKey)) return bigboreply('⏳ This video is already being processed.');
                ytVideoLocks.add(lockKey);
                try {
                    await processSelectedYtVideo(conn, m, selected);
                } finally {
                    ytVideoLocks.delete(lockKey);
                    ytVideoSelections.delete(key);
                }
                break;
            }
            case 'song': {
                const query = args.join(' ').trim();
                if (!query) return bigboreply(`🎵 *YouTube Song Search*\n\nUsage: ${config.prefix || '.'}song <song name>`);
                if (query.length > 100) return bigboreply('❌ Search query is too long.');
                await bigboreply('🔎 Searching YouTube...');
                try {
                    const search = await ytSearch(query);
                    const results = (search.videos || [])
                        .filter(v => v.videoId && v.url && v.thumbnail)
                        .slice(0, 5)
                        .map(v => ({
                            videoId: v.videoId,
                            url: v.url,
                            title: v.title || 'YouTube song',
                            thumbnail: v.thumbnail,
                            author: v.author?.name || 'YouTube',
                            timestamp: v.timestamp || 'Unknown',
                            views: v.views || 0
                        }));
                    if (!results.length) return bigboreply('❌ No YouTube songs found.');
                    await sendSongCarousel(conn, m, results);
                } catch (e) {
                    console.error('song search error:', e);
                    await bigboreply('❌ Failed to search YouTube. Please try again.');
                }
                break;
            }

            case 'song_audio': {
                const token = args[0];
                const index = Number(args[1]);
                if (!token || !Number.isInteger(index) || index < 0 || index > 4) return bigboreply('❌ Invalid song selection.');
                cleanupSongSelections();
                const selected = songSelections.get(songKey(m, token));
                if (!selected?.results?.[index]) return bigboreply('❌ This song selection has expired. Use .song again.');
                const song = selected.results[index];
                await bigboreply(`⏳ Downloading audio...\n🎵 ${song.title}`);
                try {
                    const result = await ytdlAutoBuffer(song.url, 'audio');
                    if (!result?.status || !Buffer.isBuffer(result.buffer)) return bigboreply(`❌ Failed to download the audio.\n${result?.error || ''}`.trim());
                    await conn.sendMessage(m.chat, {
                        audio: result.buffer,
                        mimetype: result.mimetype || 'audio/mpeg',
                        fileName: `${(result.title || song.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 80)}.mp3`,
                        ptt: false
                    }, { quoted: m });
                } catch (e) {
                    console.error('song audio error:', e);
                    await bigboreply('❌ Failed to send the audio. Please try another result.');
                }
                break;
            }

            case 'igstalk':
            case 'ig': {
                try {
                    const { handleIgStalk } = require('./lib/instagram.js');
                    await handleIgStalk({ conn, m, reply: bigboreply, args });
                } catch (error) {
                    console.error('[IGSTALK] integration error:', error?.stack || error);
                    return bigboreply('❌ Instagram user information could not be retrieved.');
                }
                break;
            }

            case 'shazam': {
                // ".shazam <name>" searches by name; ".shazam" alone identifies
                // the replied audio/video with ACRCloud.
                const { handleShazam } = requireProtected('shazam');
                const query = args.join(' ').trim();
                await handleShazam({ conn, m, reply: bigboreply, cards, query });
                break;
            }

            case 'shazam_audio': {
                // AUDIO button: ask how to send it before downloading anything.
                // args = [resultIndex, sessionId].
                const { handleAudioChoiceMenu } = requireProtected('shazam');
                const index = Number(args[0]);
                const sessionId = String(args[1] || '');
                if (!Number.isInteger(index) || index < 1 || index > 5 || !/^[a-z0-9]+$/i.test(sessionId)) {
                    console.error(`[SHAZAM] rejected audio choice: index=${args[0]} session=${args[1]}`);
                    return bigboreply('❌ This Shazam result has expired. Run `.shazam` again.');
                }
                await handleAudioChoiceMenu({ conn, m, reply: bigboreply, cards, index, sessionId });
                break;
            }

            case 'shazam_play':
            case 'shazam_file':
            case 'shazam_video': {
                // Second-level choice (and VIDEO), via the existing button
                // dispatcher. args = [resultIndex, sessionId].
                const { handleSelection } = requireProtected('shazam');
                const kind = command === 'shazam_play' ? 'play' : command === 'shazam_file' ? 'file' : 'video';
                const index = Number(args[0]);
                const sessionId = String(args[1] || '');
                if (!Number.isInteger(index) || index < 1 || index > 5 || !/^[a-z0-9]+$/i.test(sessionId)) {
                    console.error(`[SHAZAM] rejected ${kind} selection: index=${args[0]} session=${args[1]}`);
                    return bigboreply('❌ This Shazam result has expired. Run `.shazam` again.');
                }
                await handleSelection({ conn, m, reply: bigboreply, kind, index, sessionId });
                break;
            }

            case 'owner':
            case 'cekowner': {
                const creator = isPrimaryCreator(m);
                const owner = isOwner(m);
                const status = creator ? '👑 You are the CREATOR' : owner ? '✅ You are an OWNER' : '❌ You are not an owner';
                // The creator is whichever number this bot is paired to.
                const paired = ownerSystem.pairedNumber(conn) || String(config.ownerNumber || '');
                const info = `Your JID: ${m.sender}\nCreator (paired number): ${paired}@s.whatsapp.net`;
                await bigboreply(`${status}\n\n${info}`);
                break;
            }

            case 'myjid':
                await bigboreply(`Your JID: ${m.sender}`);
                break;

            case 'ping': {
                const start = Date.now();
                const sent = await bigboreply('Measuring ping...');
                const latency = Date.now() - start;
                const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
                const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
                const uptimeHours = (os.uptime() / 3600).toFixed(2);
                const cpuModel = os.cpus()[0]?.model || 'Unknown';
                const cpuCores = os.cpus().length;
                const vpsText = `VPS DATA\n- Hostname: ${os.hostname()}\n- Platform: ${os.platform()} ${os.arch()}\n- Uptime: ${uptimeHours} hours\n- RAM: ${freeMem} GB / ${totalMem} GB (Free/Total)\n- CPU: ${cpuCores} Core, ${cpuModel.substring(0, 30)}`;
                await conn.sendMessage(m.chat, { text: `Pong! ${latency} ms\n\n${vpsText}`, edit: sent.key });
                break;
            }

            case 'info': {  
                await bigboreply(`MESSAGE INFO\n\nSender JID: ${m.sender}\nChat JID: ${m.chat}\nGroup: ${m.isGroup ? 'Yes' : 'No'}\nFrom Bot: ${m.fromMe ? 'Yes' : 'No'}\nMessage ID: ${m.id || '-'}\nText: ${m.text || '-'}`);
                break;
            }

            case 'darknote':
            case 'ai':
            case 'ask': {
                // `.ai on|off` is the DARKNOTE AI master switch. Every other use
                // of .ai, and all uses of .ask and .darknote, are ordinary
                // questions for the legacy AI chat command, which is untouched
                // below. Only the two toggle words are intercepted.
                if (command === 'ai' && ['on', 'off'].includes(String(args[0] || '').toLowerCase())) {
                    try {
                        const toggled = await aiService.runCommand(conn, m, 'ai', args, bigboreply, {
                            isOwner: isOwner(m),
                            mode: config.mode,
                            prefix: config.prefix
                        });
                        if (toggled) break;
                    } catch (error) {
                        console.error('[AI:toggle] failed:', error?.stack || error);
                        return bigboreply('❌ The AI toggle failed.');
                    }
                }
                try {
                    const aiResult = await aiChat.handleAiCommand(conn, m, args, bigboreply);
                    if (aiResult && aiResult.ok === false && aiResult.code === 'EXCEPTION') {
                        console.error('[AI] case-level failure:', aiResult.reason);
                    }
                } catch (error) {
                    console.error('[AI] failed:', error?.stack || error);
                    return bigboreply('❌ The AI chat failed. Please try again.');
                }
                break;
            }

            case 'aireset': {
                try {
                    await aiChat.handleAiReset(conn, m, bigboreply);
                } catch (error) {
                    console.error('[AIRESET] failed:', error?.stack || error);
                    return bigboreply('❌ Could not clear the AI memory for this session.');
                }
                break;
            }

            case 'aimem': {
                try {
                    await aiChat.handleAiMemory(conn, m, bigboreply);
                } catch (error) {
                    console.error('[AIMEM] failed:', error?.stack || error);
                    return bigboreply('❌ Could not read the AI memory for this session.');
                }
                break;
            }

            // DARKNOTE AI management. These are ordinary prefixed commands and
            // never auto-trigger; only conversation is prefix-free.
            //
            // Toggles: ai, aichat, aidm, aigroup, aityping, aireact, aimemory,
            // ailanguage, aitiming, aireply, aicombine, aiemoji, ainame
            // Future-module toggles: aiassistant, aimoderation, airewrite,
            // aitranslate, aifiles, aiweb, aivision, aiimage, aisticker,
            // aiimagesearch
            // Reports: aistatus, aicapabilities, aimodules, aihealth
            case 'aichat':
            case 'aidm':
            case 'aigroup':
            case 'aityping':
            case 'aireact':
            case 'ailanguage':
            case 'aitiming':
            case 'aireply':
            case 'aicombine':
            case 'aiemoji':
            case 'ainame':
            case 'aiassistant':
            case 'aimoderation':
            case 'airewrite':
            case 'aitranslate':
            case 'aifiles':
            case 'aiweb':
            case 'aivision':
            case 'aiimage':
            case 'aisticker':
            case 'aiimagesearch':
            case 'aicapabilities':
            case 'aimodules':
            case 'aihealth':
            case 'aisetup':
            case 'chatbotdelay':
            case 'replydelay':
            case 'statusview':
            case 'statuslike':
            case 'statusreact':
            case 'chatbot':
            case 'aiset':
            case 'aistatus':
            case 'aimemory':
            case 'aiforget': {
                try {
                    const handled = await aiService.runCommand(conn, m, command, args, bigboreply, {
                        isOwner: isOwner(m),
                        mode: config.mode,
                        prefix: config.prefix
                    });
                    if (!handled) return bigboreply('❌ That AI command is not available.');
                } catch (error) {
                    console.error(`[AI:${command}] failed:`, error?.stack || error);
                    return bigboreply('❌ That AI command failed.');
                }
                break;
            }

            case 'sticker':
            case 's': {
                if (!m.quoted && !args[0]) return bigboreply('Reply to an image/video or send a URL with .sticker <url>');
                let mediaBuffer;
                if (m.quoted && (m.quoted.mtype === 'imageMessage' || m.quoted.mtype === 'videoMessage')) {
                    mediaBuffer = await m.quoted.download();
                } else if (args[0] && args[0].match(/https?:\/\//)) {
                    const res = await fetch(args[0]);
                    mediaBuffer = Buffer.from(await res.arrayBuffer());
                } else return bigboreply('Unknown format. Reply to media or send a URL.');
                if (!mediaBuffer) return bigboreply('Failed to retrieve media.');
                const type = await fileTypeFromBuffer(mediaBuffer);
                if (!type || (!/image/.test(type.mime) && !/video/.test(type.mime))) return bigboreply('Only images or videos are supported.');
                await bigboreply('Creating sticker...');
                try {
                    const stickerBuffer = await writeExif(mediaBuffer, { packname: 'Sticker Bot', author: 'Bigbrother', cropToSquare: false });
                    await conn.sendMessage(m.chat, { sticker: stickerBuffer }, { quoted: m });
                } catch (err) {
                    console.error(err);
                    await bigboreply('Failed to create sticker: ' + err.message);
                }
                break;
            }

            /*
             * SMART IMAGE & STICKER RE-EDIT.
             *
             * All four names share ONE handler, so there is no way for two of
             * them to disagree or for one instruction to run twice. The media
             * kind is detected from the reply; output type follows the input
             * unless the user asked for a sticker explicitly.
             *
             * The whole pipeline lives in lib/image-edit.js - this case only
             * validates usage and reports the outcome.
             */
            case 'edit':
            case 'reedit':
            case 'editsticker':
            case 'editphoto': {
                const editPrefix = config.prefix || '.';
                const usage = [
                    '🎨 *SMART RE-EDIT*',
                    '',
                    `Reply to a photo or sticker, then describe the change:`,
                    `${editPrefix}edit make the background a beach`,
                    `${editPrefix}edit add sunglasses and a gold chain`,
                    `${editPrefix}edit badilisha background iwe beach`,
                    '',
                    `*Commands*`,
                    `${editPrefix}edit <instruction>  (photo or sticker)`,
                    `${editPrefix}reedit <instruction>`,
                    `${editPrefix}editphoto <instruction>  (reply to a photo)`,
                    `${editPrefix}editsticker <instruction>  (get a sticker back)`,
                    '',
                    `Add "make this a sticker" to get a sticker from a photo.`
                ].join('\n');

                const instruction = args.join(' ').trim();
                const quoteType = String(m.quoted?.mtype || '');
                const quotedIsMedia = /image|sticker/i.test(quoteType);

                // No replied media -> help, never a crash.
                if (!m.quoted || !quotedIsMedia) return bigboreply(usage);
                if (!instruction) {
                    return bigboreply(`Tell me what to change.\n\nExample: ${editPrefix}edit make it cinematic and dark`);
                }

                const forceOutput = command === 'editsticker' ? 'sticker'
                    : command === 'editphoto' ? 'image'
                        : '';

                try {
                    await bigboreply('🎨 Editing...');
                } catch (error) {
                    console.error('[EDIT] progress reply failed:', error?.message || error);
                }

                // reedit() never throws: it returns a result with a friendly
                // message, so a bad API day cannot take the dispatcher down.
                const editResult = await imageEdit.reedit(conn, m, instruction, { output: forceOutput });
                if (!editResult.ok) {
                    if (editResult.code === 'duplicate') break;   // already answering; stay silent
                    return bigboreply(`❌ ${editResult.message || imageEdit.FAILURES.generate_failed}`);
                }
                // The result itself was already sent as an image/sticker.
                break;
            }

            // Owner-only capability report for the re-edit backend.
            case 'editstatus': {
                if (!isOwner(m)) return bigboreply('❌ Owner only.');
                await imageEdit.probeCapabilities(true);
                return bigboreply(imageEdit.statusText());
            }

            case 'addowner': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply(`Usage: ${config.prefix || '.'}addowner 2547XXXXXXXX`);
                const result = ownerSystem.addOwner(target, config, conn);
                if (!result.ok) {
                    const messages = { invalid: '❌ Provide a valid WhatsApp number.', self: '❌ The bot account is already the paired session and does not need to be added as an owner.', primary: '❌ The primary creator is already an owner.', exists: 'ℹ️ That number is already an owner.' };
                    return bigboreply(messages[result.code] || '❌ Could not add that owner.');
                }
                return bigboreply(`✅ Owner added successfully\n${result.number}`);
            }

            case 'delowner': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply(`Usage: ${config.prefix || '.'}delowner 2547XXXXXXXX`);
                const result = ownerSystem.removeOwner(target, config, conn);
                if (!result.ok) {
                    const messages = { invalid: '❌ Provide a valid WhatsApp number.', primary: '❌ The primary creator cannot be removed.', missing: 'ℹ️ That number is not an added owner.' };
                    return bigboreply(messages[result.code] || '❌ Could not remove that owner.');
                }
                return bigboreply(`✅ Owner removed successfully\n${result.number}`);
            }

            case 'addprem': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply('Example: .addprem 628xxx');
                const premiumDB = readJSON(premiumPath);
                const num = getNumber(target);
                if (premiumDB.includes(num)) return bigboreply('Already premium');
                premiumDB.push(num);
                saveJSON(premiumPath, premiumDB);
                bigboreply(`Premium added successfully\n${num}`);
                break;
            }

            case 'delprem': {
                if (!isOwner(m)) return bigboreply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return bigboreply('Example: .delprem 628xxx');
                const premiumDB = readJSON(premiumPath);
                const num = getNumber(target);
                const filtered = premiumDB.filter(v => v !== num);
                saveJSON(premiumPath, filtered);
                bigboreply(`Premium removed successfully\n${num}`);
                break;
            }

            case 'eval': {
                if (!isCreator(m)) return bigboreply('Creator only');
                const code = args.join(' ');
                if (!code) return bigboreply('Example:\n.eval 1+1');
                await executeEval(code, conn, m);
                break;
            }
            
           case 'public': {
    if (!isOwner(m)) return bigboreply('Owner only')

    config.mode = 'public'
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2))

    bigboreply('Mode changed to public successfully')
}
           break

           case 'self': {
    if (!isOwner(m)) return bigboreply('Owner only')

    config.mode = 'self'
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2))

    bigboreply('Mode changed to self successfully')
}
           break
           
           
            default:
                break;
        }
    } catch (err) {
        console.error('Error in command handler:', err);
    }
};

module.exports.handleAutomaticViewOnce = handleAutomaticViewOnce;

// Status automation is kept in this existing dispatcher module so the bot still
// has one central message pipeline.
const statusQueues = new WeakMap();
function statusAutomationSettings() {
    config.statusAutomation = config.statusAutomation || {};
    if (!config.statusAutomation.avs) config.statusAutomation.avs = { enabled: false };
    if (!config.statusAutomation.als) config.statusAutomation.als = { enabled: false };
    if (!config.statusAutomation.ars) config.statusAutomation.ars = { enabled: false, emoji: '😊' };
    return config.statusAutomation;
}
async function performStatusAction(conn, item, type) {
    try {
        if (!item?.key || item.key.remoteJid !== 'status@broadcast') return;

        const digits = value => String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
        const self = digits(conn?.user?.id);
        const author = digits(item.key.participant || item.participant);
        // Never act on the paired account's own Status.
        if (self && author && self === author) return;

        if (type === 'avs') {
            if (typeof conn.readMessages !== 'function') {
                console.error('[AVS] this build does not expose readMessages');
                return;
            }
            await conn.readMessages([item.key]);
            console.log('[AVS] status marked as read');
            return;
        }

        const key = item.key.participant ? item.key : { ...item.key, participant: item.participant || undefined };
        const text = type === 'als' ? '❤️' : (statusAutomationSettings().ars.emoji || '😊');

        // Reacting to a Status needs the author on the key. Try the broadcast
        // route first, then address the author directly, so a build that rejects
        // one path still succeeds on the other.
        try {
            const options = key.participant ? { statusJidList: [key.participant] } : {};
            await conn.sendMessage('status@broadcast', { react: { text, key } }, options);
            console.log(`[${type.toUpperCase()}] reacted with ${text}`);
            return;
        } catch (error) {
            console.error(`[${type.toUpperCase()}] broadcast reaction failed, trying the author directly:`, error?.message || error);
        }

        if (!author) throw new Error('the status author could not be resolved');
        await conn.sendMessage(`${author}@s.whatsapp.net`, { react: { text, key } });
        console.log(`[${type.toUpperCase()}] reacted with ${text}`);
    } catch (error) {
        console.error(`[${type.toUpperCase()}] status action failed:`, error?.stack || error);
    }
}
function enqueueStatusAutomation(conn, item) {
    if (!item?.key || item.key.remoteJid !== 'status@broadcast') return;
    const settings = statusAutomationSettings();
    if (!settings.avs.enabled && !settings.als.enabled && !settings.ars.enabled) return;
    let state = statusQueues.get(conn);
    if (!state) { state = { seen: new Set(), queues: { avs: [], als: [], ars: [] }, running: false }; statusQueues.set(conn, state); }
    const key = `${item.key.remoteJid}:${item.key.participant || ''}:${item.key.id}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    if (state.seen.size > 1000) state.seen.delete(state.seen.values().next().value);
    /*
     * LIKE AND REACT ARE THE SAME PROTOCOL ACTION. WhatsApp has no separate
     * "like" for a status - a like IS a reaction, just always the heart. So when
     * both are switched on we send ONE reaction instead of two, with react
     * taking precedence because it carries the configured emoji. Sending both
     * would silently overwrite itself and look like nothing happened.
     */
    const reactEnabled = settings.ars?.enabled === true;
    const likeEnabled = settings.als?.enabled === true;
    if (settings.avs?.enabled === true) state.queues.avs.push(item);   // view is independent
    if (reactEnabled) state.queues.ars.push(item);
    else if (likeEnabled) state.queues.als.push(item);

    const planned = ['view', reactEnabled ? 'react' : (likeEnabled ? 'like' : null)].filter(Boolean).join(' + ');
    console.log(`[STATUS AUTOMATION] queued a status from ${String(item.key.participant || 'unknown')} -> ${planned}`);
    if (state.running) return;
    state.running = true;
    const run = async () => {
        while (state.queues.avs.length || state.queues.als.length || state.queues.ars.length) {
            const current = statusAutomationSettings();
            for (const type of ['avs', 'als', 'ars']) {
                if (!current[type].enabled || !state.queues[type].length) continue;
                const next = state.queues[type].shift();
                await performStatusAction(conn, next, type);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
        state.running = false;
    };
    void run().catch(error => { state.running = false; console.error('[STATUS AUTOMATION] queue failed:', error?.stack || error); });
}
module.exports.enqueueStatusAutomation = enqueueStatusAutomation;
module.exports.recordGroupActivity = groupFeatures.recordMessage;
module.exports.cachePresence = groupFeatures.cachePresence;
