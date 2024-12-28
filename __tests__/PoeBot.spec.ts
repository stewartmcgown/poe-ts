import { PoeBot } from '../src/lib/base';
import { QueryRequest, ProtocolMessage } from '../src/lib/types';

describe('PoeBot', () => {
    let bot: PoeBot;

    beforeEach(() => {
        bot = new PoeBot({
            accessKey: 'test_key_32_characters_long_test',
            path: '/',
            botName: 'TestBot'
        });
    });

    describe('Basic Functionality', () => {
        test('should initialize with correct properties', () => {
            expect(bot.path).toBe('/');
            expect(bot.accessKey).toBe('test_key_32_characters_long_test');
            expect(bot.botName).toBe('TestBot');
            expect(bot.shouldInsertAttachmentMessages).toBe(true);
            expect(bot.concatAttachmentsToMessage).toBe(false);
        });

        test('should generate basic text event', () => {
            const event = bot['textEvent']('Hello');
            expect(event).toEqual({
                data: JSON.stringify({ text: 'Hello' }),
                event: 'text'
            });
        });
    });

    describe('Message Processing', () => {
        const mockQuery: QueryRequest = {
            version: '1.0',
            type: 'query',
            query: [
                {
                    role: 'user',
                    content: 'Hello',
                    attachments: []
                }
            ],
            user_id: 'test_user',
            conversation_id: 'test_conv',
            message_id: 'test_message'
        };

        test('should process basic query without attachments', async () => {
            const events = [];
            for await (const event of bot.handleQuery(mockQuery, { http_request: {} as any })) {
                events.push(event);
            }

            expect(events).toHaveLength(2); // text event + done event
            expect(events[0]).toEqual({
                data: JSON.stringify({ text: 'hello' }),
                event: 'text'
            });
            expect(events[1]).toEqual({
                data: '{}',
                event: 'done'
            });
        });

        test('should handle attachment messages', async () => {
            const queryWithAttachment: QueryRequest = {
                ...mockQuery,
                query: [{
                    role: 'user',
                    content: 'Check this document',
                    attachments: [{
                        url: 'test.txt',
                        content_type: 'text/plain',
                        name: 'test.txt',
                        parsed_content: 'Test content'
                    }]
                }]
            };

            const processed = bot.insertAttachmentMessages(queryWithAttachment);
            expect(processed.query).toHaveLength(2); // Original message + attachment message
            expect(processed.query[0].content).toContain('Test content');
        });
    });

    describe('Error Handling', () => {
        test('should handle errors gracefully', async () => {
            bot.getResponse = async function* () {
                throw new Error('Test error');
            };

            const events = [];
            for await (const event of bot.handleQuery({
                version: '1.0',
                type: 'query',
                query: [],
                user_id: 'test',
                conversation_id: 'test',
                message_id: 'test'
            }, { http_request: {} as any })) {
                events.push(event);
            }

            expect(events).toHaveLength(2); // error event + done event
            expect(events[0].event).toBe('error');
            expect(JSON.parse(events[0].data)).toHaveProperty('text');
            expect(events[1].event).toBe('done');
        });
    });
});