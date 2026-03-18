import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { OpencodeSession } from './session';
import { opencodeLocalLauncher } from './opencodeLocalLauncher';
import { opencodeRemoteLauncher } from './opencodeRemoteLauncher';
import { opencodeServeLoop } from './serve/serveLoop';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { OpencodeMode, PermissionMode } from './types';
import type { OpencodeHookServer } from './utils/startOpencodeHookServer';
import { spawn } from 'node:child_process';

interface OpencodeLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<OpencodeMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    hookServer: OpencodeHookServer;
    hookUrl: string;
    onSessionReady?: (session: OpencodeSession) => void;
}

async function supportsServeMode(): Promise<boolean> {
    try {
        const result = await new Promise<number>((resolve) => {
            const child = spawn('opencode', ['serve', '--help'], {
                stdio: 'ignore',
                shell: process.platform === 'win32'
            });
            child.on('error', () => resolve(1));
            child.on('exit', (code) => resolve(code ?? 1));
        });
        return result === 0;
    } catch {
        return false;
    }
}

export async function opencodeLoop(opts: OpencodeLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    const session = new OpencodeSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.resumeSessionId ?? null,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        permissionMode: opts.permissionMode ?? 'default'
    });

    if (opts.resumeSessionId) {
        session.onSessionFound(opts.resumeSessionId);
    }

    if (opts.onSessionReady) {
        opts.onSessionReady(session);
    }

    // Prefer serve mode when available (opencode >= 1.2.0)
    if (startedBy === 'terminal' && await supportsServeMode()) {
        logger.debug('[opencode-loop] Using serve mode');
        await opencodeServeLoop({
            session,
            path: opts.path,
            resumeSessionId: opts.resumeSessionId
        });
        return;
    }

    logger.debug('[opencode-loop] Falling back to legacy local/remote mode');

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'opencode-loop',
        runLocal: (instance) => opencodeLocalLauncher(instance, {
            hookServer: opts.hookServer,
            hookUrl: opts.hookUrl
        }),
        runRemote: (instance) => opencodeRemoteLauncher(instance),
    });
}
