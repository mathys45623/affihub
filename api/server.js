const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'affihub_secret_2024';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── AUTH MIDDLEWARE ──
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin seulement' });
  next();
}

// ── AUTH ROUTES ──
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Champs requis' });
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('users').insert({ name, email, password: hash, role: 'affiliate', balance: 0 }).select().single();
  if (error) return res.status(400).json({ error: 'Email déjà utilisé' });
  const token = jwt.sign({ id: data.id, email: data.email, role: data.role, name: data.name }, JWT_SECRET);
  res.json({ token, user: { id: data.id, name: data.name, email: data.email, role: data.role, balance: data.balance } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  // Support plain text password (admin) and hashed
  const valid = user.password === password || await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, balance: user.balance } });
});

// ── TRACKING : CLIC ──
app.get('/go/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const { data: link } = await supabase.from('links').select('*, offers(url)').eq('id', linkId).single();
  if (!link || !link.active) return res.status(404).send('Lien invalide ou désactivé');
  // Enregistre le clic
  await supabase.from('links').update({ clicks: link.clicks + 1 }).eq('id', linkId);
  // Redirige vers le site partenaire avec le linkId en paramètre
  const separator = link.offers.url.includes('?') ? '&' : '?';
  res.redirect(link.offers.url + separator + 'ref=' + linkId);
});

// ── POSTBACK : CONVERSION AUTOMATIQUE ──
// Le site partenaire appelle cette URL quand il y a une vente
// Ex: GET /api/postback?ref=ABC123&amount=10
app.get('/api/postback', async (req, res) => {
  const { ref, amount } = req.query;
  if (!ref) return res.status(400).json({ error: 'ref manquant' });
  const { data: link } = await supabase.from('links').select('*').eq('id', ref).single();
  if (!link || !link.active) return res.status(404).json({ error: 'Lien invalide' });
  const convAmount = parseFloat(amount) || 10;
  const { error } = await supabase.from('conversions').insert({
    link_id: ref,
    user_id: link.user_id,
    offer_id: link.offer_id,
    amount: convAmount,
    status: 'pending'
  });
  if (error) return res.status(500).json({ error: 'Erreur création conversion' });
  res.json({ success: true, message: 'Conversion enregistrée en attente de validation' });
});

// ── OFFERS ──
app.get('/api/offers', auth, async (req, res) => {
  const { data } = await supabase.from('offers').select('*').order('id');
  res.json(data || []);
});

app.post('/api/offers', auth, adminOnly, async (req, res) => {
  const { name, description, url, commission } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Nom et URL requis' });
  const { data, error } = await supabase.from('offers').insert({ name, description, url, commission: commission || 10 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── LINKS ──
app.get('/api/links', auth, async (req, res) => {
  let query = supabase.from('links').select('*, offers(name, commission)');
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query.order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/links', auth, async (req, res) => {
  const { offer_id } = req.body;
  // Vérifie si lien existe déjà
  const { data: existing } = await supabase.from('links').select('*').eq('user_id', req.user.id).eq('offer_id', offer_id).single();
  if (existing) return res.status(400).json({ error: 'Lien déjà généré pour cette offre' });
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  const { data, error } = await supabase.from('links').insert({ id, user_id: req.user.id, offer_id, clicks: 0, active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/links/:id', auth, adminOnly, async (req, res) => {
  const { active } = req.body;
  const { data } = await supabase.from('links').update({ active }).eq('id', req.params.id).select().single();
  res.json(data);
});

// ── CONVERSIONS ──
app.get('/api/conversions', auth, async (req, res) => {
  let query = supabase.from('conversions').select('*, links(id), offers(name), users(name)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
});

app.patch('/api/conversions/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: conv } = await supabase.from('conversions').select('*').eq('id', req.params.id).single();
  if (!conv || conv.status !== 'pending') return res.status(400).json({ error: 'Conversion invalide' });
  await supabase.from('conversions').update({ status: 'approved' }).eq('id', req.params.id);
  // Ajoute au solde
  const { data: user } = await supabase.from('users').select('balance').eq('id', conv.user_id).single();
  await supabase.from('users').update({ balance: user.balance + conv.amount }).eq('id', conv.user_id);
  res.json({ success: true });
});

app.patch('/api/conversions/:id/reject', auth, adminOnly, async (req, res) => {
  await supabase.from('conversions').update({ status: 'rejected' }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── WITHDRAWALS ──
app.get('/api/withdrawals', auth, async (req, res) => {
  let query = supabase.from('withdrawals').select('*, users(name)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
});

app.post('/api/withdrawals', auth, async (req, res) => {
  const { amount, crypto, address } = req.body;
  const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
  if (!user || user.balance < 30) return res.status(400).json({ error: 'Solde insuffisant (minimum $30)' });
  if (amount < 30 || amount > user.balance) return res.status(400).json({ error: 'Montant invalide' });
  const { data } = await supabase.from('withdrawals').insert({ user_id: req.user.id, amount, crypto, address, status: 'pending' }).select().single();
  res.json(data);
});

app.patch('/api/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Retrait introuvable' });
  await supabase.from('withdrawals').update({ status: 'paid' }).eq('id', req.params.id);
  const { data: user } = await supabase.from('users').select('balance').eq('id', wd.user_id).single();
  await supabase.from('users').update({ balance: Math.max(0, user.balance - wd.amount) }).eq('id', wd.user_id);
  res.json({ success: true });
});

app.patch('/api/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  await supabase.from('withdrawals').update({ status: 'rejected', reason }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── USERS ──
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('users').select('id, name, email, role, balance, created_at').eq('role', 'affiliate');
  res.json(data || []);
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  await supabase.from('users').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/api/me', auth, async (req, res) => {
  const { data } = await supabase.from('users').select('id, name, email, role, balance').eq('id', req.user.id).single();
  res.json(data);
});

// ── STATS ADMIN ──
app.get('/api/stats', auth, adminOnly, async (req, res) => {
  const [users, links, conversions, withdrawals] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact' }).eq('role', 'affiliate'),
    supabase.from('links').select('clicks'),
    supabase.from('conversions').select('amount, status'),
    supabase.from('withdrawals').select('amount, status')
  ]);
  const totalClicks = (links.data || []).reduce((s, l) => s + l.clicks, 0);
  const totalGains = (conversions.data || []).filter(c => c.status === 'approved').reduce((s, c) => s + c.amount, 0);
  const pendingConvs = (conversions.data || []).filter(c => c.status === 'pending').length;
  const pendingWds = (withdrawals.data || []).filter(w => w.status === 'pending').length;
  res.json({
    affiliates: users.count || 0,
    totalClicks,
    totalConversions: (conversions.data || []).length,
    totalGains,
    pendingConversions: pendingConvs,
    pendingWithdrawals: pendingWds
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AffiHub running on port ${PORT}`));
