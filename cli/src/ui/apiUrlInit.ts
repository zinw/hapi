/**
 * API URL initialization module
 *
 * Handles HAPI_API_URL initialization with priority:
 * 1. Environment variable (highest - allows temporary override)
 * 2. Settings file (~/.hapi/settings.json)
 * 3. Default value (http://localhost:3006)
 *
 * When running as a Bun-compiled binary against an https:// hub, spawns a
 * local Node.js HTTP->HTTPS proxy to work around Bun's broken TLS cert
 * verification on macOS (Let's Encrypt R12 chain).
 */

import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { isBunCompiled } from '@/projectPath'
import { startOrReuseLocalHttpProxy, shouldUseLocalHubTlsProxy, type LocalHttpProxy } from '@/utils/localHttpProxy'

/**
 * Initialize API URL
 * Must be called before any API operations
 */
export async function initializeApiUrl(): Promise<void> {
    // 1. Environment variable has highest priority (allows temporary override)
    if (process.env.HAPI_API_URL) {
        configuration._setApiUrl(process.env.HAPI_API_URL)
        await maybeStartLocalProxyForHttpsApiUrl(process.env.HAPI_API_URL)
        return
    }

    // 2. Read from settings file (new name first, then legacy)
    const settings = await readSettings()
    if (settings.apiUrl) {
        configuration._setApiUrl(settings.apiUrl)
        await maybeStartLocalProxyForHttpsApiUrl(settings.apiUrl)
        return
    }
    if (settings.serverUrl) {
        // Migrate from legacy field name
        configuration._setApiUrl(settings.serverUrl)
        await maybeStartLocalProxyForHttpsApiUrl(settings.serverUrl)
        return
    }

    // 3. Default value already set in configuration constructor
}

let exitCleanupRegistered = false
let activeProxy: LocalHttpProxy | null = null

async function maybeStartLocalProxyForHttpsApiUrl(apiUrl: string): Promise<void> {
    // Only Bun-compiled binaries hit the TLS verification bug. Skip in Node
    // dev/test runs to avoid a needless child process and dead code paths.
    if (!isBunCompiled()) return
    if (configuration.hasApiLocalProxy()) return
    if (!shouldUseLocalHubTlsProxy(apiUrl)) return

    const proxy = await startOrReuseLocalHttpProxy(apiUrl)
    configuration.setLocalProxyApiUrl(proxy.url)
    activeProxy = proxy
    registerExitCleanup()
}

function registerExitCleanup(): void {
    if (exitCleanupRegistered) return
    exitCleanupRegistered = true
    process.once('exit', () => {
        void activeProxy?.close()
    })
}
