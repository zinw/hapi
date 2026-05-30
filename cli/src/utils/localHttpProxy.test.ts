import { afterEach, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { startLocalHttpProxy, type LocalHttpProxy } from './localHttpProxy'

const proxies: LocalHttpProxy[] = []
const servers: http.Server[] = []

afterEach(async () => {
    await Promise.all(proxies.splice(0).map(proxy => proxy.close()))
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startTargetServer(handler: http.RequestListener): Promise<{ url: string }> {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const address = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${address.port}` }
}

it('forwards HTTP requests to the configured target', async () => {
    const target = await startTargetServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, url: req.url, header: req.headers['x-test'] }))
    })
    const proxy = await startLocalHttpProxy(target.url)
    proxies.push(proxy)

    const response = await fetch(`${proxy.url}/hello?name=hapi`, {
        headers: { 'x-test': 'ok' }
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ method: 'GET', url: '/hello?name=hapi', header: 'ok' })
})

it('forwards WebSocket upgrade requests to the configured target', async () => {
    const target = await startTargetServer((_, res) => {
        res.writeHead(404)
        res.end()
    })
    const targetServer = servers[servers.length - 1]
    targetServer.on('upgrade', (req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
        socket.end(`target:${req.url}`)
    })

    const proxy = await startLocalHttpProxy(target.url)
    proxies.push(proxy)
    const proxyUrl = new URL(proxy.url)

    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname)
    await once(socket, 'connect')

    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    socket.write('GET /socket.io/?transport=websocket HTTP/1.1\r\nHost: local-proxy\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    await once(socket, 'close')

    const text = Buffer.concat(chunks).toString('utf8')
    expect(text).toContain('101 Switching Protocols')
    expect(text).toContain('target:/socket.io/?transport=websocket')
})
