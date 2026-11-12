// Vercel serverless entry: POST /api/studio?action=join|poll|send|leave, GET /api/studio?action=config
const { handle } = require('../lib/studio');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query?.action || '');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
  try {
    res.status(200).json(await handle(action, body || {}));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: status === 500 ? 'Server error. Try again in a moment.' : e.message });
  }
};
