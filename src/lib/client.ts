import { EventSourceMessage } from '@microsoft/fetch-event-source';
import {
    ContentType,
    Identifier,
    ProtocolMessage,
    QueryRequest,
    SettingsResponse,
    ToolCallDefinition,
    ToolDefinition,
    ToolResultDefinition,
    PartialResponse,
    MetaResponse,
    AttachmentUploadResponse,
    ErrorResponse
} from './types';

export const PROTOCOL_VERSION = "1.0";
export const MESSAGE_LENGTH_LIMIT = 10_000;
export const IDENTIFIER_LENGTH = 32;
export const MAX_EVENT_COUNT = 1000;

type ErrorHandler = (error: Error, message: string) => void;

export class BotError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BotError';
    }
}

export class BotErrorNoRetry extends BotError {
    constructor(message: string) {
        super(message);
        this.name = 'BotErrorNoRetry';
    }
}

export class InvalidBotSettings extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidBotSettings';
    }
}

function safeEllipsis(obj: any, limit: number): string {
    if (typeof obj !== 'string') {
        obj = JSON.stringify(obj);
    }
    if (obj.length > limit) {
        return obj.slice(0, limit - 3) + "...";
    }
    return obj;
}

interface BotContextOptions {
    endpoint: string;
    session?: typeof fetch;
    api_key?: string;
    on_error?: ErrorHandler;
}

class BotContext {
    private endpoint: string;
    private session: typeof fetch;
    private api_key?: string;
    private on_error?: ErrorHandler;

    constructor(options: BotContextOptions) {
        this.endpoint = options.endpoint;
        this.session = options.session || fetch;
        this.api_key = options.api_key;
        this.on_error = options.on_error;
    }

    get headers(): Headers {
        const headers = new Headers({
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        });
        if (this.api_key) {
            headers.set('Authorization', `Bearer ${this.api_key}`);
        }
        return headers;
    }

    async reportError(message: string, metadata?: Record<string, any>): Promise<void> {
        if (this.on_error) {
            const longMessage = `Protocol bot error: ${message} with metadata ${metadata} for endpoint ${this.endpoint}`;
            this.on_error(new BotError(message), longMessage);
        }
        await this.session(this.endpoint, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                version: PROTOCOL_VERSION,
                type: "report_error",
                message,
                metadata: metadata || {}
            })
        });
    }

    async reportFeedback(
        messageId: Identifier,
        userId: Identifier,
        conversationId: Identifier,
        feedbackType: string
    ): Promise<void> {
        await this.session(this.endpoint, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                version: PROTOCOL_VERSION,
                type: "report_feedback",
                message_id: messageId,
                user_id: userId,
                conversation_id: conversationId,
                feedback_type: feedbackType
            })
        });
    }

    async reportReaction(
        messageId: Identifier,
        userId: Identifier,
        conversationId: Identifier,
        reaction: string
    ): Promise<void> {
        await this.session(this.endpoint, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                version: PROTOCOL_VERSION,
                type: "report_reaction",
                message_id: messageId,
                user_id: userId,
                conversation_id: conversationId,
                reaction
            })
        });
    }

    async fetchSettings(): Promise<SettingsResponse> {
        const response = await this.session(this.endpoint, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                version: PROTOCOL_VERSION,
                type: "settings"
            })
        });
        return response.json();
    }

    async *performQueryRequest(options: {
        request: QueryRequest;
        tools?: ToolDefinition[];
        toolCalls?: ToolCallDefinition[];
        toolResults?: ToolResultDefinition[];
    }): AsyncGenerator<PartialResponse, void, unknown> {
        const chunks: string[] = [];
        const messageId = options.request.message_id;
        let eventCount = 0;
        let errorReported = false;

        const payload = {
            ...options.request,
            tools: options.tools?.map(tool => ({...tool})),
            tool_calls: options.toolCalls?.map(call => ({...call})),
            tool_results: options.toolResults?.map(result => ({...result}))
        };

        try {
            const response = await this.session(this.endpoint, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(payload)
            });

            if (!response.body) {
                throw new Error('No response body');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const events = chunk.split('\n\n').filter(Boolean);

                for (const eventText of events) {
                    const lines = eventText.split('\n');
                    const event: Partial<EventSourceMessage> = {};

                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            event.event = line.slice(7);
                        } else if (line.startsWith('data: ')) {
                            event.data = line.slice(6);
                        }
                    }

                    if (!event.event || !event.data) continue;

                    eventCount++;

                    switch (event.event) {
                        case 'done':
                            if (!chunks.length && !errorReported && !options.tools) {
                                await this.reportError(
                                    "Bot returned no text in response",
                                    { message_id: messageId }
                                );
                            }
                            return;

                        case 'text':
                        case 'replace_response':
                            const text = await this.getSingleJsonField(event.data, 'text', messageId);
                            if (event.event === 'replace_response') {
                                chunks.length = 0;
                            }
                            chunks.push(text);
                            yield {
                                text,
                                raw_response: { type: event.event, text: event.data },
                                full_prompt: JSON.stringify(options.request),
                                is_replace_response: event.event === 'replace_response'
                            };
                            break;

                        case 'suggested_reply':
                            const suggestedText = await this.getSingleJsonField(
                                event.data,
                                'suggested_reply',
                                messageId
                            );
                            yield {
                                text: suggestedText,
                                raw_response: { type: event.event, text: event.data },
                                full_prompt: JSON.stringify(options.request),
                                is_suggested_reply: true
                            };
                            break;

                        case 'json':
                            yield {
                                text: '',
                                data: JSON.parse(event.data),
                                full_prompt: JSON.stringify(options.request)
                            };
                            break;

                        case 'meta':
                            if (eventCount !== 1) continue;

                            const metaData = await this.loadJsonDict(event.data, 'meta', messageId);
                            const linkify = metaData.linkify ?? false;
                            const suggestedReplies = metaData.suggested_replies ?? false;
                            const contentType = metaData.content_type ?? 'text/markdown';

                            if (typeof linkify !== 'boolean' || typeof suggestedReplies !== 'boolean' || typeof contentType !== 'string') {
                                await this.reportError(
                                    "Invalid meta event values",
                                    { message_id: messageId, meta: metaData }
                                );
                                errorReported = true;
                                continue;
                            }

                            yield {
                                text: '',
                                raw_response: metaData,
                                full_prompt: JSON.stringify(options.request),
                                linkify,
                                suggested_replies: suggestedReplies,
                                content_type: contentType as ContentType
                            } as MetaResponse;
                            break;

                        case 'error':
                            const errorData = await this.loadJsonDict(event.data, 'error', messageId);
                            if (errorData.allow_retry ?? true) {
                                throw new BotError(event.data);
                            } else {
                                throw new BotErrorNoRetry(event.data);
                            }

                        case 'ping':
                            continue;

                        default:
                            await this.reportError(
                                `Unknown event type: ${safeEllipsis(event.event, 100)}`,
                                {
                                    event_data: safeEllipsis(event.data, 500),
                                    message_id: messageId
                                }
                            );
                            errorReported = true;
                            continue;
                    }
                }
            }
        } catch (error) {
            if (error instanceof BotError) {
                throw error;
            }
            throw new BotError(`Error communicating with bot: ${error}`);
        }
    }

    private async getSingleJsonField(
        data: string,
        context: string,
        messageId: Identifier,
        field: string = 'text'
    ): Promise<string> {
        const dataDict = await this.loadJsonDict(data, context, messageId);
        const text = dataDict[field];
        if (typeof text !== 'string') {
            await this.reportError(
                `Expected string in '${field}' field for '${context}' event`,
                { data: dataDict, message_id: messageId }
            );
            throw new BotErrorNoRetry(`Expected string in '${context}' event`);
        }
        return text;
    }

    private async loadJsonDict(
        data: string,
        context: string,
        messageId: Identifier
    ): Promise<Record<string, any>> {
        try {
            const parsed = JSON.parse(data);
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                await this.reportError(
                    `Expected JSON dict in ${context} event`,
                    { data, message_id: messageId }
                );
                throw new BotError(`Expected JSON dict in ${context} event`);
            }
            return parsed;
        } catch (error) {
            await this.reportError(
                `Invalid JSON in ${context} event`,
                { data, message_id: messageId }
            );
            throw new BotErrorNoRetry(`Invalid JSON in ${context} event`);
        }
    }
}

function defaultErrorHandler(error: Error, msg: string): void {
    console.error("Error in Poe bot:", msg, "\n", error);
}

export async function* streamRequest(
    request: QueryRequest,
    botName: string,
    apiKey: string = "",
    options: {
        tools?: ToolDefinition[];
        toolExecutables?: Array<(...args: any[]) => any>;
        accessKey?: string;
        accessKeyDeprecationWarningStacklevel?: number;
        session?: typeof fetch;
        onError?: ErrorHandler;
        numTries?: number;
        retrySleepTime?: number;
        baseUrl?: string;
    } = {}
): AsyncGenerator<PartialResponse, void, unknown> {
    const {
        tools,
        toolExecutables,
        accessKey = "",
        session = fetch,
        onError = defaultErrorHandler,
        numTries = 2,
        retrySleepTime = 500,
        baseUrl = "https://api.poe.com/bot/"
    } = options;

    let toolCalls: ToolCallDefinition[] | undefined;
    let toolResults: ToolResultDefinition[] | undefined;

    if (tools) {
        if (!toolExecutables) {
            throw new Error("Tool executables must be provided when tools are specified");
        }

        toolCalls = await getToolCalls({
            request,
            botName,
            apiKey,
            tools,
            accessKey,
            session,
            onError,
            numTries,
            retrySleepTime,
            baseUrl
        });

        toolResults = await getToolResults(toolExecutables, toolCalls);
    }

    yield* streamRequestBase({
        request,
        botName,
        apiKey,
        tools,
        toolCalls,
        toolResults,
        accessKey,
        session,
        onError,
        numTries,
        retrySleepTime,
        baseUrl
    });
}

async function getToolResults(
    toolExecutables: Array<(...args: any[]) => any>,
    toolCalls: ToolCallDefinition[]
): Promise<ToolResultDefinition[]> {
    const toolExecutablesDict = Object.fromEntries(
        toolExecutables.map(exec => [exec.name, exec])
    );

    const toolResults: ToolResultDefinition[] = [];

    for (const toolCall of toolCalls) {
        const toolCallId = toolCall.id;
        const name = toolCall.function.name;
        const arguments_ = JSON.parse(toolCall.function.arguments);

        const func = toolExecutablesDict[name];
        const content = func.constructor.name === 'AsyncFunction'
            ? await func(...arguments_)
            : func(...arguments_);

        toolResults.push({
            role: 'tool',
            tool_call_id: toolCallId,
            name,
            content: JSON.stringify(content)
        });
    }

    return toolResults;
}

export async function getToolCalls(options: {
    request: QueryRequest,
    botName: string,
    apiKey: string,
    tools: ToolDefinition[],
    accessKey?: string,
    session?: typeof fetch,
    onError?: ErrorHandler,
    numTries?: number,
    retrySleepTime?: number,
    baseUrl?: string
}): Promise<ToolCallDefinition[]> {
    const toolCallObjectDict: Record<number, Record<string, any>> = {};

    for await (const message of streamRequestBase(options)) {
        if (message.data) {
            const finishReason = message.data.choices[0].finish_reason;
            if (finishReason === null) {
                try {
                    const toolCallObject = message.data.choices[0].delta.tool_calls[0];
                    const index = toolCallObject.index;
                    delete toolCallObject.index;

                    if (!(index in toolCallObjectDict)) {
                        toolCallObjectDict[index] = toolCallObject;
                    } else {
                        const functionInfo = toolCallObject.function;
                        toolCallObjectDict[index].function.arguments += functionInfo.arguments;
                    }
                } catch (error) {
                    continue;
                }
            }
        }
    }

    const toolCallObjectList = Object.entries(toolCallObjectDict)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([_, obj]) => obj);

    return toolCallObjectList.map(obj => ({
        id: obj.id,
        type: obj.type,
        function: {
            name: obj.function.name,
            arguments: obj.function.arguments
        }
    }));
}

export async function* streamRequestBase(options: {
    request: QueryRequest,
    botName: string,
    apiKey: string,
    tools?: ToolDefinition[],
    toolCalls?: ToolCallDefinition[],
    toolResults?: ToolResultDefinition[],
    accessKey?: string,
    session?: typeof fetch,
    onError?: ErrorHandler,
    numTries?: number,
    retrySleepTime?: number,
    baseUrl?: string
}): AsyncGenerator<PartialResponse, void, unknown> {
    const {
        request,
        botName,
        apiKey,
        tools,
        toolCalls,
        toolResults,
        accessKey = "",
        session = fetch,
        onError = defaultErrorHandler,
        numTries = 2,
        retrySleepTime = 500,
        baseUrl = "https://api.poe.com/bot/"
    } = options;

    const url = `${baseUrl}${botName}`;
    const context = new BotContext({
        endpoint: url,
        api_key: apiKey,
        session,
        on_error: onError
    });

    let gotResponse = false;

    for (let i = 0; i < numTries; i++) {
        try {
            for await (const message of context.performQueryRequest({
                request,
                tools,
                toolCalls,
                toolResults
            })) {
                gotResponse = true;
                yield message;
            }
            break;
        } catch (error) {
            if (error instanceof BotErrorNoRetry) {
                throw error;
            }
            onError(
                error instanceof Error ? error : new Error(String(error)),
                `Bot request to ${botName} failed on try ${i}`
            );

            const allowRetryAfterResponse = error instanceof Error &&
                error.message.includes('peer closed connection without sending complete message body');

            if ((gotResponse && !allowRetryAfterResponse) || i === numTries - 1) {
                if (error instanceof BotError) {
                    throw error;
                }
                throw new BotError(`Error communicating with bot ${botName}`);
            }

            await new Promise(resolve => setTimeout(resolve, retrySleepTime));
        }
    }
}

export async function getBotResponse(
    messages: ProtocolMessage[],
    botName: string,
    apiKey: string,
    options: {
        tools?: ToolDefinition[];
        toolExecutables?: Array<(...args: any[]) => any>;
        temperature?: number;
        skipSystemPrompt?: boolean;
        logitBias?: Record<string, number>;
        stopSequences?: string[];
        baseUrl?: string;
        session?: typeof fetch;
    } = {}
): Promise<AsyncGenerator<PartialResponse, void, unknown>> {
    const query = {
        query: messages,
        user_id: "",
        conversation_id: "",
        message_id: "",
        version: PROTOCOL_VERSION,
        type: "query" as const,
        ...options
    };

    return streamRequest(query, botName, apiKey, {
        tools: options.tools,
        toolExecutables: options.toolExecutables,
        baseUrl: options.baseUrl,
        session: options.session
    });
}

export async function getFinalResponse(options: {
    request: QueryRequest,
    botName: string,
    apiKey?: string,
    accessKey?: string,
    session?: typeof fetch,
    onError?: ErrorHandler,
    numTries?: number,
    retrySleepTime?: number,
    baseUrl?: string
}): Promise<string> {
    const chunks: string[] = [];

    for await (const message of streamRequest(
        options.request,
        options.botName,
        options.apiKey || "",
        options
    )) {
        if ('content_type' in message || message.is_suggested_reply) {
            continue;
        }
        if (message.is_replace_response) {
            chunks.length = 0;
        }
        chunks.push(message.text);
    }

    if (!chunks.length) {
        throw new BotError(`Bot ${options.botName} sent no response`);
    }

    return chunks.join('');
}

export function syncBotSettings(
    botName: string,
    accessKey: string = "",
    options: {
        settings?: Record<string, any>,
        baseUrl?: string
    } = {}
): void {
    const { settings, baseUrl = "https://api.poe.com/bot/" } = options;

    try {
        const url = settings
            ? `${baseUrl}update_settings/${botName}/${accessKey}/${PROTOCOL_VERSION}`
            : `${baseUrl}fetch_settings/${botName}/${accessKey}/${PROTOCOL_VERSION}`;

        const init: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        if (settings) {
            init.body = JSON.stringify(settings);
        }

        fetch(url, init)
            .then(response => {
                if (!response.ok) {
                    throw new BotError(
                        `Error syncing settings for bot ${botName}: ${response.statusText}`
                    );
                }
                return response.text();
            })
            .then(console.log)
            .catch(error => {
                let errorMessage = `Error syncing settings for bot ${botName}: ${error.message}`;
                if (!settings) {
                    errorMessage += " Check that the bot server is running.";
                }
                throw new BotError(errorMessage);
            });
    } catch (error) {
        console.error(error);
    }
}