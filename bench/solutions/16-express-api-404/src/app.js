import express from 'express';

export const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));

app.all('/api/*rest', (req, res) => res.status(404).json({ error: 'not found', path: req.path }));
