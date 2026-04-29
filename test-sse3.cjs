const http = require('http');

const body = JSON.stringify({
    message: '需要怎么具体',
    stream: true,
    history: [
        { role: 'user', content: '明天天气如何' },
        { role: 'assistant', content: '能再具体一点吗？' }
    ]
});

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
        if (res.statusCode !== 200) {
            console.log('Error body:', data.slice(0, 300));
        } else {
            console.log('Chunks:', data.split('\n\n').length);
            console.log(data.slice(0, 400));
        }
    });
});
req.on('error', e => console.log('req error:', e.message));
req.setTimeout(30000, () => { console.log('TIMEOUT'); req.destroy(); });
req.write(body);
req.end();
