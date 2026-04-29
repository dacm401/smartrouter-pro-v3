// 直接用 HTTP 测 /api/chat
const http = require('http');

const body = JSON.stringify({ message: 'hi', stream: false });

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
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => {
        console.log('HTTP', res.statusCode);
        console.log('Response:', data.slice(0, 500));
    });
});
req.on('error', e => console.log('req error:', e.message));
req.setTimeout(30000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
