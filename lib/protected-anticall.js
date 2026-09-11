'use strict'
const fs = require('fs')
const path = require('path')
const config = require('../config.json')
const D = (x) => Buffer.from(x,'hex').toString()
const A = Object.freeze({on:D('6f6e'),off:D('6f6666')})
function configure(args, reply, isCreator, m) {
  if (!isCreator(m)) return reply('❌ Creator only.')
  const v=String(args?.[0]||'').toLowerCase()
  if(v!==A.on&&v!==A.off) return reply(`Usage: ${config.prefix||'.'}anticall on|off\n\nCurrent: ${config.anticall?'ON':'OFF'}`)
  config.anticall=v===A.on
  fs.writeFileSync(path.join(__dirname,'..','config.json'),JSON.stringify(config,null,2))
  return reply(`✅ AntiCall is now ${config.anticall?'ON':'OFF'}.`)
}
module.exports={configure}
