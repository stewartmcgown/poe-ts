import fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import cors from '@fastify/cors';
import { argv, exit } from 'process';
import { Logger } from 'pino';
import { EventSourceMessage } from '@microsoft/fetch-event-source';
import EventEmitter from 'events';
import { createReadStream, ReadStream } from 'fs';
import { basename } from 'path';
import {
    ProtocolMessage,
    QueryRequest,
    SettingsRequest,
    SettingsResponse,
    ReportFeedbackRequest,
    ReportReactionRequest,
    ReportErrorRequest,
    PartialResponse,
    RequestContext,
    Attachment,
    AttachmentUploadResponse,
    CostItem,
    ContentType,
    Identifier,
    ErrorResponse,
    MetaResponse,
} from './types';
import {
    TEXT_ATTACHMENT_TEMPLATE,
    URL_ATTACHMENT_TEMPLATE,
    IMAGE_VISION_ATTACHMENT_TEMPLATE
} from './templates';
import { PROTOCOL_VERSION } from './client';

export class InvalidParameterError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidParameterError';
    }
}

export class AttachmentUploadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AttachmentUploadError';
    }
}

export class CostRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CostRequestError';
    }
}

export class InsufficientFundError extends Error {
    constructor(message: string = "Insufficient funds") {
        super(message);
        this.name = 'InsufficientFundError';
    }
}

interface PendingFileAttachmentTask extends Promise<AttachmentUploadResponse> {
    cancel?: () => void;
}

export class PoeBot {
    path: string;
    accessKey?: string;
    botName?: string;
    shouldInsertAttachmentMessages: boolean;
    concatAttachmentsToMessage: boolean;
    private pendingFileAttachmentTasks: Map<string, Set<PendingFileAttachmentTask>>;

    constructor({
                    path = "/",
                    accessKey,
                    botName,
                    shouldInsertAttachmentMessages = true,
                    concatAttachmentsToMessage = false,
                }: {
        path?: string;
        accessKey?: string;
        botName?: string;
        shouldInsertAttachmentMessages?: boolean;
        concatAttachmentsToMessage?: boolean;
    } = {}) {
        this.path = path;
        this.accessKey = accessKey;
        this.botName = botName;
        this.shouldInsertAttachmentMessages = shouldInsertAttachmentMessages;
        this.concatAttachmentsToMessage = concatAttachmentsToMessage;
        this.pendingFileAttachmentTasks = new Map();
    }

    async *getResponse(request: QueryRequest): AsyncGenerator<PartialResponse | EventSourceMessage> {
        yield this.textEvent("hello");
    }

    async *getResponseWithContext(
        request: QueryRequest,
        context: RequestContext
    ): AsyncGenerator<PartialResponse | EventSourceMessage> {
        try {
            yield* this.getResponse(request);
        } catch (error) {
            if (error instanceof InsufficientFundError) {
                yield {
                    text: "",
                    error_type: "insufficient_fund"
                } as ErrorResponse;
            } else {
                throw error;
            }
        }
    }

    async getSettings(setting: SettingsRequest): Promise<SettingsResponse> {
        return {};
    }

    async getSettingsWithContext(
        setting: SettingsRequest,
        context: RequestContext
    ): Promise<SettingsResponse> {
        return this.getSettings(setting);
    }

    async onFeedback(feedbackRequest: ReportFeedbackRequest): Promise<void> {
        // Override this to handle feedback
    }

    async onFeedbackWithContext(
        feedbackRequest: ReportFeedbackRequest,
        context: RequestContext
    ): Promise<void> {
        await this.onFeedback(feedbackRequest);
    }

    async onReactionWithContext(
        reactionRequest: ReportReactionRequest,
        context: RequestContext
    ): Promise<void> {
        // Override this to handle reactions
    }

    async onError(errorRequest: ReportErrorRequest): Promise<void> {
        console.error(`Error from Poe server: ${JSON.stringify(errorRequest)}`);
    }

    async onErrorWithContext(
        errorRequest: ReportErrorRequest,
        context: RequestContext
    ): Promise<void> {
        await this.onError(errorRequest);
    }

    async postMessageAttachment({
                                    messageId,
                                    downloadUrl,
                                    downloadFilename,
                                    fileData,
                                    filename,
                                    contentType,
                                    isInline = false,
                                }: {
        messageId: Identifier;
        downloadUrl?: string;
        downloadFilename?: string;
        fileData?: Buffer | ReadStream;
        filename?: string;
        contentType?: string;
        isInline?: boolean;
    }): Promise<AttachmentUploadResponse> {
        if (!this.accessKey) {
            throw new InvalidParameterError(
                "access_key is required for file attachments"
            );
        }

        const task = this.makeFileAttachmentRequest({
            messageId,
            downloadUrl,
            downloadFilename,
            fileData,
            filename,
            contentType,
            isInline,
        });

        let tasks = this.pendingFileAttachmentTasks.get(messageId);
        if (!tasks) {
            tasks = new Set();
            this.pendingFileAttachmentTasks.set(messageId, tasks);
        }
        tasks.add(task);

        try {
            return await task;
        } finally {
            tasks.delete(task);
        }
    }

    private async makeFileAttachmentRequest({
                                                messageId,
                                                downloadUrl,
                                                downloadFilename,
                                                fileData,
                                                filename,
                                                contentType,
                                                isInline,
                                            }: {
        messageId: Identifier;
        downloadUrl?: string;
        downloadFilename?: string;
        fileData?: Buffer | ReadStream;
        filename?: string;
        contentType?: string;
        isInline?: boolean;
    }): Promise<AttachmentUploadResponse> {
        const url = 'https://www.quora.com/poe_api/file_attachment_3RD_PARTY_POST';
        const headers = {
            'Authorization': this.accessKey!,
        };

        const formData = new FormData();
        formData.append('message_id', messageId);
        formData.append('is_inline', String(isInline));

        if (downloadUrl) {
            if (fileData || filename) {
                throw new InvalidParameterError(
                    "Cannot provide filename or fileData if downloadUrl is provided."
                );
            }
            formData.append('download_url', downloadUrl);
            if (downloadFilename) {
                formData.append('download_filename', downloadFilename);
            }
        } else if (fileData && filename) {
            const blob = fileData instanceof ReadStream
                ? new Blob([await streamToBuffer(fileData)])
                : new Blob([fileData]);

            const file = new File([blob], filename, { type: contentType });
            formData.append('file', file);
        } else {
            throw new InvalidParameterError(
                "Must provide either downloadUrl or fileData and filename."
            );
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: formData,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new AttachmentUploadError(
                    `${response.status} ${response.statusText}: ${errorText}`
                );
            }

            const responseData = await response.json();
            return {
                inline_ref: responseData.inline_ref,
                attachment_url: responseData.attachment_url,
            };
        } catch (error) {
            if (error instanceof AttachmentUploadError) {
                throw error;
            }
            console.error("An error occurred when attempting to attach file");
            throw new AttachmentUploadError(
                `File attachment failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async processPendingAttachmentRequests(messageId: string): Promise<void> {
        const tasks = this.pendingFileAttachmentTasks.get(messageId);
        if (tasks) {
            try {
                await Promise.all(tasks);
            } catch (error) {
                console.error("Error processing pending attachment requests");
                throw error;
            } finally {
                this.pendingFileAttachmentTasks.delete(messageId);
            }
        }
    }

    concatAttachmentContentToMessageBody(queryRequest: QueryRequest): QueryRequest {
        console.warn(
            "concatAttachmentContentToMessageBody is deprecated. Use insertAttachmentMessages instead."
        );

        const lastMessage = queryRequest.query[queryRequest.query.length - 1];
        let concatenatedContent = lastMessage.content;

        for (const attachment of lastMessage.attachments || []) {
            if (attachment.parsed_content) {
                if (attachment.content_type === "text/html") {
                    const urlAttachmentContent = URL_ATTACHMENT_TEMPLATE
                        .replace("{attachment_name}", attachment.name)
                        .replace("{content}", attachment.parsed_content);
                    concatenatedContent = `${concatenatedContent}\n\n${urlAttachmentContent}`;
                } else if (attachment.content_type.includes("text")) {
                    const textAttachmentContent = TEXT_ATTACHMENT_TEMPLATE
                        .replace("{attachment_name}", attachment.name)
                        .replace("{attachment_parsed_content}", attachment.parsed_content);
                    concatenatedContent = `${concatenatedContent}\n\n${textAttachmentContent}`;
                } else if (attachment.content_type.includes("image")) {
                    const [filename, parsedText] = attachment.parsed_content.split("***");
                    const imageAttachmentContent = IMAGE_VISION_ATTACHMENT_TEMPLATE
                        .replace("{filename}", filename)
                        .replace("{parsed_image_description}", parsedText);
                    concatenatedContent = `${concatenatedContent}\n\n${imageAttachmentContent}`;
                }
            }
        }

        return {
            ...queryRequest,
            query: [
                ...queryRequest.query.slice(0, -1),
                { ...lastMessage, content: concatenatedContent }
            ]
        };
    }

    insertAttachmentMessages(queryRequest: QueryRequest): QueryRequest {
        const lastMessage = queryRequest.query[queryRequest.query.length - 1];
        const textAttachmentMessages: ProtocolMessage[] = [];
        const imageAttachmentMessages: ProtocolMessage[] = [];

        for (const attachment of lastMessage.attachments || []) {
            if (attachment.parsed_content) {
                if (attachment.content_type === "text/html") {
                    const urlAttachmentContent = URL_ATTACHMENT_TEMPLATE
                        .replace("{attachment_name}", attachment.name)
                        .replace("{content}", attachment.parsed_content);
                    textAttachmentMessages.push({
                        role: "user",
                        content: urlAttachmentContent
                    });
                } else if (attachment.content_type.includes("text")) {
                    const textAttachmentContent = TEXT_ATTACHMENT_TEMPLATE
                        .replace("{attachment_name}", attachment.name)
                        .replace("{attachment_parsed_content}", attachment.parsed_content);
                    textAttachmentMessages.push({
                        role: "user",
                        content: textAttachmentContent
                    });
                } else if (attachment.content_type.includes("image")) {
                    const [filename, parsedText] = attachment.parsed_content.split("***");
                    const imageAttachmentContent = IMAGE_VISION_ATTACHMENT_TEMPLATE
                        .replace("{filename}", filename)
                        .replace("{parsed_image_description}", parsedText);
                    imageAttachmentMessages.push({
                        role: "user",
                        content: imageAttachmentContent
                    });
                }
            }
        }

        return {
            ...queryRequest,
            query: [
                ...queryRequest.query.slice(0, -1),
                ...textAttachmentMessages,
                ...imageAttachmentMessages,
                lastMessage
            ]
        };
    }

    makePromptAuthorRoleAlternated(
        protocolMessages: ProtocolMessage[]
    ): ProtocolMessage[] {
        const newMessages: ProtocolMessage[] = [];

        for (const message of protocolMessages) {
            if (newMessages.length > 0 && message.role === newMessages[newMessages.length - 1].role) {
                const prevMessage = newMessages.pop()!;
                const newContent = `${prevMessage.content}\n\n${message.content}`;

                const addedAttachmentUrls = new Set<string>();
                const newAttachments: Attachment[] = [];

                for (const attachment of [
                    ...(message.attachments || []),
                    ...(prevMessage.attachments || [])
                ]) {
                    if (!addedAttachmentUrls.has(attachment.url)) {
                        addedAttachmentUrls.add(attachment.url);
                        newAttachments.push(attachment);
                    }
                }

                newMessages.push({
                    ...prevMessage,
                    content: newContent,
                    attachments: newAttachments
                });
            } else {
                newMessages.push(message);
            }
        }

        return newMessages;
    }

    async captureCost(
        request: QueryRequest,
        amounts: CostItem | CostItem[],
        baseUrl: string = "https://api.poe.com/"
    ): Promise<void> {
        if (!this.accessKey) {
            throw new CostRequestError(
                "Please provide the bot access_key when make_app is called."
            );
        }

        if (!request.bot_query_id) {
            throw new InvalidParameterError(
                "bot_query_id is required to make cost requests."
            );
        }

        const url = `${baseUrl}bot/cost/${request.bot_query_id}/capture`;
        const result = await this.costRequestsInner(amounts, this.accessKey, url);

        if (!result) {
            throw new InsufficientFundError();
        }
    }

    async authorizeCost(
        request: QueryRequest,
        amounts: CostItem | CostItem[],
        baseUrl: string = "https://api.poe.com/"
    ): Promise<void> {
        if (!this.accessKey) {
            throw new CostRequestError(
                "Please provide the bot access_key when make_app is called."
            );
        }

        if (!request.bot_query_id) {
            throw new InvalidParameterError(
                "bot_query_id is required to make cost requests."
            );
        }

        const url = `${baseUrl}bot/cost/${request.bot_query_id}/authorize`;
        const result = await this.costRequestsInner(amounts, this.accessKey, url);

        if (!result) {
            throw new InsufficientFundError();
        }
    }

    private async costRequestsInner(
        amounts: CostItem | CostItem[],
        accessKey: string,
        url: string
    ): Promise<boolean> {
        const amountsArray = Array.isArray(amounts) ? amounts : [amounts];
        const data = {
            amounts: amountsArray,
            access_key: accessKey
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                const error = await response.text();
                throw new CostRequestError(
                    `${response.status} ${response.statusText}: ${error}`
                );
            }

            const result = await response.json();
            return result.status === "success";
        } catch (error) {
            console.error(
                "An HTTP error occurred when attempting to send a cost request."
            );
            throw error;
        }
    }

    protected textEvent(text: string): EventSourceMessage {
        return {
            id: "1",
            data: JSON.stringify({ text }),
            event: "text"
        };
    }

    protected replaceResponseEvent(text: string): EventSourceMessage {
        return {
            id: "1",
            data: JSON.stringify({ text }),
            event: "replace_response"
        };
    }

    protected doneEvent(): EventSourceMessage {
        return {
            id: "1",
            data: "{}",
            event: "done"
        };
    }

    protected suggestedReplyEvent(text: string): EventSourceMessage {
        return {
            id: "1",
            data: JSON.stringify({ text }),
            event: "suggested_reply"
        };
    }

    protected metaEvent(options: {
        contentType?: ContentType;
        refetchSettings?: boolean;
        linkify?: boolean;
        suggestedReplies?: boolean;
    } = {}): EventSourceMessage {
        const {
            contentType = "text/markdown",
            refetchSettings = false,
            linkify = true,
            suggestedReplies = false
        } = options;

        return {
            id: "1",
            data: JSON.stringify({
                content_type: contentType,
                refetch_settings: refetchSettings,
                linkify,
                suggested_replies: suggestedReplies
            }),
            event: "meta"
        };
    }

    protected errorEvent(options: {
        text?: string;
        rawResponse?: any;
        allowRetry?: boolean;
        errorType?: string;
    } = {}): EventSourceMessage {
        const {
            text,
            rawResponse,
            allowRetry = true,
            errorType
        } = options;

        const data: Record<string, any> = { allow_retry: allowRetry };
        if (text !== undefined) data.text = text;
        if (rawResponse !== undefined) data.raw_response = String(rawResponse);
        if (errorType !== undefined) data.error_type = errorType;

        return {
            id: "1",
            data: JSON.stringify(data),
            event: "error"
        };
    }

    async handleReportFeedback(
        feedbackRequest: ReportFeedbackRequest,
        context: RequestContext
    ): Promise<Record<string, never>> {
        await this.onFeedbackWithContext(feedbackRequest, context);
        return {};
    }

    async handleReportReaction(
        reactionRequest: ReportReactionRequest,
        context: RequestContext
    ): Promise<Record<string, never>> {
        await this.onReactionWithContext(reactionRequest, context);
        return {};
    }

    async handleReportError(
        errorRequest: ReportErrorRequest,
        context: RequestContext
    ): Promise<Record<string, never>> {
        await this.onErrorWithContext(errorRequest, context);
        return {};
    }

    async handleSettings(
        settingsRequest: SettingsRequest,
        context: RequestContext
    ): Promise<SettingsResponse> {
        return this.getSettingsWithContext(settingsRequest, context);
    }

    async *handleQuery(
        request: QueryRequest,
        context: RequestContext
    ): AsyncGenerator<EventSourceMessage> {
        try {
            if (this.shouldInsertAttachmentMessages) {
                request = this.insertAttachmentMessages(request);
            } else if (this.concatAttachmentsToMessage) {
                console.warn(
                    "concat_attachments_to_message is deprecated. " +
                    "Use should_insert_attachment_messages instead."
                );
                request = this.concatAttachmentContentToMessageBody(request);
            }

            for await (const event of this.getResponseWithContext(request, context)) {
                if ('event' in event) {
                    yield event as EventSourceMessage;
                } else if ('error_type' in event) {
                    yield this.errorEvent({
                        text: event.text,
                        rawResponse: event.raw_response,
                        allowRetry: (event as ErrorResponse).allow_retry,
                        errorType: (event as ErrorResponse).error_type
                    });
                } else if ('content_type' in event) {
                    yield this.metaEvent({
                        contentType: (event as MetaResponse).content_type,
                        refetchSettings: (event as MetaResponse).refetch_settings,
                        linkify: (event as MetaResponse).linkify,
                        suggestedReplies: (event as MetaResponse).suggested_replies
                    });
                } else if (event.is_suggested_reply) {
                    yield this.suggestedReplyEvent(event.text);
                } else if (event.is_replace_response) {
                    yield this.replaceResponseEvent(event.text);
                } else {
                    yield this.textEvent(event.text);
                }
            }
        } catch (error) {
            console.error("Error responding to query:", error);
            yield this.errorEvent({
                text: "The bot encountered an unexpected issue.",
                rawResponse: error,
                allowRetry: false
            });
        }

        try {
            await this.processPendingAttachmentRequests(request.message_id);
        } catch (error) {
            console.error("Error processing pending attachment requests:", error);
            yield this.errorEvent({
                text: "The bot encountered an unexpected issue.",
                rawResponse: error,
                allowRetry: false
            });
        }

        yield this.doneEvent();
    }
}

async function streamToBuffer(stream: ReadStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// Add these imports at the top of base.ts


interface AuthBearer {
    value: string;
}

function findAccessKey(options: {
    accessKey: string;
    apiKey: string;
}): string | undefined {
    const { accessKey, apiKey } = options;

    if (accessKey) {
        return accessKey;
    }

    const envPoeAccessKey = process.env.POE_ACCESS_KEY;
    if (envPoeAccessKey) {
        return envPoeAccessKey;
    }

    if (apiKey) {
        console.warn(
            "usage of api_key is deprecated, pass your key using access_key instead"
        );
        return apiKey;
    }

    const envPoeApiKey = process.env.POE_API_KEY;
    if (envPoeApiKey) {
        console.warn(
            "usage of POE_API_KEY is deprecated, pass your key using POE_ACCESS_KEY instead"
        );
        return envPoeApiKey;
    }

    return undefined;
}

function verifyAccessKey(options: {
    accessKey: string;
    apiKey: string;
    allowWithoutKey?: boolean;
}): string | undefined {
    const { accessKey, apiKey, allowWithoutKey = false } = options;
    const _accessKey = findAccessKey({ accessKey, apiKey });

    if (!_accessKey) {
        if (allowWithoutKey) {
            return undefined;
        }
        console.error(
            "Please provide an access key.\n" +
            "You can get a key from the create_bot page at: https://poe.com/create_bot?server=1\n" +
            "You can then pass the key using the access_key param to the run() or make_app() " +
            "functions, or by using the POE_ACCESS_KEY environment variable."
        );
        exit(1);
    }

    if (_accessKey.length !== 32) {
        console.error("Invalid access key (should be 32 characters)");
        exit(1);
    }

    return _accessKey;
}

async function addRoutesForBot(app: FastifyInstance, bot: PoeBot): Promise<void> {
    const indexHandler = async (
        _request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> => {
        const url = "https://poe.com/create_bot?server=1";
        const html = `
      <html>
        <body>
          <h1>FastAPI Poe bot server</h1>
          <p>
            Congratulations! Your server is running. To connect it to Poe, create a bot at 
            <a href="${url}">${url}</a>.
          </p>
        </body>
      </html>
    `;
        reply.type('text/html').send(html);
    };

    const authUser = async (request: FastifyRequest): Promise<void> => {
        if (!bot.accessKey) return;

        const auth = request.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== bot.accessKey) {
            throw { statusCode: 401, message: 'Invalid access key' };
        }
    };

    const poePost = async (
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> => {
        await authUser(request);

        const requestBody = request.body as any;
        requestBody.http_request = request;

        switch (requestBody.type) {
            case 'query':
                const queryRequest = {
                    ...requestBody,
                    access_key: bot.accessKey || '<missing>',
                    api_key: bot.accessKey || '<missing>'
                };
                return reply.sse(bot.handleQuery(queryRequest, { http_request: request }));

            case 'settings':
                const settings = await bot.handleSettings(
                    requestBody,
                    { http_request: request }
                );
                return reply.send(settings);

            case 'report_feedback':
                const feedback = await bot.handleReportFeedback(
                    requestBody,
                    { http_request: request }
                );
                return reply.send(feedback);

            case 'report_reaction':
                const reaction = await bot.handleReportReaction(
                    requestBody,
                    { http_request: request }
                );
                return reply.send(reaction);

            case 'report_error':
                const error = await bot.handleReportError(
                    requestBody,
                    { http_request: request }
                );
                return reply.send(error);

            default:
                throw { statusCode: 501, message: 'Unsupported request type' };
        }
    };

    app.get(bot.path, indexHandler);
    app.post(bot.path, poePost);
}

export function makeApp(
    bot: PoeBot | PoeBot[],
    options: {
        accessKey?: string;
        botName?: string;
        apiKey?: string;
        allowWithoutKey?: boolean;
        app?: FastifyInstance;
    } = {}
): FastifyInstance {
    const {
        accessKey = '',
        botName = '',
        apiKey = '',
        allowWithoutKey = false,
        app = fastify({ logger: true })
    } = options;

    // Register plugins
    app.register(FastifySSEPlugin);
    app.register(cors);

    // Error handler
    app.setErrorHandler(async (error, request, reply) => {
        request.log.error(error);
        return reply.status(error.statusCode || 500).send({
            error: error.message || 'Internal Server Error'
        });
    });

    const bots = Array.isArray(bot) ? bot : [bot];

    // Validate bots and access keys
    if (bots.length === 1 && !Array.isArray(bot)) {
        const singleBot = bots[0];
        if (!singleBot.accessKey) {
            singleBot.accessKey = verifyAccessKey({
                accessKey,
                apiKey,
                allowWithoutKey
            });
        } else if (accessKey || apiKey) {
            throw new Error(
                "Cannot provide access_key if the bot object already has an access key"
            );
        }

        if (!singleBot.botName) {
            singleBot.botName = botName;
        } else if (botName) {
            throw new Error(
                "Cannot provide bot_name if the bot object already has a bot_name"
            );
        }
    } else {
        if (accessKey || apiKey || botName) {
            throw new Error(
                "When serving multiple bots, the access_key/bot_name must be set on each bot"
            );
        }
    }

    // Ensure paths are unique
    const pathToBots = new Map<string, PoeBot[]>();
    for (const botInstance of bots) {
        const existingBots = pathToBots.get(botInstance.path) || [];
        pathToBots.set(botInstance.path, [...existingBots, botInstance]);
    }

    for (const [path, botsOfPath] of pathToBots.entries()) {
        if (botsOfPath.length > 1) {
            throw new Error(
                `Multiple bots are trying to use the same path: ${path}: ${botsOfPath}. ` +
                "Please use a different path for each bot."
            );
        }
    }

    // Add routes for each bot
    bots.forEach(async (botInstance) => {
        if (!botInstance.accessKey && !allowWithoutKey) {
            throw new Error(`Missing access key on ${botInstance}`);
        }
        await addRoutesForBot(app, botInstance);

        // Sync bot settings
        if (!botInstance.botName || !botInstance.accessKey) {
            console.warn("\n************* Warning *************");
            console.warn(
                "Bot name or access key is not set for PoeBot.\n" +
                "Bot settings will NOT be synced automatically on server start/update." +
                "Please remember to sync bot settings manually.\n\n" +
                "For more information, see: https://creator.poe.com/docs/server-bots-functional-guides#updating-bot-settings"
            );
            console.warn("************* Warning *************\n");
        } else {
            try {
                const settingsResponse = await botInstance.getSettings({
                    version: PROTOCOL_VERSION,
                    type: "settings"
                });

                const response = await fetch(
                    `https://api.poe.com/bot/update_settings/${botInstance.botName}/${botInstance.accessKey}/${PROTOCOL_VERSION}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(settingsResponse)
                    }
                );

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
            } catch (error) {
                console.error("\n*********** Error ***********");
                console.error(
                    `Bot settings sync failed for ${botInstance.botName}: \n${error}\n\n`
                );
                console.error("Please sync bot settings manually.\n\n");
                console.error(
                    "For more information, see: https://creator.poe.com/docs/server-bots-functional-guides#updating-bot-settings"
                );
                console.error("\n*********** Error ***********");
            }
        }
    });

    return app;
}

export function run(
    bot: PoeBot | PoeBot[],
    options: {
        accessKey?: string;
        apiKey?: string;
        allowWithoutKey?: boolean;
        app?: FastifyInstance;
    } = {}
): void {
    const app = makeApp(bot, options);

    // Parse command line arguments
    const args = argv.slice(2);
    let port = 8080;
    const portIndex = args.indexOf('-p');
    if (portIndex !== -1 && args[portIndex + 1]) {
        port = parseInt(args[portIndex + 1], 10);
    }

    // Configure logging
    const logger = app.log;
    logger.info("Starting");

    // Start the server
    app.listen({ port, host: '0.0.0.0' }, (err) => {
        if (err) {
            logger.error(err);
            exit(1);
        }
        logger.info(`Server is running on port ${port}`);
    });
}