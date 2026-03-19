import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import { logger } from '@/ui/logger';

export type SdkClient = {
    raw: OpencodeClient;
    createSession: (cwd: string) => Promise<string>;
    resumeSession: (sessionId: string) => Promise<string>;
    promptAsync: (sessionId: string, text: string) => Promise<void>;
    runCommand: (sessionId: string, command: string, args?: string) => Promise<void>;
    listCommands: () => Promise<Array<{ name: string; description?: string; template?: string }>>;
    abort: (sessionId: string) => Promise<void>;
    replyPermission: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
    replyQuestion: (requestId: string, answers: Array<Array<string>>) => Promise<void>;
    subscribeGlobalEvents: () => ReturnType<OpencodeClient['global']['event']>;
};

export function createSdkClient(url: string, password: string): SdkClient {
    const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

    const client = createOpencodeClient({
        baseUrl: url as `http://${string}`,
        headers: {
            Authorization: authHeader
        }
    });

    return {
        raw: client,

        async createSession(cwd: string): Promise<string> {
            const result = await client.session.create({
                directory: cwd
            });
            if (result.error) {
                logger.debug('[sdk-client] Create session error:', JSON.stringify(result.error));
                throw new Error(`Failed to create opencode session: ${JSON.stringify(result.error)}`);
            }
            const session = result.data;
            if (!session) {
                throw new Error('Failed to create opencode session: no data returned');
            }
            logger.debug(`[sdk-client] Created session: ${session.id}`);
            return session.id;
        },

        async resumeSession(sessionId: string): Promise<string> {
            const result = await client.session.get({ sessionID: sessionId });
            if (result.error) {
                logger.debug('[sdk-client] Resume session error:', JSON.stringify(result.error));
                throw new Error(`Failed to resume opencode session: ${JSON.stringify(result.error)}`);
            }
            const session = result.data;
            if (!session) {
                throw new Error(`Failed to resume opencode session: ${sessionId}`);
            }
            logger.debug(`[sdk-client] Resumed session: ${session.id}`);
            return session.id;
        },

        async promptAsync(sessionId: string, text: string): Promise<void> {
            logger.debug(`[sdk-client] Sending promptAsync to session ${sessionId}`);
            await client.session.promptAsync({
                sessionID: sessionId,
                parts: [{ type: 'text', text }]
            });
        },

        async runCommand(sessionId: string, command: string, args?: string): Promise<void> {
            logger.debug(`[sdk-client] Running command /${command} for session ${sessionId}`);
            await client.session.command({
                sessionID: sessionId,
                command,
                arguments: args
            });
        },

        async listCommands(): Promise<Array<{ name: string; description?: string; template?: string }>> {
            const result = await client.command.list();
            if (result.error) {
                logger.debug('[sdk-client] List commands error:', JSON.stringify(result.error));
                throw new Error(`Failed to list commands: ${JSON.stringify(result.error)}`);
            }
            return (result.data ?? []).map((command) => ({
                name: command.name,
                description: command.description,
                template: command.template
            }));
        },

        async abort(sessionId: string): Promise<void> {
            logger.debug(`[sdk-client] Aborting session ${sessionId}`);
            await client.session.abort({ sessionID: sessionId });
        },

        async replyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
            logger.debug(`[sdk-client] Replying to permission ${requestId}: ${reply}`);
            await client.permission.reply({ requestID: requestId, reply });
        },

        async replyQuestion(requestId: string, answers: Array<Array<string>>): Promise<void> {
            logger.debug(`[sdk-client] Replying to question ${requestId}`);
            await client.question.reply({ requestID: requestId, answers });
        },

        subscribeGlobalEvents() {
            return client.global.event();
        }
    };
}
