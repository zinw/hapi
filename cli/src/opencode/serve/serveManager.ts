import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { logger } from '@/ui/logger';
import { buildOpencodeEnv } from '../utils/config';
import { killProcessByChildProcess } from '@/utils/process';

export type OpencodeServeHandle = {
    url: string;
    password: string;
    stop: () => Promise<void>;
};

async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                const port = addr.port;
                server.close(() => resolve(port));
            } else {
                server.close(() => reject(new Error('Failed to get port')));
            }
        });
        server.on('error', reject);
    });
}

export async function startOpencodeServe(opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
}): Promise<OpencodeServeHandle> {
    const port = await findFreePort();
    const password = randomBytes(32).toString('base64');
    const hostname = '127.0.0.1';
    const url = `http://${hostname}:${port}`;

    const env = {
        ...buildOpencodeEnv(),
        ...opts.env,
        OPENCODE_SERVER_PASSWORD: password
    };

    logger.debug(`[serve-manager] Starting opencode serve on port ${port}`);

    const child: ChildProcess = spawn('opencode', ['serve', '--port', String(port), '--hostname', hostname], {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
    });

    let stopped = false;

    const stop = async () => {
        if (stopped) {
            return;
        }
        stopped = true;
        logger.debug('[serve-manager] Stopping opencode serve');
        try {
            await killProcessByChildProcess(child, false);
        } catch {
            // ignore
        }
    };

    // Wait for server to be ready
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('opencode serve startup timed out after 30s'));
        }, 30_000);

        let stderr = '';

        child.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            logger.debug(`[serve-manager] stdout: ${text.trim()}`);
            if (text.includes('listening on') || text.includes('server started')) {
                clearTimeout(timeout);
                resolve();
            }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            logger.debug(`[serve-manager] stderr: ${text.trim()}`);
            // Some versions log the listening message to stderr
            if (text.includes('listening on') || text.includes('server started')) {
                clearTimeout(timeout);
                resolve();
            }
        });

        child.on('error', (error) => {
            clearTimeout(timeout);
            reject(new Error(`Failed to spawn opencode serve: ${error.message}. Is OpenCode CLI installed?`));
        });

        child.on('exit', (code) => {
            if (!stopped) {
                clearTimeout(timeout);
                reject(new Error(`opencode serve exited unexpectedly with code ${code}. stderr: ${stderr.slice(-500)}`));
            }
        });
    });

    // Health check
    const authHeader = `Basic ${Buffer.from(`:${password}`).toString('base64')}`;
    let healthy = false;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            const response = await fetch(`${url}/global/health`, {
                headers: { Authorization: authHeader }
            });
            if (response.ok) {
                healthy = true;
                break;
            }
        } catch {
            // retry
        }
        await new Promise(r => setTimeout(r, 500));
    }

    if (!healthy) {
        await stop();
        throw new Error('opencode serve health check failed after startup');
    }

    logger.debug(`[serve-manager] opencode serve is ready at ${url}`);

    return { url, password, stop };
}
