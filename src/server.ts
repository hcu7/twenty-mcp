import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TwentyClient } from './twenty-client.js';
import { registerAllTools } from './tools.js';

const PORT = parseInt(process.env.PORT || '3000');
const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
const TWENTY_BASE_URL = process.env.TWENTY_BASE_URL;

if (!TWENTY_API_KEY) {
  console.error('TWENTY_API_KEY environment variable is required');
  process.exit(1);
}
if (!TWENTY_BASE_URL) {
  console.error('TWENTY_BASE_URL environment variable is required');
  process.exit(1);
}

const client = new TwentyClient({
  apiKey: TWENTY_API_KEY,
  baseUrl: TWENTY_BASE_URL,
});

// Session management: keep transports alive across requests
const sessions = new Map<string, StreamableHTTPServerTransport>();

async function createSession(): Promise<StreamableHTTPServerTransport> {
  const server = new McpServer({
    name: 'twenty-mcp',
    version: '1.0.0',
  });

  registerAllTools(server, client);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) sessions.delete(sessionId);
  };

  await server.connect(transport);
  return transport;
}

function getBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', service: 'twenty-mcp', sessions: sessions.size }));
    return;
  }

  // MCP endpoint
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      // Reuse existing session
      transport = sessions.get(sessionId)!;
    } else if (req.method === 'POST' && !sessionId) {
      // New session (initialize request)
      transport = await createSession();
    } else if (sessionId) {
      // Session expired/unknown
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session ID' }));
      return;
    }

    if (req.method === 'POST') {
      const bodyText = await getBody(req);
      const body = bodyText.trim() ? JSON.parse(bodyText) : undefined;
      await transport.handleRequest(req, res, body);
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
    }

    // Store session after first successful request
    if (transport.sessionId && !sessions.has(transport.sessionId)) {
      sessions.set(transport.sessionId, transport);
    }
  } catch (error) {
    console.error('Server error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`Twenty MCP Server running at http://localhost:${PORT}/mcp`);
  console.log(`Health check at http://localhost:${PORT}/health`);
  console.log(`Connected to Twenty at ${TWENTY_BASE_URL}`);
});
