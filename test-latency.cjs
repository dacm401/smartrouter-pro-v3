const http = require('http');

function request(msg, history = []) {
    return new Promise((resolve) => {
        const body = JSON.stringify({ message: msg, stream: false, history });
        const opts = {
            hostname: 'localhost', port: 3001, path: '/api/chat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'X-User-Id': 'test-user'
            }
        };
        const t = Date.now();
        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                const ms = Date.now() - t;
                const parsed = JSON.parse(data);
                console.log(`"${msg}" -> ${ms}ms | decision=${parsed.decision_type} | content="${parsed.content?.slice(0,40)}"`);
                resolve(ms);
            });
        });
        req.on('error', e => { console.log('ERROR:', e.message); resolve(99999); });
        req.setTimeout(60000, () => { console.log(`"${msg}" -> TIMEOUT 60s`); req.destroy(); resolve(99999); });
        req.write(body);
        req.end();
    });
}

(async () => {
    console.log('=== OpenRouter 响应延迟测试 ===\n');
    const r1 = await request('你好');
    const r2 = await request('1+1等于几');
    console.log('\n两个请求平均延迟:', Math.round((r1+r2)/2), 'ms');
})();
