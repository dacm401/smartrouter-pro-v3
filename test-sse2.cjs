// 测试 SSE 流式 "明天天气如何"
const http = require('http');

const body = JSON.stringify({ message: '明天天气如何', stream: true });
const opts = {
    hostname: 'localhost', port: 3001, path: '/api/chat',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-User-Id': 'test' }
};

const req = http.request(opts, (res) => {
    let count = 0;
    res.on('data', (chunk) => {
        count++;
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
            if (line.startsWith('data:')) {
                console.log(`[chunk ${count}] ${line.slice(5).trim()}`);
            }
        }
    });
    res.on('end', () => console.log(`\nDone, total chunks: ${count}`));
});
req.on('error', e => console.log('ERROR:', e.message));
req.setTimeout(30000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
