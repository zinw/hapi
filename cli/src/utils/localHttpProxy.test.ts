import { afterEach, expect, it } from 'vitest'
import net from 'node:net'
import { once } from 'node:events'
import {
    startLocalHttpProxy,
    startOrReuseLocalHttpProxy,
    shouldUseLocalHubTlsProxy,
    type LocalHttpProxy,
} from './localHttpProxy'

const proxies: LocalHttpProxy[] = []

afterEach(async () => {
    delete process.env.HAPI_DISABLE_LOCAL_TLS_PROXY
    delete process.env.HAPI_LOCAL_TLS_PROXY_NODE_BIN
    await Promise.all(proxies.splice(0).map(proxy => proxy.close()))
})

it('binds a local port and returns a 502 when the upstream is unreachable', async () => {
    // The proxy only forwards to https upstreams. A non-routable target will
    // surface as a 502 with the proxy error prefix, which is enough to
    // confirm the listener is up and the wire format is correct.
    const proxy = await startLocalHttpProxy('https://hapi.example.com')
    proxies.push(proxy)

    const response = await fetch(`${proxy.url}/hello?name=hapi`)
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).toMatch(/^proxy error:/)
})

it('accepts WebSocket upgrade attempts and closes with 502 on TLS failure', async () => {
    const proxy = await startLocalHttpProxy('https://hapi.example.com')
    proxies.push(proxy)
    const proxyUrl = new URL(proxy.url)

    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname)
    await once(socket, 'connect')

    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    socket.write(
        'GET /socket.io/?transport=websocket HTTP/1.1\r\n' +
        'Host: local-proxy\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n\r\n'
    )
    await once(socket, 'close')

    const text = Buffer.concat(chunks).toString('utf8')
    expect(text).toContain('502 Bad Gateway')
})

it('close() is idempotent after the child has already exited', async () => {
    const proxy = await startLocalHttpProxy('https://hapi.example.com')
    proxies.push(proxy)
    await proxy.close()
    await expect(proxy.close()).resolves.toBeUndefined()
})

it('rejects http:// targets to avoid silently downgrading to cleartext', async () => {
    await expect(startLocalHttpProxy('http://localhost:3006')).rejects.toThrow(/https:\/\//)
})

it('startOrReuseLocalHttpProxy returns the same promise for the same target', async () => {
    const first = startOrReuseLocalHttpProxy('https://hapi.example.com')
    const second = startOrReuseLocalHttpProxy('https://hapi.example.com')
    expect(second).toBe(first)
    const proxy = await first
    proxies.push(proxy)
})

it('shouldUseLocalHubTlsProxy respects the disable env var and only enables for https://', () => {
    expect(shouldUseLocalHubTlsProxy('http://localhost:3006')).toBe(false)
    expect(shouldUseLocalHubTlsProxy('not a url')).toBe(false)
    expect(shouldUseLocalHubTlsProxy('https://hapi.example.com')).toBe(true)

    process.env.HAPI_DISABLE_LOCAL_TLS_PROXY = '1'
    expect(shouldUseLocalHubTlsProxy('https://hapi.example.com')).toBe(false)
    process.env.HAPI_DISABLE_LOCAL_TLS_PROXY = 'true'
    expect(shouldUseLocalHubTlsProxy('https://hapi.example.com')).toBe(false)
    process.env.HAPI_DISABLE_LOCAL_TLS_PROXY = 'yes'
    expect(shouldUseLocalHubTlsProxy('https://hapi.example.com')).toBe(false)
    process.env.HAPI_DISABLE_LOCAL_TLS_PROXY = '0'
    expect(shouldUseLocalHubTlsProxy('https://hapi.example.com')).toBe(true)
})
