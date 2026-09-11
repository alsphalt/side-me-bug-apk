'use strict'

/* DARKNOTE protected Status media implementation.
 * String literals are reconstructed from hexadecimal data and the execution
 * paths use compact state dispatch. This is JavaScript source obfuscation, not
 * cryptographic secrecy. The public helper API is unchanged. */
const { downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys')

const d = h => Buffer.from(h, 'hex').toString('utf8')
const K = Object.freeze({
  i:d('696d6167654d657373616765'), v:d('766964656f4d657373616765'),
  s:d('7374617475734062726f616463617374'), r:d('7265706c79'),
  x:d('71756f7465644d657373616765'), c:d('636f6e74657874496e666f'),
  m:d('6d7367'), q:d('71756f746564'), t:d('7374617475734a6964'),
  p:d('7061727469636970616e74'), e:d('65787069726564'),
  f:d('4661696c656420746f207265747269657665207468617420537461747573206d656469612e205768617473417070206d6179206e6f206c6f6e676572206d616b6520697420617661696c61626c652e'),
  u:d('5265706c7920746f20616e2061636365737369626c652057686174734170702053746174757320696d616765206f7220766964656f2077697468'),
  n:d('537461747573206d6564696120646f776e6c6f61642072657475726e6564206e6f2064617461'),
  z:d('506169726564206163636f756e742064657374696e6174696f6e20756e617661696c61626c65'),
  a:d('696d616765'), b:d('766964656f'),
  j:d('696d6167652f6a706567'), w:d('766964656f2f6d7034')
})

function ci(m) { return m?.msg?.contextInfo || m?.message?.extendedTextMessage?.contextInfo || m?.message?.imageMessage?.contextInfo || m?.message?.videoMessage?.contextInfo || m?.message?.documentMessage?.contextInfo || m?.message?.stickerMessage?.contextInfo || {} }

function uw(v) {
  let x = v
  for (let i=0; i<6 && x; i++) {
    if (x[K.i]) return { type:K.i, media:x[K.i] }
    if (x[K.v]) return { type:K.v, media:x[K.v] }
    if (x.viewOnceMessageV2?.message) { x=x.viewOnceMessageV2.message; continue }
    if (x.viewOnceMessage?.message) { x=x.viewOnceMessage.message; continue }
    if (x.ephemeralMessage?.message) { x=x.ephemeralMessage.message; continue }
    if (x.documentWithCaptionMessage?.message) { x=x.documentWithCaptionMessage.message; continue }
    break
  }
  return null
}

function gs(m) {
  const c = ci(m), raw = c[K.x]
  const q = uw(raw) || (() => {
    const x=m?.quoted
    if (!x) return null
    if (x.mtype===K.i) return { type:K.i, media:x }
    if (x.mtype===K.v) return { type:K.v, media:x }
    return uw(x)
  })()
  if (!q) return null
  const qr = String(m?.quoted?.chat || c.remoteJid || '')
  const ok = qr===K.s || String(c.remoteJid || '')===K.s || String(m?.quoted?.statusJid || '')===K.s
  return ok ? { ...q, statusOwner:m?.quoted?.sender || c[K.p] || null } : null
}

async function db(media,type) {
  const stream = await downloadContentFromMessage(media, type.replace('Message','').toLowerCase())
  const a=[]
  for await (const x of stream) a.push(x)
  const b=Buffer.concat(a)
  if (!b.length) throw new Error(K.n)
  return b
}

function isNativeStatusSave(m) { return !!gs(m) }

async function saveStatus(conn,m,reply) {
  const q=gs(m)
  if (!q) return reply(`${K.u} ${m?.prefix || '.'}ss.`)
  let state=0, data
  try {
    while (state!==3) {
      if (state===0) { data=await db(q.media,q.type); state=1; continue }
      if (state===1) {
        if (q.type===K.i) await conn.sendMessage(m.chat,{image:data,mimetype:q.media.mimetype||K.j,caption:q.media.caption||undefined},{quoted:m})
        else await conn.sendMessage(m.chat,{video:data,mimetype:q.media.mimetype||K.w,caption:q.media.caption||undefined},{quoted:m})
        state=3; continue
      }
      state=3
    }
    return true
  } catch (e) {
    console.error('[SS] status save failed:',e?.stack||e)
    return reply(K.f)
  }
}

async function saveStatusSilent(conn,m) {
  const q=gs(m)
  if (!q) return false
  try {
    const data=await db(q.media,q.type)
    const dest=jidNormalizedUser(conn.user?.id||'')
    if (!dest) throw new Error(K.z)
    if (q.type===K.i) await conn.sendMessage(dest,{image:data,mimetype:q.media.mimetype||K.j,caption:q.media.caption||undefined})
    else await conn.sendMessage(dest,{video:data,mimetype:q.media.mimetype||K.w,caption:q.media.caption||undefined})
    return true
  } catch (e) {
    console.error('[SSS] silent status save failed:',e?.stack||e)
    return false
  }
}

module.exports={ getQuotedStatus:gs, isNativeStatusSave, saveStatus, saveStatusSilent }
