// Vercel serverless entry: POST /api/ai (assistant stream, AI thumbnails, stream voice).
const { handleAI } = require('../lib/ai');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Use POST.'); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
  await handleAI(req, res, body || {});
};

