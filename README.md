Here's a comprehensive README.md for the project:

```markdown
# Poe Bot TypeScript Server Framework

A robust TypeScript framework for building and deploying chatbots on [Poe](https://poe.com). This framework provides a complete server implementation for creating custom bots that can interact with users through the Poe platform.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-16+-green.svg)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.0-orange.svg)](https://www.fastify.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 🚀 Features

- Full TypeScript support with comprehensive type definitions
- Server-Sent Events (SSE) for real-time communication
- File attachment handling
- Cost management and tracking
- Authentication and authorization
- CORS support
- Comprehensive error handling
- Automatic settings synchronization
- Support for multiple bots
- Easy-to-use API
- Extensive test coverage

## 📋 Prerequisites

- Node.js 16 or higher
- npm or yarn
- TypeScript 4.5+

## 🛠 Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/poe-bot-typescript.git

# Install dependencies
npm install

# Build the project
npm run build
```

## 🏃‍♂️ Quick Start

1. Create a new bot class:

```typescript
import { PoeBot } from './base';
import { QueryRequest } from './types';

class MyBot extends PoeBot {
  async *getResponse(request: QueryRequest) {
    // Your bot logic here
    yield this.textEvent("Hello, I'm your bot!");
  }
}
```

2. Set up the server:

```typescript
import { run } from './base';

const bot = new MyBot({
  accessKey: process.env.POE_ACCESS_KEY,
  path: "/",
  botName: "MyAwesomeBot"
});

run(bot);
```

3. Start the server:

```bash
npm start
```

## 🔧 Configuration

### Environment Variables

- `POE_ACCESS_KEY`: Your Poe access key (required)
- `PORT`: Server port (default: 8080)
- `NODE_ENV`: Environment (development/production)

### Bot Settings

```typescript
const bot = new PoeBot({
  accessKey: "your_access_key",  // Required, 32 characters
  path: "/",                     // API endpoint path
  botName: "MyBot",             // Bot name on Poe
  shouldInsertAttachmentMessages: true,  // Handle attachments
  concatAttachmentsToMessage: false      // Concatenate attachments
});
```

## 📝 API Reference

### PoeBot Class

Base class for creating bots:

```typescript
class MyBot extends PoeBot {
  // Required: Handle incoming messages
  async *getResponse(request: QueryRequest) {
    yield this.textEvent("Hello!");
  }

  // Optional: Custom settings
  async getSettings(settings: SettingsRequest): Promise<SettingsResponse> {
    return {
      allow_attachments: true,
      introduction_message: "Hello, I'm a bot!"
    };
  }

  // Optional: Handle feedback
  async onFeedback(feedback: ReportFeedbackRequest) {
    console.log("Received feedback:", feedback);
  }
}
```

### Events

Available event types:

- `textEvent`: Regular text messages
- `replaceResponseEvent`: Replace previous response
- `suggestedReplyEvent`: Suggest user replies
- `metaEvent`: Metadata and settings
- `errorEvent`: Error handling
- `doneEvent`: End of response

### File Attachments

Handle file uploads and downloads:

```typescript
await bot.postMessageAttachment({
  messageId: "msg_id",
  fileData: fileStream,
  filename: "document.pdf",
  contentType: "application/pdf"
});
```

### Cost Management

Track and manage costs:

```typescript
await bot.captureCost(request, {
  amount_usd_milli_cents: 1000,
  description: "API usage"
});
```

## 🧪 Testing

The framework includes tests:

```bash
# Run tests
pnpm test
```

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🚀 Deployment

### Heroku

```bash
heroku create
git push heroku main
```

### Docker

```bash
docker build -t poe-bot .
docker run -p 8080:8080 poe-bot
```

### Custom Server

```bash
npm run build
npm start
```

## ⚠️ Common Issues

1. **Authentication Errors**
   - Verify your access key
   - Check environment variables

2. **Connection Issues**
   - Ensure proper network configuration
   - Verify server is running

3. **Type Errors**
   - Update TypeScript version
   - Check type definitions

## 🎯 Roadmap

- [ ] WebSocket support
- [ ] Database integration
- [ ] Admin dashboard
- [ ] Analytics integration
- [ ] Multi-language support
