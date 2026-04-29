// 测试 SSE 流式请求
const http = require('http');

const body = JSON.stringify({ message: '你好', stream: true });

const opts = {
    hostname: 'localhost', port: 3001, path: '/api/chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-User-Id': 'test-user'
    }
};

const req = http.request(opts, (res) => {
    console.log('HTTP', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers));
    let count = 0;
    res.on('data', (chunk) => {
        count++;
        console.log(`[chunk ${count}]`, chunk.toString().slice(0, 200));
    });
    res.on('end', () => console.log('Done, total chunks:', count));
});
req.on('error', (e) => console.log('req error:', e.message));
req.setTimeout(30000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
