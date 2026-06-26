const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const path = require('path');

const app = express();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'affihub_secret_2024';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({
      from: 'AffiHub <onboarding@resend.dev>',
      to,
      subject,
      html
    });
  } catch(e) {
    console.error('Email error:', e.message);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin seulement' });
  next();
}

// ── REGISTER ──
app.post('/api/register', async (req, res) => {
  const { name, email, password, referral_code } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Champs requis' });
  const hash = await bcrypt.hash(password, 10);
  const newCode = Math.random().toString(36).substring(2, 10).toUpperCase();
  let referred_by = null;
  if (referral_code) {
    const { data: referrer } = await supabase.from('users').select('id').eq('referral_code', referral_code).single();
    if (referrer) referred_by = referrer.id;
  }
  const { data, error } = await supabase.from('users').insert({ name, email, password: hash, role: 'affiliate', balance: 0, referral_code: newCode, referred_by }).select().single();
  if (error) return res.status(400).json({ error: 'Email déjà utilisé' });
  const token = jwt.sign({ id: data.id, email: data.email, role: data.role, name: data.name }, JWT_SECRET);
  res.json({ token, user: { id: data.id, name: data.name, email: data.email, role: data.role, balance: data.balance, referral_code: data.referral_code } });
});

// ── LOGIN ──
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const valid = user.password === password || await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, balance: user.balance, referral_code: user.referral_code, created_at: user.created_at } });
});

// ── ME ──
app.get('/api/me', auth, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,email,role,balance,referral_code,created_at').eq('id', req.user.id).single();
  res.json(data);
});

// ── CHANGE PASSWORD ──
app.post('/api/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  const valid = user.password === current_password || await bcrypt.compare(current_password, user.password);
  if (!valid) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  const hash = await bcrypt.hash(new_password, 10);
  await supabase.from('users').update({ password: hash }).eq('id', req.user.id);
  res.json({ success: true });
});

// ── TRACKING CLIC ──
app.get('/go/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const { data: link } = await supabase.from('links').select('*, offers(url)').eq('id', linkId).single();
  if (!link || !link.active) return res.status(404).send('Lien invalide ou désactivé');
  await supabase.from('links').update({ clicks: link.clicks + 1 }).eq('id', linkId);
  const separator = link.offers.url.includes('?') ? '&' : '?';
  res.redirect(link.offers.url + separator + 'ref=' + linkId);
});

// ── POSTBACK CONVERSION ──
app.get('/api/postback', async (req, res) => {
  const { ref, amount } = req.query;
  if (!ref) return res.status(400).json({ error: 'ref manquant' });
  const { data: link } = await supabase.from('links').select('*').eq('id', ref).single();
  if (!link || !link.active) return res.status(404).json({ error: 'Lien invalide' });
  const convAmount = parseFloat(amount) || 10;
  const { data: conv, error } = await supabase.from('conversions').insert({ link_id: ref, user_id: link.user_id, offer_id: link.offer_id, amount: convAmount, status: 'pending' }).select().single();
  if (error) return res.status(500).json({ error: 'Erreur création conversion' });
  res.json({ success: true, conversion_id: conv.id });
});

// ── APPROVE CONVERSION + PARRAINAGE ──
app.patch('/api/conversions/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: conv } = await supabase.from('conversions').select('*').eq('id', req.params.id).single();
  if (!conv || conv.status !== 'pending') return res.status(400).json({ error: 'Conversion invalide' });
  await supabase.from('conversions').update({ status: 'approved' }).eq('id', req.params.id);
  const { data: user } = await supabase.from('users').select('balance,referred_by').eq('id', conv.user_id).single();
  await supabase.from('users').update({ balance: user.balance + conv.amount }).eq('id', conv.user_id);
  // Commission parrainage 5%
  if (user.referred_by) {
    const commission = parseFloat((conv.amount * 0.05).toFixed(2));
    const { data: referrer } = await supabase.from('users').select('balance').eq('id', user.referred_by).single();
    if (referrer) {
      await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', user.referred_by);
      await supabase.from('referral_commissions').insert({ referrer_id: user.referred_by, referee_id: conv.user_id, conversion_id: conv.id, amount: commission });
    }
  }
  res.json({ success: true });
});

app.patch('/api/conversions/:id/reject', auth, adminOnly, async (req, res) => {
  await supabase.from('conversions').update({ status: 'rejected' }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── CONVERSIONS ──
app.get('/api/conversions', auth, async (req, res) => {
  let query = supabase.from('conversions').select('*, offers(name), users(name)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
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
app.delete('/api/offers/:id', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  // Supprimer les conversions liées aux liens de cette offre
  const { data: links } = await supabase.from('links').select('id').eq('offer_id', id);
  if (links && links.length > 0) {
    const linkIds = links.map(l => l.id);
    await supabase.from('conversions').delete().in('link_id', linkIds);
    await supabase.from('links').delete().eq('offer_id', id);
  }
  await supabase.from('offers').delete().eq('id', id);
  res.json({ success: true });
});

// ── LINKS ──
app.get('/api/links', auth, async (req, res) => {
  let query = supabase.from('links').select('*, offers(name,commission), users(name)');
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query.order('created_at', { ascending: false });
  res.json(data || []);
});
app.post('/api/links', auth, async (req, res) => {
  const { offer_id } = req.body;
  const { data: existing } = await supabase.from('links').select('*').eq('user_id', req.user.id).eq('offer_id', offer_id).single();
  if (existing) return res.status(400).json({ error: 'Lien déjà généré' });
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = ''; for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  const { data, error } = await supabase.from('links').insert({ id, user_id: req.user.id, offer_id, clicks: 0, active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/links/:id', auth, adminOnly, async (req, res) => {
  const { active } = req.body;
  const { data } = await supabase.from('links').update({ active }).eq('id', req.params.id).select().single();
  res.json(data);
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
  const { data: user } = await supabase.from('users').select('balance,email,name').eq('id', req.user.id).single();
  if (!user || user.balance < 10) return res.status(400).json({ error: 'Solde insuffisant (minimum $10)' });
  if (amount < 10 || amount > user.balance) return res.status(400).json({ error: 'Montant invalide' });
  const { data } = await supabase.from('withdrawals').insert({ user_id: req.user.id, amount, crypto, address, status: 'pending' }).select().single();

  // Email à l'affilié
  await sendEmail(user.email, '💸 Demande de retrait reçue — AffiHub', `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0F0A14;color:#F5EEF8;border-radius:16px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#F5C842,#F0427A);padding:3px"></div>
      <div style="padding:40px 36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
          <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#F5C842,#F0427A);display:flex;align-items:center;justify-content:center;font-size:20px">🔗</div>
          <span style="font-size:22px;font-weight:800;color:#F5EEF8">AffiHub</span>
        </div>
        <h2 style="font-size:20px;font-weight:800;margin-bottom:8px;color:#F5EEF8">Demande de retrait envoyée ✅</h2>
        <p style="color:#7B6B8E;font-size:14px;margin-bottom:28px">Bonjour <strong style="color:#F5EEF8">${user.name}</strong>, votre demande a bien été reçue et est en cours de traitement.</p>
        <div style="background:#160F1E;border:1px solid #2E2040;border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #2E2040">
            <span style="color:#7B6B8E;font-size:13px">Montant</span>
            <span style="font-weight:800;font-size:16px;color:#F5C842">$${amount}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #2E2040">
            <span style="color:#7B6B8E;font-size:13px">Crypto</span>
            <span style="font-weight:700;color:#F5EEF8">${crypto}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #2E2040">
            <span style="color:#7B6B8E;font-size:13px">Adresse</span>
            <span style="font-weight:600;color:#F5EEF8;font-size:12px;font-family:monospace">${address.substring(0,20)}...</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:10px 0">
            <span style="color:#7B6B8E;font-size:13px">Statut</span>
            <span style="background:rgba(245,200,66,.15);color:#F5C842;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">⏳ En attente</span>
          </div>
        </div>
        <p style="color:#7B6B8E;font-size:13px;line-height:1.6">Vous recevrez un autre email dès que votre retrait sera traité. En cas de question, contactez le support sur Discord : <strong style="color:#F5EEF8">ananous.</strong></p>
      </div>
      <div style="background:#160F1E;padding:16px 36px;border-top:1px solid #2E2040;text-align:center">
        <p style="color:#7B6B8E;font-size:12px;margin:0">© AffiHub — Plateforme d'affiliation privée</p>
      </div>
    </div>
  `);

  res.json(data);
});
app.patch('/api/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  await supabase.from('withdrawals').update({ status: 'paid' }).eq('id', req.params.id);
  const { data: user } = await supabase.from('users').select('balance,email,name').eq('id', wd.user_id).single();
  await supabase.from('users').update({ balance: Math.max(0, user.balance - wd.amount) }).eq('id', wd.user_id);

  // Email à l'affilié
  await sendEmail(user.email, '✅ Votre paiement a été envoyé — AffiHub', `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0F0A14;color:#F5EEF8;border-radius:16px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#F5C842,#F0427A);padding:3px"></div>
      <div style="padding:40px 36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
          <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#F5C842,#F0427A);display:flex;align-items:center;justify-content:center;font-size:20px">🔗</div>
          <span style="font-size:22px;font-weight:800;color:#F5EEF8">AffiHub</span>
        </div>
        <h2 style="font-size:20px;font-weight:800;margin-bottom:8px;color:#F5EEF8">Paiement envoyé 🎉</h2>
        <p style="color:#7B6B8E;font-size:14px;margin-bottom:28px">Bonjour <strong style="color:#F5EEF8">${user.name}</strong>, votre retrait a été traité et le paiement a été envoyé sur votre adresse crypto.</p>
        <div style="background:#160F1E;border:1px solid #2E2040;border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #2E2040">
            <span style="color:#7B6B8E;font-size:13px">Montant envoyé</span>
            <span style="font-weight:800;font-size:16px;color:#2DD98F">$${wd.amount}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #2E2040">
            <span style="color:#7B6B8E;font-size:13px">Crypto</span>
            <span style="font-weight:700;color:#F5EEF8">${wd.crypto}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #2E2040">
            <span style="color:#7B6B8E;font-size:13px">Adresse</span>
            <span style="font-weight:600;color:#F5EEF8;font-size:12px;font-family:monospace">${wd.address.substring(0,20)}...</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:10px 0">
            <span style="color:#7B6B8E;font-size:13px">Statut</span>
            <span style="background:rgba(45,217,143,.15);color:#2DD98F;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">✅ Payé</span>
          </div>
        </div>
        <p style="color:#7B6B8E;font-size:13px;line-height:1.6">Le transfert peut prendre quelques minutes à apparaître selon la blockchain. En cas de question, contactez le support sur Discord : <strong style="color:#F5EEF8">ananous.</strong></p>
      </div>
      <div style="background:#160F1E;padding:16px 36px;border-top:1px solid #2E2040;text-align:center">
        <p style="color:#7B6B8E;font-size:12px;margin:0">© AffiHub — Plateforme d'affiliation privée</p>
      </div>
    </div>
  `);

  res.json({ success: true });
});
app.patch('/api/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  await supabase.from('withdrawals').update({ status: 'rejected', reason }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── USERS ──
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,email,role,balance,created_at').eq('role', 'affiliate');
  res.json(data || []);
});
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  await supabase.from('users').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── STATS ADMIN ──
app.get('/api/stats', auth, adminOnly, async (req, res) => {
  const [users, links, conversions, withdrawals] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact' }).eq('role', 'affiliate'),
    supabase.from('links').select('clicks'),
    supabase.from('conversions').select('amount,status'),
    supabase.from('withdrawals').select('amount,status')
  ]);
  const totalClicks = (links.data || []).reduce((s, l) => s + l.clicks, 0);
  const totalGains = (conversions.data || []).filter(c => c.status === 'approved').reduce((s, c) => s + c.amount, 0);
  res.json({ affiliates: users.count || 0, totalClicks, totalConversions: (conversions.data || []).length, totalGains, pendingConversions: (conversions.data || []).filter(c => c.status === 'pending').length, pendingWithdrawals: (withdrawals.data || []).filter(w => w.status === 'pending').length });
});

// ── PARRAINAGE ──
app.get('/api/referrals', auth, async (req, res) => {
  const { data: filleules } = await supabase.from('users').select('id,name,created_at').eq('referred_by', req.user.id);
  const { data: commissions } = await supabase.from('referral_commissions').select('*, users!referee_id(name), conversions(amount)').eq('referrer_id', req.user.id).order('created_at', { ascending: false });
  const totalEarned = (commissions || []).reduce((s, c) => s + c.amount, 0);
  res.json({ filleules: filleules || [], commissions: commissions || [], totalEarned });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AffiHub running on port ${PORT}`));
