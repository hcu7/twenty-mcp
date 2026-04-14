import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TwentyClient } from './twenty-client.js';
import { registerAllTools } from './tools.js';

const PORT = parseInt(process.env.PORT || '3000');
const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
const TWENTY_BASE_URL = process.env.TWENTY_BASE_URL;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';

// OAuth2: issued access tokens (code → token)
interface CodeEntry { expiry: number; challenge: string; method: string; }
const oauthCodes = new Map<string, CodeEntry>();
const oauthTokens = new Set<string>();          // valid access tokens

function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
  if (!challenge) return true;
  if (method === 'S256') {
    const computed = createHash('sha256').update(verifier).digest('base64url');
    return computed === challenge;
  }
  if (method === '' || method === 'plain') return verifier === challenge;
  return false;
}

// Audit logging
function auditLog(event: Record<string, unknown>): void {
  const record = { ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), svc: 'twenty-mcp', ...event };
  console.log(`[MCP-AUDIT] ${JSON.stringify(record)}`);
}

if (!TWENTY_API_KEY) {
  console.error('TWENTY_API_KEY environment variable is required');
  process.exit(1);
}
if (!TWENTY_BASE_URL) {
  console.error('TWENTY_BASE_URL environment variable is required');
  process.exit(1);
}

function isInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
  const ipNum = ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
  const rangeNum = range.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
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

  // OAuth 2.0 discovery endpoints (for Cowork/Claude auto-discovery)
  if (OAUTH_CLIENT_ID) {
    const host = req.headers.host || '';
    const base = host ? `https://${host}` : '';
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256', 'plain'],
        scopes_supported: ['mcp'],
      }));
      return;
    }
    if (req.url === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        resource: base,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
      }));
      return;
    }
    if (req.url === '/register' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }));
      return;
    }
  }

  // OAuth2 Authorization endpoint
  if (req.url?.startsWith('/authorize') && OAUTH_CLIENT_ID) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') || '';
    const challenge = url.searchParams.get('code_challenge') || '';
    const challengeMethod = url.searchParams.get('code_challenge_method') || (challenge ? 'plain' : '');

    if (clientId !== OAUTH_CLIENT_ID || !redirectUri) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }

    const code = randomUUID();
    oauthCodes.set(code, { expiry: Date.now() + 60_000, challenge, method: challengeMethod });
    const host = req.headers.host || '';
    const issuer = host ? `https://${host}` : '';
    const redirect = `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(issuer)}`;
    res.writeHead(302, { Location: redirect });
    res.end();
    return;
  }

  // OAuth2 Token endpoint
  if (req.url === '/token' && req.method === 'POST' && OAUTH_CLIENT_ID) {
    const body = await getBody(req);
    const params = new URLSearchParams(body);
    const grantType = params.get('grant_type');
    const clientId = params.get('client_id');
    const clientSecret = params.get('client_secret') || '';
    const code = params.get('code') || '';
    const codeVerifier = params.get('code_verifier') || '';

    // Require client_secret; PKCE remains supported as optional additional layer
    if (clientId !== OAUTH_CLIENT_ID) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }
    if (!clientSecret || clientSecret !== OAUTH_CLIENT_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }

    if (grantType === 'authorization_code' && code) {
      const entry = oauthCodes.get(code);
      if (!entry || Date.now() > entry.expiry) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      oauthCodes.delete(code);
      if (entry.challenge && !verifyPKCE(codeVerifier, entry.challenge, entry.method)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
    }

    const accessToken = randomUUID();
    oauthTokens.add(accessToken);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer' }));
    return;
  }

  // MCP endpoint
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Auth: Bearer token OR OAuth2 access token (no IP bypass)
  const clientIp = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim();
  let authMethod = 'none';
  {
    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const hasValidMcpToken = MCP_AUTH_TOKEN && token === MCP_AUTH_TOKEN;
    const hasValidOauthToken = oauthTokens.has(token);
    if (hasValidMcpToken) authMethod = 'bearer';
    else if (hasValidOauthToken) authMethod = 'oauth';

    if (authMethod === 'none') {
      const reason = !auth ? 'no_auth_header' : !auth.startsWith('Bearer ') ? 'not_bearer_scheme' : !token ? 'empty_token' : 'unknown_token';
      auditLog({ event: 'mcp_request', ip: clientIp, method: req.method, result: '401_unauthorized', reason, token_len: token.length, tokens_issued: oauthTokens.size });
      const host = req.headers.host || '';
      const metaUrl = host ? `https://${host}/.well-known/oauth-protected-resource` : '';
      const wwwAuth = `Bearer realm="mcp", resource_metadata="${metaUrl}"`;
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuth });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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

      // Audit log
      if (body && typeof body === 'object') {
        const info: Record<string, unknown> = {
          event: 'mcp_call', ip: clientIp, auth: authMethod,
          size: bodyText.length, rpc_method: body.method,
        };
        const params = body.params || {};
        if (body.method === 'tools/call') {
          info.tool = params.name;
          const args = params.arguments || {};
          info.arg_keys = typeof args === 'object' && args ? Object.keys(args).sort() : [];
        } else if (body.method === 'initialize') {
          info.client = (params.clientInfo || {}).name || '?';
        }
        auditLog(info);
      }

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
