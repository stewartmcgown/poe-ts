import {FastifyRequest} from "fastify";

type Identifier = string;
type FeedbackType = "like" | "dislike";
type ContentType = "text/markdown" | "text/plain";
type ErrorType = "user_message_too_long" | "insufficient_fund";

interface MessageFeedback {
    type: FeedbackType;
    reason?: string;
}

interface CostItem {
    amount_usd_milli_cents: number;
    description?: string;
}

interface Attachment {
    url: string;
    content_type: string;
    name: string;
    parsed_content?: string;
}

interface ProtocolMessage {
    role: "system" | "user" | "bot";
    sender_id?: string;
    content: string;
    content_type?: ContentType;
    timestamp?: number;
    message_id?: string;
    feedback?: MessageFeedback[];
    attachments?: Attachment[];
}

interface RequestContext {
    http_request: FastifyRequest;
}

interface BaseRequest {
    version: string;
    type: "query" | "settings" | "report_feedback" | "report_reaction" | "report_error";
}

interface QueryRequest extends BaseRequest {
    query: ProtocolMessage[];
    user_id: Identifier;
    conversation_id: Identifier;
    message_id: Identifier;
    metadata?: Identifier;
    api_key?: string;
    access_key?: string;
    temperature?: number;
    skip_system_prompt?: boolean;
    logit_bias?: Record<string, number>;
    stop_sequences?: string[];
    language_code?: string;
    bot_query_id?: Identifier;
}

interface SettingsRequest extends BaseRequest {}

interface ReportFeedbackRequest extends BaseRequest {
    message_id: Identifier;
    user_id: Identifier;
    conversation_id: Identifier;
    feedback_type: FeedbackType;
}

interface ReportReactionRequest extends BaseRequest {
    message_id: Identifier;
    user_id: Identifier;
    conversation_id: Identifier;
    reaction: string;
}

interface ReportErrorRequest extends BaseRequest {
    message: string;
    metadata: Record<string, any>;
}

interface SettingsResponse {
    context_clear_window_secs?: number;
    allow_user_context_clear?: boolean;
    server_bot_dependencies?: Record<string, number>;
    allow_attachments?: boolean;
    introduction_message?: string;
    expand_text_attachments?: boolean;
    enable_image_comprehension?: boolean;
    enforce_author_role_alternation?: boolean;
    enable_multi_bot_chat_prompting?: boolean;
    custom_rate_card?: string;
}

interface AttachmentUploadResponse {
    inline_ref?: string;
    attachment_url?: string;
}

interface PartialResponse {
    text: string;
    data?: Record<string, any>;
    raw_response?: any;
    full_prompt?: string;
    request_id?: string;
    is_suggested_reply?: boolean;
    is_replace_response?: boolean;
}

interface ErrorResponse extends PartialResponse {
    allow_retry?: boolean;
    error_type?: ErrorType;
}

interface MetaResponse extends PartialResponse {
    linkify?: boolean;
    suggested_replies?: boolean;
    content_type?: ContentType;
    refetch_settings?: boolean;
}

interface ToolDefinition {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: Record<string, any>;
            required?: string[];
        };
    };
}

interface ToolCallDefinition {
    id: string;
    type: string;
    function: {
        name: string;
        arguments: string;
    };
}

interface ToolResultDefinition {
    role: string;
    name: string;
    tool_call_id: string;
    content: string;
}

export type {
    Identifier,
    FeedbackType,
    ContentType,
    ErrorType,
    MessageFeedback,
    CostItem,
    Attachment,
    ProtocolMessage,
    RequestContext,
    BaseRequest,
    QueryRequest,
    SettingsRequest,
    ReportFeedbackRequest,
    ReportReactionRequest,
    ReportErrorRequest,
    SettingsResponse,
    AttachmentUploadResponse,
    PartialResponse,
    ErrorResponse,
    MetaResponse,
    ToolDefinition,
    ToolCallDefinition,
    ToolResultDefinition
};