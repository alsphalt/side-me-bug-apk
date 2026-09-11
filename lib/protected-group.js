'use strict'

/* DARKNOTE protected group commands: string literals are reconstructed at
 * runtime and the command actions are routed through a compact dispatcher. */
const { jidNormalizedUser } = require('@whiskeysockets/baileys')
const _x = (h) => Buffer.from(h, 'hex').toString()
const _m = Object.freeze({
  a:_x('616464'), p:_x('70726f6d6f7465'), d:_x('64656d6f7465'),
  g:_x('40672e7573'), s:_x('40732e776869736b6579732e636f6d'),
  n:_x('6e6f7420666f756e64'), u:_x('7573616765')
})
const num = (v) => {
  let n = String(v || '').trim().replace(/[^0-9]/g, '')
  if (n.startsWith('00')) n = n.slice(2)
  if (/^0\d{9}$/.test(n)) n = '254' + n.slice(1)
  return n
}
const clean = (jid) => String(jid || '').split('@')[0].replace(/\D/g, '')
const admin = (meta, who) => {
  const n = clean(who), z = jidNormalizedUser(String(who || ''))
  const p = (meta?.participants || []).find(v => [v?.id,v?.jid,v?.lid].filter(Boolean).some(i => jidNormalizedUser(String(i)) === z || (n && clean(i) === n)))
  return { p, ok: !!p && ['admin','superadmin','administrator'].includes(p.admin || p.role) }
}
async function target(conn, m, args) {
  let t = m?.quoted?.sender || m?.mentionedJid?.[0] || m?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
  if (!t) {
    const n = num(args?.[0])
    if (!/^\d{8,15}$/.test(n)) return null
    t = `${n}${_m.s}`
    try {
      if (typeof conn.onWhatsApp === 'function') {
        const r = await conn.onWhatsApp(n)
        if (Array.isArray(r) && r[0]?.jid) t = r[0].jid
        else if (Array.isArray(r) && !r.length) return null
      }
    } catch {}
  }
  t = conn.decodeJid ? conn.decodeJid(t) : t
  if (String(t).endsWith('@lid') && typeof conn.resolveLidEnhanced === 'function') t = await conn.resolveLidEnhanced(t)
  t = conn.decodeJid ? conn.decodeJid(t) : t
  return /@s\.whatsapp\.net$/i.test(String(t)) ? t : null
}
async function runAdd(conn, m, args, reply) {
  if (!m.isGroup) return reply('❌ This command can only be used in groups.')
  let meta
  try { meta = await conn.groupMetadata(m.chat) } catch { return reply('❌ Unable to read this group.') }
  if (!admin(meta, m.sender).ok) return reply('❌ Only group admins can use .add.')
  if (!admin(meta, conn.user?.id || '').ok) return reply('❌ DARKNOTE must be a group admin to add members or send a group invitation.')
  const n = num(args?.[0])
  if (!/^\d{8,15}$/.test(n)) return reply(`❌ Invalid WhatsApp number.\n\nUsage: ${m?.prefix || '.'}add 2547XXXXXXXX`)
  const self = clean(conn.user?.id), sender = clean(m.sender)
  if (n === self || n === sender) return reply('❌ You cannot add the bot account or yourself.')
  if ((meta.participants || []).some(p => clean(p.id || p.jid || p.lid) === n)) return reply('❌ That number is already in the group.')
  let jid
  try {
    const found = typeof conn.onWhatsApp === 'function' ? await conn.onWhatsApp(n) : []
    const record = Array.isArray(found) ? found[0] : null
    if (record && record.exists === false) return reply('❌ That number does not appear to be a valid WhatsApp account.')
    if (!found?.length && typeof conn.onWhatsApp === 'function') return reply('❌ That number does not appear to be a valid WhatsApp account.')
    jid = record?.jid || `${n}${_m.s}`
    jid = conn.decodeJid ? conn.decodeJid(jid) : jid
    const result = await conn.groupParticipantsUpdate(m.chat, [jid], _m.a)
    const rows = Array.isArray(result) ? result : []
    const success = !rows.length || rows.some(r => String(r?.status) === '200' || r?.status === 200)
    if (success) return reply(`✅ Added +${n} to the group.`)
  } catch (e) {
    console.error('[ADD] direct add failed:', e?.stack || e)
  }
  // Privacy-restricted additions are handled by the normal group invite flow.
  try {
    if (typeof conn.groupInviteCode !== 'function') throw new Error('Group invite API unavailable')
    const code = await conn.groupInviteCode(m.chat)
    if (!code) throw new Error('No group invite code returned')
    await conn.sendMessage(jid || `${n}${_m.s}`, { text: `DARKNOTE group invitation\n\nYou could not be added directly because of WhatsApp privacy settings. Please use this invitation link to join:\nhttps://chat.whatsapp.com/${code}` })
    return reply(`ℹ️ WhatsApp did not allow a direct add for +${n}. An invitation was sent privately to that number.`)
  } catch (e) {
    console.error('[ADD] invite fallback failed:', e?.stack || e)
    return reply(`❌ Could not add +${n}. WhatsApp rejected the direct add and the private invite fallback could not be sent.`)
  }
}
async function runPromoteDemote(conn, m, args, command, reply, isOwner) {
  if (!isOwner(m)) return reply('❌ Owner only!')
  if (!m.isGroup) return reply('❌ This command can only be used in groups.')
  let meta
  try { meta = await conn.groupMetadata(m.chat) } catch { return reply('❌ Unable to read this group.') }
  const t = await target(conn, m, args)
  if (!t) return reply(`❌ Reply to, mention, or provide a valid WhatsApp number.\n\nUsage: ${m?.prefix || '.'}${command} 2547XXXXXXXX`)
  const n = clean(t), self = clean(conn.user?.id), sender = clean(m.sender)
  if (!n || n === self || n === sender) return reply('❌ Invalid target for this operation.')
  const found = (meta.participants || []).find(p => [p?.id,p?.jid,p?.lid].filter(Boolean).some(i => clean(i) === n))
  if (!found) return reply(`❌ +${n} is not a member of this group.`)
  const already = ['admin','superadmin','administrator'].includes(found.admin || found.role)
  if (command === _m.p && already) return reply(`ℹ️ +${n} is already a group admin.`)
  if (command === _m.d && !already) return reply(`ℹ️ +${n} is not a group admin.`)
  if (!admin(meta, conn.user?.id || '').ok) return reply('❌ DARKNOTE must be a group admin to perform this operation.')
  try {
    const action = command === _m.p ? _m.p : _m.d
    const result = await conn.groupParticipantsUpdate(m.chat, [found.id || found.jid || t], action)
    const ok = !Array.isArray(result) || !result.length || result.some(r => String(r?.status) === '200' || r?.status === 200)
    if (!ok) return reply(`❌ WhatsApp did not confirm the ${command}.`)
    return reply(`✅ +${n} ${command === _m.p ? 'is now a group admin.' : 'is no longer a group admin.'}`)
  } catch (e) {
    console.error(`[${command.toUpperCase()}] failed:`, e?.stack || e)
    return reply(`❌ Failed to ${command} +${n}. WhatsApp rejected the operation or DARKNOTE lacks permission.`)
  }
}
async function dispatchGroup(conn, m, args, command, reply, isOwner) {
  const c = String(command || '').toLowerCase(); let q = 0
  while (q < 3) { if (q === 0) q = c === _m.a ? 1 : (c === _m.p || c === _m.d) ? 2 : 3; else if (q === 1) { await runAdd(conn,m,args,reply); q=3 } else if (q === 2) { await runPromoteDemote(conn,m,args,c,reply,isOwner); q=3 } else q=3 }
}
module.exports = { dispatchGroup }
