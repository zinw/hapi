import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import type { Readable } from 'node:stream'

export interface LocalHttpProxy {
    readonly url: string
    close(): Promise<void>
}

const PROXY_SCRIPT = String.raw`
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')

const targetBase = new URL(process.argv[1])

function requestModule(protocol) {
  return protocol === 'https:' ? https : http
}

function upstreamPort(url) {
  if (url.port) return Number.parseInt(url.port, 10)
  return url.protocol === 'https:' ? 443 : 80
}

function writeUpgradeRequest(req, target, upstream) {
  const headers = [...req.rawHeaders]
  for (let i = 0; i < headers.length; i += 2) {
    if (headers[i] && headers[i].toLowerCase() === 'host') {
      headers[i + 1] = target.host
    }
  }

  upstream.write((req.method || 'GET') + ' ' + target.pathname + target.search + ' HTTP/' + req.httpVersion + '\r\n')
  for (let i = 0; i < headers.length; i += 2) {
    upstream.write(headers[i] + ': ' + headers[i + 1] + '\r\n')
  }
  upstream.write('\r\n')
}

const server = http.createServer((clientReq, clientRes) => {
  const target = new URL(clientReq.url || '/', targetBase)
  const proxyReq = requestModule(target.protocol).request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: upstreamPort(target),
    method: clientReq.method,
    path: target.pathname + target.search,
    headers: {
      ...clientReq.headers,
      host: target.host
    }
  }, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
    proxyRes.pipe(clientRes)
  })

  proxyReq.on('error', (error) => {
    if (clientRes.headersSent) {
      clientRes.destroy(error)
      return
    }
    clientRes.writeHead(502)
    clientRes.end(error && error.message ? error.message : 'Proxy request failed')
  })

  clientReq.pipe(proxyReq)
})

server.on('upgrade', (req, clientSocket, head) => {
  const target = new URL(req.url || '/', targetBase)
  const port = upstreamPort(target)
  const upstream = target.protocol === 'https:'
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect(port, target.hostname)
  const readyEvent = target.protocol === 'https:' ? 'secureConnect' : 'connect'

  upstream.on(readyEvent, () => {
    writeUpgradeRequest(req, target, upstream)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  upstream.on('error', () => {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })

  clientSocket.on('error', () => {
    upstream.destroy()
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + address.port }) + '\n')
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
`

function parseProxyStartupLine(line: string): string | null {
    try {
        const parsed = JSON.parse(line) as unknown
        if (!parsed || typeof parsed !== 'object') return null
        const url = (parsed as { url?: unknown }).url
        return typeof url === 'string' ? url : null
    } catch {
        return null
    }
}

async function waitForProxyUrl(child: ChildProcessByStdio<null, Readable, Readable>): Promise<string> {
    let stdout = ''
    let stderr = ''

    return await new Promise<string>((resolve, reject) => {
        const cleanup = () => {
            child.stdout.off('data', onStdout)
            child.stderr.off('data', onStderr)
            child.off('error', onError)
            child.off('exit', onExit)
        }

        const onStdout = (chunk: Buffer) => {
            stdout += chunk.toString('utf8')
            const newlineIndex = stdout.indexOf('\n')
            if (newlineIndex === -1) return

            const line = stdout.slice(0, newlineIndex)
            const url = parseProxyStartupLine(line)
            if (!url) {
                cleanup()
                reject(new Error(`Invalid local proxy startup response: ${line}`))
                return
            }
            cleanup()
            resolve(url)
        }

        const onStderr = (chunk: Buffer) => {
            stderr += chunk.toString('utf8')
        }

        const onError = (error: Error) => {
            cleanup()
            reject(error)
        }

        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            reject(new Error(`Local proxy exited before startup (code=${code ?? 'null'}, signal=${signal ?? 'null'}): ${stderr.trim()}`))
        }

        child.stdout.on('data', onStdout)
        child.stderr.on('data', onStderr)
        child.on('error', onError)
        child.on('exit', onExit)
    })
}

export async function startLocalHttpProxy(targetBaseUrl: string): Promise<LocalHttpProxy> {
    const child = spawn(process.env.HAPI_NODE_EXECUTABLE || 'node', ['-e', PROXY_SCRIPT, targetBaseUrl], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    child.unref()
    const url = await waitForProxyUrl(child)
    ;(child.stdout as Readable & { unref?: () => void }).unref?.()
    ;(child.stderr as Readable & { unref?: () => void }).unref?.()

    return {
        url,
        close: async () => {
            if (child.exitCode !== null || child.signalCode !== null) {
                return
            }
            child.kill('SIGTERM')
            await once(child, 'exit')
        }
    }
}
