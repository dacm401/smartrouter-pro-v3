const https = require('https');

const KEY = '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';

function httpsPost(host, path, body, headers = {}) {
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve) => {
        const options = {
            hostname: host, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, data: data.slice(0, 800) }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
        req.end(bodyStr);
    });
}

async function main() {
    console.log('测试 qwen/qwen-2.5-72b-instruct...\n');
    const start = Date.now();
    const r = await httpsPost('openrouter.ai', '/api/v1/chat/completions', {
        model: 'qwen/qwen-2.5-72b-instruct',
        messages: [{ role: 'user', content: '用一句话解释量子计算的基本原理' }],
        max_tokens: 50
    }, {
        'Authorization': `Bearer ${KEY}`,
        'HTTP-Referer': 'https://smartrouter.local',
        'X-Title': 'SmartRouter Pro'
    });
    console.log(`耗时: ${Date.now() - start}ms`);
    if (r.error) {
        console.log('ERROR:', r.error);
    } else {
        console.log('HTTP', r.status);
        console.log('Response:', r.data);
    }
}

main();
