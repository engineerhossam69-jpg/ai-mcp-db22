import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  AUTH_SECRET: string;
};

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const app = new Hono<{ Bindings: Bindings }>();
const MAX_BODY_SIZE = 64 * 1024;
const MAX_BATCH_SIZE = 10;
const MAX_BATCH_CONCURRENCY = 5;
const D1_TIMEOUT_MS = 5_000;

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86_400,
  }),
);

app.get('/', (c) => c.json({ name: 'akashic-memory-mcp', endpoint: '/mcp' }));

app.post('/mcp', async (c) => {
  const secret = c.env.AUTH_SECRET;
  if (!secret) {
    return c.json({ error: 'Server authentication is not configured' }, 503);
  }
  if (c.req.header('Authorization') !== `Bearer ${secret}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await readJsonBody(c.req.raw, MAX_BODY_SIZE);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return c.json({ error: 'Payload too large; maximum request size is 64 KB' }, 413);
    }
    return c.json({ error: 'Request body must contain valid JSON' }, 400);
  }

  if (Array.isArray(body) && (body.length === 0 || body.length > MAX_BATCH_SIZE)) {
    return c.json({ error: `JSON-RPC batch must contain 1 to ${MAX_BATCH_SIZE} requests` }, 400);
  }

  const handle = (request: unknown): Promise<JsonRpcResponse | undefined> =>
    handleJsonRpc(request, c.env.DB, c.executionCtx);

  if (Array.isArray(body)) {
    const responses = await processWithLimit(body, MAX_BATCH_CONCURRENCY, handle);
    const filtered = responses.filter((response): response is JsonRpcResponse => response !== undefined);
    return filtered.length === 0 ? c.body(null, 202) : c.json(filtered);
  }

  const response = await handle(body);
  return response === undefined ? c.body(null, 202) : c.json(response);
});

app.all('/mcp', (c) => c.json({ error: 'Method not allowed' }, 405));
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default app;

async function handleJsonRpc(
  value: unknown,
  db: D1Database,
  executionCtx: ExecutionContext,
): Promise<JsonRpcResponse | undefined> {
  if (!isJsonRpcRequest(value)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }

  const id = value.id ?? null;
  if (value.method === 'notifications/initialized' || value.method.startsWith('notifications/')) {
    return undefined;
  }

  if (value.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'akashic-memory-mcp', version: '1.0.0' },
      },
    };
  }

  if (value.method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (value.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'store_memory',
            description: 'Store a JSON analysis in the user\'s Akashic memory log.',
            inputSchema: {
              type: 'object',
              properties: {
                user_id: { type: 'string', minLength: 1 },
                analysis_json: { type: 'string', description: 'Serialized JSON analysis' },
              },
              required: ['user_id', 'analysis_json'],
              additionalProperties: false,
            },
          },
          {
            name: 'get_memory',
            description: 'Get the latest five memory records for a user.',
            inputSchema: {
              type: 'object',
              properties: { user_id: { type: 'string', minLength: 1 } },
              required: ['user_id'],
              additionalProperties: false,
            },
          },
        ],
      },
    };
  }

  if (value.method === 'tools/call') {
    const name = value.params?.name;
    const args = value.params?.arguments;

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid tool arguments' } };
    }

    const userId = args.user_id;
    if (typeof userId !== 'string' || userId.trim().length === 0 || userId.length > 200) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'user_id must be a non-empty string of at most 200 characters' } };
    }

    if (name === 'store_memory') {
      const analysisJson = args.analysis_json;
      if (typeof analysisJson !== 'string' || analysisJson.length === 0) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'analysis_json must be a non-empty string' } };
      }

      // waitUntil keeps the Worker alive for the write; it is best-effort background work,
      // not a durable queue. The client receives an acceptance response without waiting for D1.
      const write = withTimeout(
        db.prepare('INSERT INTO akashic_log (user_id, analysis_json) VALUES (?, ?)')
          .bind(userId, analysisJson)
          .run(),
        D1_TIMEOUT_MS,
        'D1 insert timed out',
      );
      executionCtx.waitUntil(write.catch((error) => console.error('store_memory failed:', error)));

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'Memory write accepted for background processing.' }],
          isError: false,
        },
      };
    }

    if (name === 'get_memory') {
      try {
        const result = await withTimeout(
          db.prepare(
            'SELECT id, user_id, analysis_json, created_at FROM akashic_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 5',
          ).bind(userId).all<MemoryRecord>(),
          D1_TIMEOUT_MS,
          'D1 query timed out',
        );
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result.results) }],
            structuredContent: { memories: result.results },
            isError: false,
          },
        };
      } catch (error) {
        console.error('get_memory failed:', error);
        return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Unable to retrieve memories' } };
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name ?? '')}` } };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

type MemoryRecord = {
  id: number;
  user_id: string;
  analysis_json: string;
  created_at: string;
};

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.jsonrpc === '2.0' && typeof request.method === 'string' &&
    (!('id' in request) || request.id === null || typeof request.id === 'string' || typeof request.id === 'number') &&
    (!('params' in request) || (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)));
}

class PayloadTooLargeError extends Error {}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) throw new PayloadTooLargeError();
  if (!request.body) throw new SyntaxError('Empty body');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function processWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
