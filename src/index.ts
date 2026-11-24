export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname !== '/mcp') {
      return new Response(JSON.stringify({ error: 'Not Found. Please use /mcp' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    try {
      const body = await readJsonBody(request, MAX_BODY_SIZE);

      if (!Array.isArray(body) && isJsonRpcRequest(body) && body.method === 'notifications/initialized') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (Array.isArray(body) && body.length > MAX_BATCH_SIZE) {
        return jsonResponse({ error: `Batch exceeds maximum of ${MAX_BATCH_SIZE} items` }, 400, corsHeaders);
      }

      const handleRequest = async (req) => {
        if (!isJsonRpcRequest(req)) {
          return {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid Request' }
          };
        }

        if (req.method === 'initialize') {
          return {
            jsonrpc: '2.0', id: req.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'ei-memory-db', version: '1.0.0' }
            }
          };
        }

        if (req.method === 'notifications/initialized') {
          return undefined;
        }

        if (req.method === 'tools/list') {
          return {
            jsonrpc: '2.0', id: req.id,
            result: {
              tools: [
                {
                  name: 'store_memory',
                  description: 'حفظ توقيع لغوي أو معلومة في ذاكرة المستخدم بقاعدة بيانات D1',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      user_id: { type: 'string', description: 'معرف المستخدم' },
                      memory: { type: 'string', description: 'المعلومة أو الكلمة' }
                    },
                    required: ['user_id', 'memory']
                  }
                }
              ]
            }
          };
        }

        if (req.method === 'tools/call') {
          if (req.params?.name === 'store_memory') {
            const { user_id, memory } = req.params.arguments ?? {};
            if (typeof user_id !== 'string' || typeof memory !== 'string') {
              return {
                jsonrpc: '2.0', id: req.id,
                error: { code: -32602, message: 'user_id and memory must be strings' }
              };
            }

            let dbMessage = 'لم يتم العثور على قاعدة البيانات.';
            if (env.DB) {
              try {
                // The memories table is created by migrations/0002_memories.sql, not per request.
                await env.DB.prepare('INSERT INTO memories (user_id, memory) VALUES (?, ?)')
                  .bind(user_id, memory)
                  .run();
                dbMessage = `تم الحفظ بنجاح في قاعدة البيانات D1: ${memory}`;
              } catch (e) {
                dbMessage = `فشل الحفظ في D1: ${e instanceof Error ? e.message : 'Unknown database error'}`;
              }
            }

            return {
              jsonrpc: '2.0', id: req.id,
              result: {
                content: [{ type: 'text', text: dbMessage }]
              }
            };
          }
        }

        return {
          jsonrpc: '2.0', id: req.id,
          error: { code: -32601, message: 'Method not found' }
        };
      };

      let responseData;
      if (Array.isArray(body)) {
        const results = await processWithLimit(body, MAX_CONCURRENCY, handleRequest);
        responseData = results.filter(r => r !== undefined);
        if (responseData.length === 0) return new Response(null, { status: 204, headers: corsHeaders });
      } else {
        responseData = await handleRequest(body);
        if (!responseData) return new Response(null, { status: 204, headers: corsHeaders });
      }

      return jsonResponse(responseData, 200, corsHeaders);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        return jsonResponse({ error: e.message }, 413, corsHeaders);
      }
      if (e instanceof SyntaxError) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
      }
      return jsonResponse({ error: e instanceof Error ? e.message : 'Invalid request' }, 400, corsHeaders);
    }
  }
};

const MAX_BODY_SIZE = 64 * 1024;
const MAX_BATCH_SIZE = 10;
const MAX_CONCURRENCY = 5;

class PayloadTooLargeError extends Error {}

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function readJsonBody(request, maxBytes) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new PayloadTooLargeError('Payload too large');
  }

  if (!request.body) {
    throw new SyntaxError('Request body is empty');
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError('Payload too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function processWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }));

  return results;
}

function isJsonRpcRequest(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    value.jsonrpc === '2.0' && typeof value.method === 'string';
}
