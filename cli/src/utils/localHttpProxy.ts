import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { logger } from '@/ui/logger'

export interface LocalHttpProxy {
    readonly url: string
    close(): Promise<void>
}

const START_TIMEOUT_MS = 10_000
const PROXY_LOG_PREFIX = '[HAPI TLS PROXY]'
const DISABLE_ENV = 'HAPI_DISABLE_LOCAL_TLS_PROXY'
const NODE_BIN_ENV = 'HAPI_LOCAL_TLS_PROXY_NODE_BIN'
const READY_PREFIX = 'HAPI_LOCAL_PROXY_READY '

// The proxy only ever forwards to HTTPS upstreams: callers gate on `https://`.
// We keep the script self-contained and only require the modules it actually uses.
const PROXY_SCRIPT = String.raw`
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { URL } = require('node:url');

const target = new URL(process.argv[1]);

const server = http.createServer((clientReq, clientRes) => {
  const upstreamReq = https.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    method: clientReq.method,
    path: clientReq.url || '/',
    headers: { ...clientReq.headers, host: target.host },
  }, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('error', (error) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    clientRes.end('proxy error: ' + (error && error.message ? error.message : 'upstream failure'));
  });

  clientReq.pipe(upstreamReq);
});

server.on('upgrade', (req, clientSocket, head) => {
  const upstreamSocket = tls.connect({
    host: target.hostname,
    port: Number(target.port || 443),
    servername: target.hostname,
  }, () => {
    let requestText = (req.method || 'GET') + ' ' + (req.url || '/') + ' HTTP/1.1\r\n';
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) requestText += name + ': ' + item + '\r\n';
        continue;
      }
      requestText += name + ': ' + value + '\r\n';
    }
    // Override Host on the upstream wire so vhost routing and SNI match the target.
    requestText = requestText.replace(/^host: .*$/im, 'host: ' + target.host);
    requestText += '\r\n';
    upstreamSocket.write(requestText);
    if (head && head.length > 0) upstreamSocket.write(head);

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  const destroyBoth = () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  upstreamSocket.on('error', () => {
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    destroyBoth();
  });

  clientSocket.on('error', destroyBoth);
  clientSocket.on('close', destroyBoth);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine local proxy port');
  }
  process.stdout.write('${READY_PREFIX}http://127.0.0.1:' + address.port + '\n');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
`

function isLocalProxyDisabled(): boolean {
    const raw = process.env[DISABLE_ENV]?.toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes'
}

function isHttpsUrl(url: string): boolean {
    try {
        return new URL(url).protocol === 'https:'
    } catch {
        return false
    }
}

export function shouldUseLocalHubTlsProxy(apiUrl: string): boolean {
    if (isLocalProxyDisabled()) return false
    return isHttpsUrl(apiUrl)
}

function waitForProxyReady(
    child: ChildProcessByStdio<null, Readable, Readable>,
    targetUrl: string,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let stdoutBuffer = ''
        let stderrBuffer = ''
        let settled = false

        const timeout = setTimeout(() => {
            finish(new Error(`Timed out after ${START_TIMEOUT_MS}ms starting local proxy for ${targetUrl}`))
        }, START_TIMEOUT_MS)

        const finish = (result: Error | string) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            child.stdout.off('data', onStdout)
            child.stderr.off('data', onStderr)
            child.off('error', onError)
            child.off('exit', onExit)
            if (typeof result === 'string') {
                resolve(result)
                return
            }
            reject(result)
        }

        const onStdout = (chunk: Buffer | string) => {
            stdoutBuffer += chunk.toString()
            const lines = stdoutBuffer.split('\n')
            stdoutBuffer = lines.pop() ?? ''
            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed) continue
                if (trimmed.startsWith(READY_PREFIX)) {
                    finish(trimmed.slice(READY_PREFIX.length).trim())
                    return
                }
                logger.debug(`${PROXY_LOG_PREFIX} ${trimmed}`)
            }
        }

        const onStderr = (chunk: Buffer | string) => {
            const text = chunk.toString().trim()
            if (!text) return
            stderrBuffer += `${text}\n`
            logger.debug(`${PROXY_LOG_PREFIX} ${text}`)
        }

        const onError = (error: Error) => finish(error)

        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            const details = stderrBuffer.trim() || stdoutBuffer.trim()
            const suffix = details ? `: ${details}` : ''
            finish(new Error(`Local proxy exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${suffix}`))
        }

        child.stdout.on('data', onStdout)
        child.stderr.on('data', onStderr)
        child.once('error', onError)
        child.once('exit', onExit)
    })
}

export async function startLocalHttpProxy(targetBaseUrl: string): Promise<LocalHttpProxy> {
    if (!isHttpsUrl(targetBaseUrl)) {
        throw new Error(`startLocalHttpProxy requires an https:// target, got: ${targetBaseUrl}`)
    }

    const nodeBin = process.env[NODE_BIN_ENV] || process.env.HAPI_NODE_EXECUTABLE || 'node'
    logger.debug(`${PROXY_LOG_PREFIX} Starting local proxy for ${targetBaseUrl}`)

    const child = spawn(nodeBin, ['-e', PROXY_SCRIPT, targetBaseUrl], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.unref()

    const url = await waitForProxyReady(child, targetBaseUrl)
    logger.debug(`${PROXY_LOG_PREFIX} Using local proxy ${url} for ${targetBaseUrl}`)

    return {
        url,
        close: async () => {
            if (child.exitCode !== null || child.signalCode !== null) {
                return
            }
            try {
                child.kill('SIGTERM')
            } catch {
                // already gone
            }
            await once(child, 'exit')
            logger.debug(`${PROXY_LOG_PREFIX} Local proxy closed`)
        },
    }
}

// Process-wide singleton: spawn the proxy at most once per target URL.
// Re-entry returns the existing instance so the same process never spawns two
// proxies pointing at the same hub.
const cached = new Map<string, Promise<LocalHttpProxy>>()

export function startOrReuseLocalHttpProxy(targetBaseUrl: string): Promise<LocalHttpProxy> {
    const existing = cached.get(targetBaseUrl)
    if (existing) return existing
    const fresh = startLocalHttpProxy(targetBaseUrl)
    cached.set(targetBaseUrl, fresh)
    fresh.catch(() => cached.delete(targetBaseUrl))
    return fresh
}
