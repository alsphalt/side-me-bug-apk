const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const webp = require('node-webpmux')
const sharp = require('sharp')
const { fileTypeFromBuffer } = require('file-type')

const tmpdir = os.tmpdir()
const randomName = (ext) => path.join(tmpdir, `${crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.${ext}`)

function runFfmpeg(input, output, vf) {
  const candidates = []
  try {
    const staticPath = require('ffmpeg-static')
    if (staticPath && fs.existsSync(staticPath)) candidates.push(staticPath)
  } catch (e) {
    console.error('[STICKER] ffmpeg-static unavailable:', e?.message || e)
  }
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  candidates.push('ffmpeg')

  return new Promise((resolve, reject) => {
    let index = 0
    const attempt = () => {
      const bin = candidates[index++]
      if (!bin) return reject(new Error('FFmpeg is not installed or its binary is unavailable. Install/approve ffmpeg-static or provide FFMPEG_PATH.'))
      const args = [
        '-y', '-i', input,
        '-vf', vf,
        '-vcodec', 'libwebp',
        '-quality', '90',
        '-preset', 'default',
        '-loop', '0',
        '-an',
        output
      ]
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d.toString() })
      child.once('error', err => {
        if (err.code === 'ENOENT') return attempt()
        reject(err)
      })
      child.once('exit', code => {
        if (code === 0) return resolve()
        reject(new Error((stderr || `FFmpeg exited with code ${code}`).slice(-500)))
      })
    }
    attempt()
  })
}

async function imageToWebp(media, cropToSquare = false) {
  const image = sharp(media).rotate()
  const pipeline = cropToSquare
    ? image.resize(320, 320, { fit: 'cover', position: 'centre' })
    : image.resize(320, 320, { fit: 'inside', withoutEnlargement: true })
  return pipeline.webp({ quality: 90 }).toBuffer()
}

async function videoToWebp(media, cropToSquare = false) {
  const tmpIn = randomName('mp4')
  const tmpOut = randomName('webp')
  try {
    fs.writeFileSync(tmpIn, media)
    const vf = cropToSquare
      ? 'crop=min(iw,ih):min(iw,ih),scale=320:320'
      : 'scale=320:320:force_original_aspect_ratio=decrease'
    await runFfmpeg(tmpIn, tmpOut, vf)
    return fs.readFileSync(tmpOut)
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
  }
}

async function writeExif(media, data = {}) {
  const type = await fileTypeFromBuffer(media)
  if (!type?.mime) throw new Error('Unable to detect media format')
  const cropToSquare = data.cropToSquare === true

  let webpMedia
  if (/webp/.test(type.mime)) webpMedia = media
  else if (/image/.test(type.mime)) webpMedia = await imageToWebp(media, cropToSquare)
  else if (/video/.test(type.mime)) webpMedia = await videoToWebp(media, cropToSquare)
  else throw new Error('Unsupported format. Use an image or video.')

  const tmpIn = randomName('webp')
  const tmpOut = randomName('webp')
  try {
    fs.writeFileSync(tmpIn, webpMedia)
    const img = new webp.Image()
    await img.load(tmpIn)

    const json = {
      'sticker-pack-id': data.packid || 'darknote-pack',
      'sticker-pack-name': data.packname || 'DARKNOTE L2',
      'sticker-pack-publisher': data.author || 'Bigbrother',
      'emojis': data.categories || ['']
    }
    const exifAttr = Buffer.from([
      0x49, 0x49, 0x2A, 0x00,
      0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x41, 0x57,
      0x07, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x16, 0x00,
      0x00, 0x00
    ])
    const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8')
    const exif = Buffer.concat([exifAttr, jsonBuff])
    exif.writeUIntLE(jsonBuff.length, 14, 4)
    img.exif = exif
    await img.save(tmpOut)
    return fs.readFileSync(tmpOut)
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
  }
}



async function stickerToImage(media) {
  return sharp(media).png().toBuffer()
}

function runFfmpegVideo(input, output) {
  const candidates = []
  try {
    const staticPath = require('ffmpeg-static')
    if (staticPath && fs.existsSync(staticPath)) candidates.push(staticPath)
  } catch (e) {
    console.error('[CONVER] ffmpeg-static unavailable:', e?.message || e)
  }
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  candidates.push('ffmpeg')
  return new Promise((resolve, reject) => {
    let index = 0
    const attempt = () => {
      const bin = candidates[index++]
      if (!bin) return reject(new Error('FFmpeg is not installed or its binary is unavailable'))
      const args = [
        '-y', '-i', input,
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-preset', 'veryfast', '-crf', '23', output
      ]
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d.toString() })
      child.once('error', err => {
        if (err.code === 'ENOENT') return attempt()
        reject(err)
      })
      child.once('exit', code => {
        if (code === 0) return resolve()
        reject(new Error((stderr || `FFmpeg exited with code ${code}`).slice(-500)))
      })
    }
    attempt()
  })
}

async function stickerToVideo(media) {
  const tmpIn = randomName('webp')
  const tmpOut = randomName('mp4')
  try {
    fs.writeFileSync(tmpIn, media)
    await runFfmpegVideo(tmpIn, tmpOut)
    return fs.readFileSync(tmpOut)
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
  }
}

module.exports = { imageToWebp, videoToWebp, writeExif , stickerToImage, stickerToVideo }
