/**
 * API URL initialization module
 *
 * Handles HAPI_API_URL initialization with priority:
 * 1. Environment variable (highest - allows temporary override)
 * 2. Settings file (~/.hapi/settings.json)
 * 3. Default value (http://localhost:3006)
 */

import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { startLocalHttpProxy } from '@/utils/localHttpProxy'

/**
 * Initialize API URL
 * Must be called before any API operations
 */
export async function initializeApiUrl(): Promise<void> {
    // 1. Environment variable has highest priority (allows temporary override)
    if (process.env.HAPI_API_URL) {
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

async function maybeStartLocalProxyForHttpsApiUrl(apiUrl: string): Promise<void> {
    if (configuration.hasApiLocalProxy() || !apiUrl.startsWith('https://')) {
        return
    }

    const proxy = await startLocalHttpProxy(apiUrl)
    configuration.setApiLocalProxyUrl(proxy.url)
    configuration._setApiLocalProxyUrl(proxy.url)

    process.on('exit', () => {
        void proxy.close()
    })
}
