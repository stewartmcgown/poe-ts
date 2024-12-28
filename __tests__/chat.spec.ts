import { PoeBot } from '../src/lib/base';
import { QueryRequest } from '../src/lib/types';
import { makeApp } from '../src/lib/base'
import fastify from "fastify";

describe('PoeBot', () => {

    class MyBot extends PoeBot {
        async *getResponse(request: QueryRequest) {
            // Your bot logic here
            yield this.textEvent("Hello, I'm your bot!");
        }
    }


    const bot = new MyBot({
        accessKey: process.env.POE_ACCESS_KEY,
        path: "/",
        botName: "MyAwesomeBot"
    });

    const app = makeApp(bot)

    test('should generate basic text event', async() => {
        await app.inject({
            method: 'POST',
            url: '/',
            headers: {
                'Authorization': 'Bearer ' + process.env.POE_ACCESS_KEY
            },
            payload: {
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
            }
        }).then((response) => {
            expect(response.statusCode).toBe(200)
            expect(response.body).toMatchInlineSnapshot(`
"retry: 3000

id: 1
event: text
data: {"text":"Hello, I'm your bot!"}

id: 1
event: done
data: {}

"
`)
        })
    })
})