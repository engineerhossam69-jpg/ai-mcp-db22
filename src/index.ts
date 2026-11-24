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

    if (request.method === 'POST') {
      try {
        const body = await request.json();

        if (!Array.isArray(body) && body.method === 'notifications/initialized') {
           return new Response(null, { status: 204, headers: corsHeaders });
        }

        const handleRequest = async (req) => {
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
            if (req.params.name === 'store_memory') {
              const { user_id, memory } = req.params.arguments;
              let dbMessage = "لم يتم العثور على قاعدة البيانات.";
              
              if (env.DB) {
                 try {
                     await env.DB.exec(`CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, memory TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
                     await env.DB.prepare(`INSERT INTO memories (user_id, memory) VALUES (?, ?)`).bind(user_id, memory).run();
                     dbMessage = `تم الحفظ بنجاح في قاعدة البيانات D1: ${memory}`;
                 } catch (e) {
                     dbMessage = `فشل الحفظ في D1: ${e.message}`;
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
           const results = await Promise.all(body.map(handleRequest));
           responseData = results.filter(r => r !== undefined);
           if (responseData.length === 0) return new Response(null, { status: 204, headers: corsHeaders });
        } else {
           responseData = await handleRequest(body);
           if (!responseData) return new Response(null, { status: 204, headers: corsHeaders });
        }

        return new Response(JSON.stringify(responseData), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
