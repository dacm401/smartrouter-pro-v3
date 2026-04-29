const https = require('https');

const KEY = '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';

function httpsGet(host, path, headers = {}) {
    return new Promise((resolve) => {
        const options = { hostname: host, path, method: 'GET', headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
        req.end();
    });
}

async function main() {
    const r = await httpsGet('openrouter.ai', '/api/v1/models', {
        'Authorization': `Bearer ${KEY}`
    });
    if (r.error) { console.log(r.error); return; }
    const models = JSON.parse(r.data).data || [];
    console.log(`Total models: ${models.length}`);

    // 找所有 qwen 72B
    const qwen72 = models.filter(m => {
        const id = m.id.toLowerCase();
        return id.includes('qwen') && id.includes('72b') && (id.includes('instruct') || id.includes('chat'));
    });
    console.log('\nQwen 72B models:');
    qwen72.forEach(m => console.log(' ', m.id));

    // 也搜 qwen3
    const qwen3 = models.filter(m => m.id.toLowerCase().includes('qwen3'));
    console.log('\nQwen3 models:');
    qwen3.forEach(m => console.log(' ', m.id));
}

main();
