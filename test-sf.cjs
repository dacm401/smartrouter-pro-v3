// 测试两条不同消息，看哪条触发错误
const http = require('http');

function httpPost(path, body) {
    return new Promise((resolve) => {
        const b = JSON.stringify(body);
        const opts = {
            hostname: 'localhost', port: 3001, path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'X-User-Id': 'test' }
        };
        const req = http.request(opts, (res) => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, data: d }));
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
        req.write(b);
        req.end();
    });
}

async function main() {
    const tests = [
        { msg: 'hi' },
        { msg: '明天天气如何' }
    ];
    for (const t of tests) {
        const r = await httpPost('/api/chat', { message: t.msg, stream: false });
        if (r.error) {
            console.log(`"${t.msg}": ERROR ${r.error}`);
        } else {
            try {
                const parsed = JSON.parse(r.data);
                console.log(`"${t.msg}": HTTP ${r.status} -> decision=${parsed.decision_type}, error=${parsed.error ? parsed.error.slice(0,80) : 'none'}`);
            } catch {
                console.log(`"${t.msg}": HTTP ${r.status}, raw: ${r.data.slice(0,200)}`);
            }
        }
    }
}
main();
