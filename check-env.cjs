console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.slice(0, 8) + '...' : 'EMPTY');
console.log('OPENAI_BASE_URL:', process.env.OPENAI_BASE_URL || '(none)');
console.log('FAST_MODEL:', process.env.FAST_MODEL || '(none)');
