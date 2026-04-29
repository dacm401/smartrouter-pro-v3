const https = require('https');
const key = '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';

const models = [
    'qwen/qwen-2.5-72b-instruct',
    'qwen/qwen3.5-122b-a10b',
    'meta-llama/llama-3.3-70b-instruct',
    'nousresearch/hermes-3-llama-3.1-70b',
];

(async () => {
    for (const model of models) {
        const body = JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 20,
            temperature: 0.3
        });
        const req = await new Promise((resolve) => {
            const r = https.request({
                hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => resolve({ status: res.statusCode, data: d }));
            });
            r.on('error', e => resolve({ error: e.message }));
            r.setTimeout(20000, () => resolve({ error: 'TIMEOUT' }));
            r.write(body);
            r.end();
        });
        if (req.error) {
            console.log(`${model}: ERROR ${req.error}`);
        } else if (req.status !== 200) {
            const err = JSON.parse(req.data);
            console.log(`${model}: HTTP ${req.status} - ${err.error?.message}`);
        } else {
            const p = JSON.parse(req.data);
            console.log(`${model}: ✅ ${p.choices?.[0]?.message?.content}`);
        }
    }
})();
