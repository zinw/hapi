import { logger } from '@/ui/logger';
import type { SdkClient } from './sdkClient';
import type { OpencodeSession } from '../session';
import type { GlobalEvent, Event as OpencodeEvent, ToolPart, TextPart, ReasoningPart } from '@opencode-ai/sdk/v2';

export type SseBridgeHandle = {
    stop: () => void;
};

export function startSseBridge(
    sdk: SdkClient,
    session: OpencodeSession,
    initialSessionId: string
): SseBridgeHandle {
    let stopped = false;
    let activeSessionId = initialSessionId;
    const sentTextParts = new Set<string>();
    const sentToolCalls = new Set<string>();
    const sentToolResults = new Set<string>();

    const clearDeduplicationState = () => {
        sentTextParts.clear();
        sentToolCalls.clear();
        sentToolResults.clear();
    };

    const run = async () => {
        while (!stopped) {
            try {
                await consumeEvents();
            } catch (error) {
                if (stopped) {
                    break;
                }
                logger.debug('[sse-bridge] SSE connection error, reconnecting...', error);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    };

    const consumeEvents = async () => {
        const sseResult = await sdk.subscribeGlobalEvents();
        for await (const globalEvent of sseResult.stream) {
            if (stopped) {
                break;
            }
            const ge = globalEvent as GlobalEvent;
            handleEvent(ge.payload);
        }
    };

    const switchActiveSession = (nextSessionId: string, reason: string) => {
        if (!nextSessionId || nextSessionId === activeSessionId) {
            return;
        }
        logger.debug(`[sse-bridge] Switching active session to ${nextSessionId} (${reason}, was ${activeSessionId})`);
        activeSessionId = nextSessionId;
        clearDeduplicationState();
        session.onSessionFound(nextSessionId);
    };

    const handleEvent = (event: OpencodeEvent) => {
        switch (event.type) {
            case 'session.created': {
                const info = event.properties.info;
                if (!info.id) {
                    break;
                }

                // Child sessions are typically spawned by subagents/task tools.
                // Do not switch the tracked main session to a child session.
                if (info.parentID) {
                    logger.debug(`[sse-bridge] Ignoring child session ${info.id} (parent=${info.parentID})`);
                    break;
                }

                // A brand new top-level session (e.g. /new) should become active.
                switchActiveSession(info.id, 'top-level session.created');
                break;
            }

            case 'tui.session.select': {
                switchActiveSession(event.properties.sessionID, 'tui.session.select');
                break;
            }

            case 'session.updated': {
                const info = event.properties.info;
                if (info.id === activeSessionId) {
                    session.onSessionFound(info.id);
                    break;
                }
                if (!info.parentID && info.id !== activeSessionId) {
                    // Top-level session update may indicate the user switched to another session.
                    // Child session updates must not steal focus.
                    logger.debug(`[sse-bridge] Observed top-level session update for ${info.id} while active=${activeSessionId}`);
                }
                break;
            }

            case 'session.status': {
                const props = event.properties;
                if (props.sessionID !== activeSessionId) {
                    break;
                }
                if (props.status.type === 'busy' || props.status.type === 'retry') {
                    session.onThinkingChange(true);
                } else if (props.status.type === 'idle') {
                    session.onThinkingChange(false);
                }
                break;
            }

            case 'session.idle': {
                if (event.properties.sessionID === activeSessionId) {
                    session.onThinkingChange(false);
                }
                break;
            }

            case 'message.updated': {
                const info = event.properties.info;
                if (info.sessionID !== activeSessionId) {
                    break;
                }
                if (info.role === 'user') {
                    // User message from attach TUI — forward to web UI
                    // We don't have the text content directly from message.updated
                    // Text comes via message.part.updated
                }
                break;
            }

            case 'message.part.updated': {
                const part = event.properties.part;
                if (part.sessionID !== activeSessionId) {
                    break;
                }
                handlePartUpdated(part);
                break;
            }

            case 'message.part.delta': {
                // Deltas are incremental; we rely on part.updated for full snapshots
                // The TUI handles streaming, so we only need the consolidated part updates
                break;
            }

            case 'permission.asked': {
                const props = event.properties;
                if (props.sessionID !== activeSessionId) {
                    break;
                }
                session.client.updateAgentState((currentState) => ({
                    ...currentState,
                    requests: {
                        ...currentState.requests,
                        [props.id]: {
                            tool: props.permission,
                            arguments: props.metadata,
                            createdAt: Date.now()
                        }
                    }
                }));
                break;
            }

            case 'permission.replied': {
                const props = event.properties;
                if (props.sessionID !== activeSessionId) {
                    break;
                }
                session.client.updateAgentState((currentState) => {
                    const request = currentState.requests?.[props.requestID];
                    const nextRequests = { ...(currentState.requests || {}) };
                    delete nextRequests[props.requestID];
                    const status = props.reply === 'once' || props.reply === 'always' ? 'approved' : 'denied';
                    const decision = props.reply === 'always' ? 'approved_for_session' : status === 'approved' ? 'approved' : 'denied';
                    return {
                        ...currentState,
                        requests: nextRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [props.requestID]: {
                                ...(request ?? { tool: 'Permission', arguments: undefined, createdAt: Date.now() }),
                                completedAt: Date.now(),
                                status,
                                decision
                            }
                        }
                    };
                });
                break;
            }

            case 'question.asked': {
                const props = event.properties;
                if (props.sessionID !== activeSessionId) {
                    break;
                }
                // Forward question to web UI via agentState
                session.client.updateAgentState((currentState) => ({
                    ...currentState,
                    requests: {
                        ...currentState.requests,
                        [props.id]: {
                            tool: 'Question',
                            arguments: {
                                questions: props.questions
                            },
                            createdAt: Date.now()
                        }
                    }
                }));
                break;
            }

            case 'session.error': {
                const props = event.properties;
                if (props.sessionID !== activeSessionId) {
                    break;
                }
                if (props.error) {
                    session.sendCodexMessage({
                        type: 'error',
                        message: 'data' in props.error ? props.error.data.message : 'Unknown error'
                    });
                }
                break;
            }

            default:
                // Ignore other events (file.edited, lsp.*, etc.)
                break;
        }
    };

    const handlePartUpdated = (part: TextPart | ReasoningPart | ToolPart | { type: string; [key: string]: unknown }) => {
        switch (part.type) {
            case 'text': {
                const textPart = part as TextPart;
                if (sentTextParts.has(textPart.id)) {
                    // Update existing text part
                    session.sendCodexMessage({
                        type: 'message',
                        message: textPart.text,
                        id: textPart.id
                    });
                    return;
                }
                sentTextParts.add(textPart.id);
                session.sendCodexMessage({
                    type: 'message',
                    message: textPart.text,
                    id: textPart.id
                });
                break;
            }

            case 'reasoning': {
                const reasoningPart = part as ReasoningPart;
                session.sendCodexMessage({
                    type: 'reasoning',
                    message: reasoningPart.text
                });
                break;
            }

            case 'tool': {
                const toolPart = part as ToolPart;
                const callId = toolPart.callID;
                const name = toolPart.tool;
                const state = toolPart.state;

                if (state.status === 'pending' || state.status === 'running') {
                    if (!sentToolCalls.has(callId)) {
                        sentToolCalls.add(callId);
                        session.sendCodexMessage({
                            type: 'tool-call',
                            name,
                            callId,
                            input: state.input
                        });
                    }
                } else if (state.status === 'completed') {
                    // Send tool call first if not already sent
                    if (!sentToolCalls.has(callId)) {
                        sentToolCalls.add(callId);
                        session.sendCodexMessage({
                            type: 'tool-call',
                            name,
                            callId,
                            input: state.input
                        });
                    }
                    if (!sentToolResults.has(callId)) {
                        sentToolResults.add(callId);
                        session.sendCodexMessage({
                            type: 'tool-call-result',
                            callId,
                            output: {
                                content: state.output,
                                metadata: state.metadata,
                                title: state.title,
                                attachments: state.attachments
                            }
                        });
                    }
                } else if (state.status === 'error') {
                    if (!sentToolCalls.has(callId)) {
                        sentToolCalls.add(callId);
                        session.sendCodexMessage({
                            type: 'tool-call',
                            name,
                            callId,
                            input: state.input
                        });
                    }
                    if (!sentToolResults.has(callId)) {
                        sentToolResults.add(callId);
                        session.sendCodexMessage({
                            type: 'tool-call-result',
                            callId,
                            output: {
                                content: state.error,
                                isError: true
                            }
                        });
                    }
                }
                break;
            }

            default:
                // subtask, step-start, step-finish, etc. — ignore for now
                break;
        }
    };

    // Start consuming in the background
    void run();

    return {
        stop: () => {
            stopped = true;
        }
    };
}
