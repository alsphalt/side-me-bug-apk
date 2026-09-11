'use strict'

/*
 * The YouTube downloader's write stream used to leak 'error' listeners.
 *
 * It attached `writer.once('error', reject)` inside the per-chunk loop, so every
 * backpressure event added another listener that was never removed, and the
 * final end() wait added one more that stayed for the life of the stream. The
 * only symptom was a console warning during a large download:
 *
 *   MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
 *   11 error listeners added to [WriteStream]. MaxListeners is 10.
 *
 * This drives the real downloadToFile() against a local server that streams in
 * chunks big enough to force backpressure on every write, and asserts the
 * warning never appears.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const { downloadToFile } = require('../lib/ytdl.source')

module.exports = async function ytdlStreamSuite({ section, ok, eq }) {
    section('lib/ytdl.source -- the download write stream does not leak listeners')

    /*
     * 128 KB per chunk against a 16-64 KB highWaterMark: write() returns false on
     * essentially every chunk, so each one exercises the backpressure path that
     * used to attach a listener. 60 chunks is comfortably past Node's limit of
     * 10, so the old code would have warned here.
     */
    const CHUNK = 128 * 1024
    const CHUNKS = 60
    const payload = Buffer.alloc(CHUNK * CHUNKS, 7)

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.length) })
        let sent = 0
        const pump = () => {
            if (sent >= payload.length) return res.end()
            const slice = payload.subarray(sent, sent + CHUNK)
            sent += slice.length
            res.write(slice, () => setTimeout(pump, 1))
        }
        pump()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/video.mp4`

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dn-ytdl-'))
    const destination = path.join(dir, 'out.mp4')

    const warnings = []
    const onWarning = warning => warnings.push(warning)
    process.on('warning', onWarning)

    try {
        const result = await downloadToFile(url, destination)

        ok('the download succeeds', result.status === true, JSON.stringify(result))
        eq('it reports the full payload size', result.size, payload.length)

        const stat = await fs.promises.stat(destination).catch(() => null)
        ok('the destination file exists', Boolean(stat))
        eq('the file on disk has the full payload', stat ? stat.size : -1, payload.length)

        // Node emits warnings on a later tick, so let them arrive.
        await new Promise(resolve => setTimeout(resolve, 150))

        const leaks = warnings.filter(warning => /MaxListenersExceededWarning/.test(String(warning?.message || warning?.name || '')))
        eq('no MaxListenersExceededWarning is emitted', leaks.length, 0)
        eq('no other warning is emitted either', warnings.length, 0)
    } finally {
        process.removeListener('warning', onWarning)
        server.close()
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { })
    }
}
