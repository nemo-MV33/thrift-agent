import express from 'express';

export const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/files/*filepath', (req, res) => {
  res.json({ path: req.params.filepath.join('/') });
});
