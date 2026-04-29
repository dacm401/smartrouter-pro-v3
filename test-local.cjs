const http = require('http');

function httpGet(path) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: 3001,
            path: path,
            method: 'GET',
            headers: { 'X-User-Id': 'test-user' }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, data: data.slice(0, 300) }));
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.setTimeout(5000, () => resolve({ error: 'TIMEOUT' }));
        req.end();
    });
}

async function main() {
    const r1 = await httpGet('/health');
    console.log('/health:', r1.error || `HTTP ${r1.status} - ${r1.data}`);
}

main();
