import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithAbort } from '@/utils/spawnWithAbort';
import { startOpencodeServe, type OpencodeServeHandle } from './serveManager';
import { createSdkClient, type SdkClient } from './sdkClient';
import { startSseBridge, type SseBridgeHandle } from './sseBridge';
import { buildOpencodeEnv } from '../utils/config';
import type { OpencodeSession } from '../session';
import { TITLE_INSTRUCTION } from '../utils/systemPrompt';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { ensureOpencodeConfig } from '../utils/opencodeConfig';
import { configuration } from '@/configuration';
import { join } from 'node:path';

export type OpencodeServeLoopOptions = {
    session: OpencodeSession;
    path: string;
    resumeSessionId?: string;
};

function resolveOpencodeConfigDir(session: OpencodeSession): string {
    if (process.env.OPENCODE_CONFIG_DIR) {
        return process.env.OPENCODE_CONFIG_DIR;
    }
    return join(configuration.happyHomeDir, 'tmp', 'opencode', session.client.sessionId, '.opencode');
}

export async function opencodeServeLoop(opts: OpencodeServeLoopOptions): Promise<void> {
    const { session, path } = opts;
    let server: OpencodeServeHandle | null = null;
    let sdk: SdkClient | null = null;
    let bridge: SseBridgeHandle | null = null;
    let happyServer: { url: string; stop: () => void } | null = null;

    try {
        // 1. Prepare MCP config (optional)
        const opencodeConfigDir = resolveOpencodeConfigDir(session);
        let opencodeConfigPath: string | null = null;
        try {
            const mcpBridge = await buildHapiMcpBridge(session.client);
            happyServer = mcpBridge.server;
            const { configPath } = ensureOpencodeConfig(opencodeConfigDir, mcpBridge.mcpServers.hapi, TITLE_INSTRUCTION);
            opencodeConfigPath = configPath;
            logger.debug(`[serve-loop] Started hapi MCP server at ${happyServer.url}`);
        } catch (error) {
            logger.debug('[serve-loop] Failed to start hapi MCP server', error);
        }

        // 2. Build serve env
        const serveEnv: NodeJS.ProcessEnv = {};
        if (!process.env.OPENCODE_CONFIG_DIR) {
            serveEnv.OPENCODE_CONFIG_DIR = opencodeConfigDir;
        }
        if (!process.env.OPENCODE_CONFIG && opencodeConfigPath) {
            serveEnv.OPENCODE_CONFIG = opencodeConfigPath;
        }

        // 3. Start opencode serve
        server = await startOpencodeServe({ cwd: path, env: serveEnv });

        // 4. Create SDK client
        sdk = createSdkClient(server.url, server.password);

        // 5. Create or resume session
        let opencodeSessionId: string;
        if (opts.resumeSessionId) {
            try {
                opencodeSessionId = await sdk.resumeSession(opts.resumeSessionId);
            } catch (error) {
                logger.warn('[serve-loop] Resume failed, creating new session', error);
                opencodeSessionId = await sdk.createSession(path);
            }
        } else {
            opencodeSessionId = await sdk.createSession(path);
        }
        session.onSessionFound(opencodeSessionId);

        // 6. Start SSE bridge (opencode events → hapi web UI)
        bridge = startSseBridge(sdk, session, opencodeSessionId);

        // 7. Run attach TUI + message queue watcher in parallel
        const abortController = new AbortController();

        const attachPromise = runAttach({
            serverUrl: server.url,
            sessionId: opencodeSessionId,
            password: server.password,
            cwd: path,
            signal: abortController.signal
        });

        const watcherPromise = watchMessageQueue({
            sdk,
            session,
            sessionId: opencodeSessionId,
            signal: abortController.signal
        });

        // Wait for either to finish (attach exit means user quit TUI)
        try {
            await Promise.race([attachPromise, watcherPromise]);
        } finally {
            abortController.abort();
            // Wait for both to settle
            await Promise.allSettled([attachPromise, watcherPromise]);
        }
    } finally {
        // 8. Cleanup
        bridge?.stop();
        if (happyServer) {
            happyServer.stop();
            logger.debug('[serve-loop] Stopped hapi MCP server');
        }
        if (server) {
            await server.stop();
        }
    }
}

async function runAttach(opts: {
    serverUrl: string;
    sessionId: string;
    password: string;
    cwd: string;
    signal: AbortSignal;
}): Promise<void> {
    const env = {
        ...buildOpencodeEnv(),
        OPENCODE_SERVER_PASSWORD: opts.password
    };

    logger.debug(`[serve-loop] Spawning opencode attach ${opts.serverUrl} --session ${opts.sessionId}`);

    process.stdin.pause();
    try {
        await spawnWithAbort({
            command: 'opencode',
            args: ['attach', opts.serverUrl, '--session', opts.sessionId],
            cwd: opts.cwd,
            env,
            signal: opts.signal,
            shell: process.platform === 'win32',
            logLabel: 'opencode-attach',
            spawnName: 'opencode',
            installHint: 'OpenCode CLI',
            includeCause: true,
            logExit: true
        });
    } finally {
        process.stdin.resume();
        restoreTerminalState();
    }
}

async function watchMessageQueue(opts: {
    sdk: SdkClient;
    session: OpencodeSession;
    sessionId: string;
    signal: AbortSignal;
}): Promise<void> {
    const { sdk, session, sessionId, signal } = opts;
    let instructionsSent = false;

    while (!signal.aborted) {
        const batch = await session.queue.waitForMessagesAndGetAsString(signal);
        if (!batch) {
            if (signal.aborted) {
                break;
            }
            continue;
        }

        let messageText = batch.message;
        if (!instructionsSent) {
            messageText = `${TITLE_INSTRUCTION}\n\n${batch.message}`;
            instructionsSent = true;
        }

        try {
            await sdk.promptAsync(sessionId, messageText);
        } catch (error) {
            logger.warn('[serve-loop] promptAsync failed', error);
            session.sendSessionEvent({
                type: 'message',
                message: 'OpenCode prompt failed. Check logs for details.'
            });
        }
    }
}
