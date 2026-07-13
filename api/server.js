const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// ── EMAIL ──
async function sendEmail(to, subject, html) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'AffiHub <onboarding@resend.dev>', to, subject, html })
    });
    if (!res.ok) console.error('Email error:', await res.text());
  } catch(e) { console.error('Email error:', e.message); }
}

const app = express();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'affihub_secret_2024';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
  const { data, error } = await supabase.from('users').insert({ name, email, password: hash, role: 'affiliate', balance: 0, referral_code: newCode, referred_by, show_ranking: true }).select().single();
  if (error) return res.status(400).json({ error: 'Email déjà utilisé' });
  // Log inscription
  supabase.from('activity_logs').insert({ user_id: data.id, action: 'inscription', details: 'Nouvel affilié : '+name, ip: '' }).then(()=>{});
  // Get welcome message
  const { data: wmsg } = await supabase.from('settings').select('value').eq('key', 'welcome_message').single();
  const token = jwt.sign({ id: data.id, email: data.email, role: data.role, name: data.name }, JWT_SECRET);
  res.json({ token, user: { id: data.id, name: data.name, email: data.email, role: data.role, balance: data.balance, referral_code: data.referral_code }, welcome_message: wmsg?.value || '' });
});

// ── LOGIN ──
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const valid = user.password === password || await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  // Check maintenance mode for non-admin
  if (user.role !== 'admin') {
    const { data: maint } = await supabase.from('settings').select('value').eq('key', 'maintenance_mode').single();
    if (maint && maint.value === 'true') return res.status(403).json({ error: '🔧 Site en maintenance. Revenez bientôt !' });
  }
  // Log activity
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
  supabase.from('activity_logs').insert({ user_id: user.id, action: 'login', details: 'Connexion de '+user.name, ip }).then(()=>{});
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, balance: user.balance, referral_code: user.referral_code, created_at: user.created_at, postback_url: user.postback_url, show_ranking: user.show_ranking } });
});

// ── ME ──
app.get('/api/me', auth, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,email,role,balance,referral_code,created_at,show_ranking').eq('id', req.user.id).single();
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

app.patch('/api/me/postback', auth, async (req, res) => {
  const { postback_url } = req.body;
  await supabase.from('users').update({ postback_url: postback_url || null }).eq('id', req.user.id);
  res.json({ success: true });
});

app.patch('/api/me/referral-code', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code requis' });
  const clean = code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (clean.length < 3 || clean.length > 20) return res.status(400).json({ error: 'Le code doit faire entre 3 et 20 caractères (lettres, chiffres, - et _)' });
  const { data: existing } = await supabase.from('users').select('id').eq('referral_code', clean).neq('id', req.user.id).single();
  if (existing) return res.status(400).json({ error: 'Ce code est déjà utilisé par un autre affilié' });
  await supabase.from('users').update({ referral_code: clean }).eq('id', req.user.id);
  res.json({ success: true, code: clean });
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
  const { data: link } = await supabase.from('links').select('*, offers(commission,name)').eq('id', ref).single();
  if (!link || !link.active) return res.status(404).json({ error: 'Lien invalide' });
  const convAmount = link.offers?.commission || parseFloat(amount) || 10;
  const { data: conv, error } = await supabase.from('conversions').insert({ link_id: ref, user_id: link.user_id, offer_id: link.offer_id, amount: convAmount, status: 'approved' }).select().single();
  if (error) return res.status(500).json({ error: 'Erreur création conversion' });
  // Créditer solde affilié
  const { data: user } = await supabase.from('users').select('balance,referred_by,postback_url').eq('id', link.user_id).single();
  if (user) {
    await supabase.from('users').update({ balance: user.balance + convAmount }).eq('id', link.user_id);
    // Commission parrainage
    if (user.referred_by) {
      const { data: referee } = await supabase.from('users').select('referral_active').eq('id', link.user_id).single();
      if (referee && referee.referral_active !== false) {
        const commission = parseFloat((convAmount * 0.05).toFixed(2));
        const { data: referrer } = await supabase.from('users').select('balance').eq('id', user.referred_by).single();
        if (referrer) {
          await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', user.referred_by);
          await supabase.from('referral_commissions').insert({ referrer_id: user.referred_by, referee_id: link.user_id, conversion_id: conv.id, amount: commission });
        }
      }
    }
    // Postback vers système affilié si configuré
    if (user.postback_url) {
      try {
        const postbackUrl = user.postback_url.replace('{LINK_ID}', ref).replace('{AMOUNT}', convAmount).replace('{STATUS}', 'approved');
        fetch(postbackUrl).catch(()=>{});
      } catch(e) {}
    }
  }
  res.json({ success: true, conversion_id: conv.id });
});

// ── MANUAL CONVERSION ──
app.post('/api/conversions/manual', auth, adminOnly, async (req, res) => {
  const { user_id, offer_id, amount, status } = req.body;
  if (!user_id || !offer_id || !amount) return res.status(400).json({ error: 'Champs requis' });
  // Find existing link or use null for manual conversions
  const { data: link } = await supabase.from('links').select('id').eq('user_id', user_id).eq('offer_id', offer_id).single();
  const link_id = link ? link.id : null;
  const { data: conv, error } = await supabase.from('conversions').insert({ link_id, user_id, offer_id, amount: parseFloat(amount), status: status || 'pending' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (status === 'approved') {
    const { data: user } = await supabase.from('users').select('balance,referred_by').eq('id', user_id).single();
    if (user) {
      await supabase.from('users').update({ balance: user.balance + parseFloat(amount) }).eq('id', user_id);
      if (user.referred_by) {
        const commission = parseFloat((parseFloat(amount) * 0.05).toFixed(2));
        const { data: referrer } = await supabase.from('users').select('balance').eq('id', user.referred_by).single();
        if (referrer) {
          await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', user.referred_by);
          await supabase.from('referral_commissions').insert({ referrer_id: user.referred_by, referee_id: user_id, conversion_id: conv.id, amount: commission });
        }
      }
    }
  }
  res.json(conv);
});

app.delete('/api/conversions/:id', auth, adminOnly, async (req, res) => {
  const { data: conv } = await supabase.from('conversions').select('*').eq('id', req.params.id).single();
  if (!conv) return res.status(404).json({ error: 'Introuvable' });
  // If approved, remove amount from user balance
  if (conv.status === 'approved') {
    const { data: user } = await supabase.from('users').select('balance').eq('id', conv.user_id).single();
    if (user) await supabase.from('users').update({ balance: Math.max(0, user.balance - conv.amount) }).eq('id', conv.user_id);
  }
  await supabase.from('conversions').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── APPROVE CONVERSION + PARRAINAGE ──
app.patch('/api/conversions/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: conv } = await supabase.from('conversions').select('*').eq('id', req.params.id).single();
  if (!conv || conv.status !== 'pending') return res.status(400).json({ error: 'Conversion invalide' });
  await supabase.from('conversions').update({ status: 'approved' }).eq('id', req.params.id);
  const { data: user } = await supabase.from('users').select('balance,referred_by,postback_url').eq('id', conv.user_id).single();
  await supabase.from('users').update({ balance: user.balance + conv.amount }).eq('id', conv.user_id);
  if (user.referred_by) {
    const { data: referee } = await supabase.from('users').select('referral_active').eq('id', conv.user_id).single();
    if (referee && referee.referral_active !== false) {
      const commission = parseFloat((conv.amount * 0.05).toFixed(2));
      const { data: referrer } = await supabase.from('users').select('balance').eq('id', user.referred_by).single();
      if (referrer) {
        await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', user.referred_by);
        await supabase.from('referral_commissions').insert({ referrer_id: user.referred_by, referee_id: conv.user_id, conversion_id: conv.id, amount: commission });
      }
    }
  }
  if (user.postback_url) {
    try {
      const postbackUrl = user.postback_url.replace('{LINK_ID}', conv.link_id || '').replace('{AMOUNT}', conv.amount).replace('{STATUS}', 'approved');
      fetch(postbackUrl).catch(err => console.error('Postback affilié échoué:', err.message));
    } catch (e) { console.error('Postback affilié erreur:', e.message); }
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
  const { name, description, url, commission, category, image_url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Nom et URL requis' });
  const validCats = ['casino','dating','influenceuse','ia','autre'];
  const cat = validCats.includes(category) ? category : 'autre';
  const { data, error } = await supabase.from('offers').insert({ name, description, url, commission: commission || 10, category: cat, image_url: image_url || null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/offers/:id', auth, adminOnly, async (req, res) => {
  const { name, description, url, commission, category, image_url } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Nom et URL requis' });
  const { data, error } = await supabase.from('offers').update({ name, description, url, commission: commission || 10, category: category || 'autre', image_url: image_url || null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.delete('/api/offers/:id', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
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
  const { data: offer } = await supabase.from('offers').select('name').eq('id', offer_id).single();
  const slug = offer ? offer.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 20) : 'offre';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = ''; for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  const id = `${slug}-${code}`;
  const { data, error } = await supabase.from('links').insert({ id, user_id: req.user.id, offer_id, clicks: 0, active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/links/:id', auth, adminOnly, async (req, res) => {
  const { active } = req.body;
  const { data } = await supabase.from('links').update({ active }).eq('id', req.params.id).select().single();
  res.json(data);
});
app.delete('/api/links/:id', auth, async (req, res) => {
  const { data: link } = await supabase.from('links').select('user_id').eq('id', req.params.id).single();
  if (!link) return res.status(404).json({ error: 'Lien introuvable' });
  if (req.user.role !== 'admin' && link.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  await supabase.from('links').delete().eq('id', req.params.id);
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
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (!user || user.balance < 25) return res.status(400).json({ error: 'Solde insuffisant (minimum $25)' });
  if (amount < 25 || amount > user.balance) return res.status(400).json({ error: 'Montant invalide' });
  await supabase.from('users').update({ balance: user.balance - amount }).eq('id', req.user.id);
  const { data } = await supabase.from('withdrawals').insert({ user_id: req.user.id, amount, crypto, address, status: 'pending' }).select().single();
  // Send confirmation email
  if (user.email) {
    sendEmail(user.email, '⏳ Demande de retrait reçue — AffiHub', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:16px;padding:32px;border:1px solid #222">
        <h2 style="color:#F5C842;margin-bottom:8px">⏳ Demande reçue !</h2>
        <p style="color:#aaa;margin-bottom:24px">Bonjour <b style="color:#fff">${user.name}</b>,</p>
        <p style="color:#aaa;margin-bottom:20px">Nous avons bien reçu ta demande de retrait. Elle sera traitée dans les plus brefs délais.</p>
        <div style="background:#111;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#777">Montant</span><span style="color:#F5C842;font-weight:800;font-size:18px">$${amount}</span></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#777">Moyen</span><span style="color:#fff">${crypto}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#777">Adresse</span><span style="color:#aaa;font-size:12px">${address.substring(0,30)}...</span></div>
        </div>
        <p style="color:#aaa;font-size:13px">Tu recevras un email dès que ton paiement est effectué. Des questions ? Contacte-nous sur Discord.</p>
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid #222;text-align:center;color:#555;font-size:12px">AffiHub — Plateforme d'affiliation privée</div>
      </div>
    `);
  }
  res.json(data);
});
app.patch('/api/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: wd } = await supabase.from('withdrawals').select('*, users(name,email)').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  await supabase.from('withdrawals').update({ status: 'paid' }).eq('id', req.params.id);
  // Send email
  if (wd.users?.email) {
    sendEmail(wd.users.email, '✅ Ton paiement a été effectué — AffiHub', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:16px;padding:32px;border:1px solid #222">
        <h2 style="color:#F5C842;margin-bottom:8px">✅ Paiement effectué !</h2>
        <p style="color:#aaa;margin-bottom:24px">Bonjour <b style="color:#fff">${wd.users.name}</b>,</p>
        <div style="background:#111;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#777">Montant</span><span style="color:#F5C842;font-weight:800;font-size:18px">$${wd.amount}</span></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#777">Moyen</span><span style="color:#fff">${wd.crypto}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#777">Adresse</span><span style="color:#aaa;font-size:12px">${wd.address.substring(0,30)}...</span></div>
        </div>
        <p style="color:#aaa;font-size:13px">Ton paiement a été traité avec succès. Si tu as des questions, contacte-nous sur Discord.</p>
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid #222;text-align:center;color:#555;font-size:12px">AffiHub — Plateforme d'affiliation privée</div>
      </div>
    `);
  }
  // Notification
  supabase.from('notifications').insert({ user_id: wd.user_id, type: 'withdrawal_paid', message: '💸 Ton retrait de $'+wd.amount+' ('+wd.crypto+') a été payé !' }).then(()=>{});
  res.json({ success: true });
});
app.patch('/api/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  const { data: wd } = await supabase.from('withdrawals').select('*, users(name,email,balance)').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  await supabase.from('withdrawals').update({ status: 'rejected', reason }).eq('id', req.params.id);
  const { data: user } = await supabase.from('users').select('balance').eq('id', wd.user_id).single();
  await supabase.from('users').update({ balance: user.balance + wd.amount }).eq('id', wd.user_id);
  // Notification
  supabase.from('notifications').insert({ user_id: wd.user_id, type: 'withdrawal_rejected', message: '❌ Ton retrait de $'+wd.amount+' a été rejeté'+(reason?' — '+reason:'')+'.' }).then(()=>{});
  // Send email
  if (wd.users?.email) {
    sendEmail(wd.users.email, '❌ Demande de retrait rejetée — AffiHub', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:16px;padding:32px;border:1px solid #222">
        <h2 style="color:#FF4757;margin-bottom:8px">❌ Retrait rejeté</h2>
        <p style="color:#aaa;margin-bottom:24px">Bonjour <b style="color:#fff">${wd.users.name}</b>,</p>
        <div style="background:#111;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#777">Montant</span><span style="color:#fff;font-weight:800">$${wd.amount}</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:#777">Raison</span><span style="color:#FF4757">${reason||'Non précisée'}</span></div>
        </div>
        <p style="color:#aaa;font-size:13px">Les <b style="color:#fff">$${wd.amount}</b> ont été recrédités sur ton solde AffiHub. Tu peux soumettre une nouvelle demande.</p>
        <p style="color:#aaa;font-size:13px;margin-top:12px">Des questions ? Contacte-nous sur Discord.</p>
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid #222;text-align:center;color:#555;font-size:12px">AffiHub — Plateforme d'affiliation privée</div>
      </div>
    `);
  }
  res.json({ success: true });
});
app.delete('/api/withdrawals/:id', auth, adminOnly, async (req, res) => {
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  if (wd.status === 'pending') {
    const { data: user } = await supabase.from('users').select('balance').eq('id', wd.user_id).single();
    if (user) await supabase.from('users').update({ balance: user.balance + wd.amount }).eq('id', wd.user_id);
  }
  await supabase.from('withdrawals').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── USERS ──
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,email,role,balance,created_at').eq('role', 'affiliate');
  res.json(data || []);
});
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  const uid = req.params.id;
  try {
    const { data: links } = await supabase.from('links').select('id').eq('user_id', uid);
    if (links && links.length > 0) {
      const linkIds = links.map(l => l.id);
      await supabase.from('conversions').delete().in('link_id', linkIds);
    }
    await supabase.from('conversions').delete().eq('user_id', uid);
    await supabase.from('links').delete().eq('user_id', uid);
    await supabase.from('withdrawals').delete().eq('user_id', uid);
    await supabase.from('referral_commissions').delete().eq('referrer_id', uid);
    await supabase.from('referral_commissions').delete().eq('referee_id', uid);
    await supabase.from('users').update({ referred_by: null }).eq('referred_by', uid);
    await supabase.from('custom_link_requests').delete().eq('user_id', uid);
    await supabase.from('temp_links').delete().eq('user_id', uid);
    await supabase.from('activity_logs').delete().eq('user_id', uid);
    const { data: tickets } = await supabase.from('tickets').select('id').eq('user_id', uid);
    if (tickets && tickets.length > 0) {
      const ticketIds = tickets.map(t => t.id);
      await supabase.from('ticket_messages').delete().in('ticket_id', ticketIds);
    }
    await supabase.from('ticket_messages').delete().eq('user_id', uid);
    await supabase.from('tickets').delete().eq('user_id', uid);
    const { error: delError } = await supabase.from('users').delete().eq('id', uid);
    if (delError) return res.status(500).json({ error: delError.message });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
  res.json({ affiliates: users.count || 0, totalClicks, totalConversions: (conversions.data || []).length, totalGains, pendingConversions: (conversions.data || []).filter(c => c.status === 'pending').length, pendingWithdrawals: (withdrawals.data || []).filter(w => w.status === 'pending').length, paidWithdrawals: (withdrawals.data || []).filter(w => w.status === 'paid').length, totalWithdrawals: (withdrawals.data || []).reduce((s,w) => w.status === 'paid' ? s + w.amount : s, 0) });
});

// ── ADMIN REFERRALS ──
app.get('/api/admin/referrals', auth, adminOnly, async (req, res) => {
  const { data: affiliates } = await supabase.from('users').select('id,name,email,balance,created_at,referral_code').eq('role','affiliate');
  const result = await Promise.all((affiliates||[]).map(async aff => {
    const { data: filleules } = await supabase.from('users').select('id,name,created_at,referral_active').eq('referred_by', aff.id);
    const { data: commissions } = await supabase.from('referral_commissions').select('*, users!referee_id(name), conversions(amount)').eq('referrer_id', aff.id).order('created_at',{ascending:false});
    const totalEarned = (commissions||[]).reduce((s,c)=>s+c.amount,0);
    return { ...aff, filleules: filleules||[], commissions: commissions||[], totalEarned };
  }));
  res.json(result.filter(a => a.filleules.length > 0 || a.commissions.length > 0));
});

app.patch('/api/admin/referral/:userId/toggle', auth, adminOnly, async (req, res) => {
  const { active } = req.body;
  await supabase.from('users').update({ referral_active: active }).eq('id', req.params.userId);
  res.json({ success: true });
});

app.get('/api/referrals', auth, async (req, res) => {
  const { data: filleules } = await supabase.from('users').select('id,name,created_at').eq('referred_by', req.user.id);
  const { data: commissions } = await supabase.from('referral_commissions').select('*, users!referee_id(name), conversions(amount)').eq('referrer_id', req.user.id).order('created_at', { ascending: false });
  const totalEarned = (commissions || []).reduce((s, c) => s + c.amount, 0);
  res.json({ filleules: filleules || [], commissions: commissions || [], totalEarned });
});

// ── RANKING ──
app.get('/api/ranking', auth, async (req, res) => {
  const { data: users } = await supabase.from('users').select('id,name,created_at').eq('role','affiliate').eq('show_ranking',true);
  const result = await Promise.all((users||[]).map(async u => {
    const { data: convs } = await supabase.from('conversions').select('amount,status').eq('user_id',u.id);
    const { data: links } = await supabase.from('links').select('clicks').eq('user_id',u.id);
    const approved = (convs||[]).filter(c=>c.status==='approved');
    const totalClicks = (links||[]).reduce((s,l)=>s+l.clicks,0);
    return { ...u, totalConversions: approved.length, totalGains: approved.reduce((s,c)=>s+c.amount,0), totalClicks };
  }));
  res.json(result);
});

app.patch('/api/me/ranking', auth, async (req, res) => {
  const { show } = req.body;
  await supabase.from('users').update({ show_ranking: show }).eq('id', req.user.id);
  res.json({ success: true });
});

// ── TICKETS ──
app.get('/api/tickets', auth, async (req, res) => {
  let query = supabase.from('tickets').select('*, users(name,email), ticket_messages(id,read_by_admin,read_by_user,user_id)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  const isAdmin = req.user.role === 'admin';
  const result = (data||[]).map(t => {
    const unread = (t.ticket_messages||[]).filter(m => {
      if(isAdmin) return !m.read_by_admin && m.user_id !== req.user.id;
      return !m.read_by_user && m.user_id !== req.user.id;
    }).length;
    return { ...t, unread };
  });
  res.json(result);
});

app.post('/api/tickets', auth, async (req, res) => {
  const { reason, content, image_url } = req.body;
  if (!reason || !content) return res.status(400).json({ error: 'Raison et message requis' });
  const { data: ticket, error } = await supabase.from('tickets').insert({ user_id: req.user.id, reason, status: 'open' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('ticket_messages').insert({ ticket_id: ticket.id, user_id: req.user.id, content, image_url: image_url || null });
  res.json(ticket);
});

app.get('/api/tickets/:id', auth, async (req, res) => {
  const { data: ticket } = await supabase.from('tickets').select('*, users(name,email)').eq('id', req.params.id).single();
  if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
  if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  const { data: messages } = await supabase.from('ticket_messages').select('*, users(name,role)').eq('ticket_id', req.params.id).order('created_at', { ascending: true });
  const isAdmin = req.user.role === 'admin';
  const unreadIds = (messages||[]).filter(m => isAdmin ? !m.read_by_admin : !m.read_by_user).map(m => m.id);
  if(unreadIds.length > 0) await supabase.from('ticket_messages').update(isAdmin ? { read_by_admin: true } : { read_by_user: true }).in('id', unreadIds);
  res.json({ ...ticket, messages: messages || [] });
});

app.post('/api/tickets/:id/reply', auth, async (req, res) => {
  const { content, image_url } = req.body;
  if (!content && !image_url) return res.status(400).json({ error: 'Message requis' });
  const { data: ticket } = await supabase.from('tickets').select('user_id').eq('id', req.params.id).single();
  if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
  if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  await supabase.from('ticket_messages').insert({ ticket_id: parseInt(req.params.id), user_id: req.user.id, content: content || '', image_url: image_url || null });
  res.json({ success: true });
});

app.patch('/api/tickets/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const { data: ticket } = await supabase.from('tickets').select('user_id').eq('id', req.params.id).single();
  if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
  if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  if (req.user.role !== 'admin' && status !== 'closed') return res.status(403).json({ error: 'Non autorisé' });
  await supabase.from('tickets').update({ status }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/tickets/:id', auth, adminOnly, async (req, res) => {
  await supabase.from('ticket_messages').delete().eq('ticket_id', req.params.id);
  await supabase.from('tickets').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── IMAGE UPLOAD ──
app.post('/api/upload-image', auth, adminOnly, async (req, res) => {
  const { data: base64, fileName, mimeType } = req.body;
  if (!base64 || !fileName) return res.status(400).json({ error: 'Données manquantes' });
  const buffer = Buffer.from(base64, 'base64');
  const uniqueName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const { data, error } = await supabase.storage.from('offers').upload(uniqueName, buffer, { contentType: mimeType || 'image/jpeg', upsert: false });
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = supabase.storage.from('offers').getPublicUrl(uniqueName);
  res.json({ url: urlData.publicUrl });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AffiHub running on port ${PORT}`));

// ── CUSTOM LINK REQUESTS ──
app.get('/api/custom-requests', auth, async (req, res) => {
  let query = supabase.from('custom_link_requests').select('*, users(name,email), offers(name)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
});

app.post('/api/custom-requests', auth, async (req, res) => {
  const { offer_id, server_name, slogan, tag1, tag2, tag3, logo_url, salons, photo1_url, photo2_url, photo3_url, photo4_url, photo5_url, photo6_url, photos_blurred, photo_text } = req.body;
  // Check if already exists
  const { data: existing } = await supabase.from('custom_link_requests').select('id').eq('user_id', req.user.id).eq('offer_id', offer_id).single();
  if (existing) {
    const { data, error } = await supabase.from('custom_link_requests').update({ server_name, slogan, tag1, tag2, tag3, logo_url, salons, photo1_url, photo2_url, photo3_url, photo4_url, photo5_url, photo6_url, photos_blurred, photo_text, status: 'pending', updated_at: new Date() }).eq('id', existing.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }
  const { data, error } = await supabase.from('custom_link_requests').insert({ user_id: req.user.id, offer_id, server_name, slogan, tag1, tag2, tag3, logo_url, salons, photo1_url, photo2_url, photo3_url, photo4_url, photo5_url, photo6_url, photos_blurred, photo_text }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/custom-requests/:id/link', auth, adminOnly, async (req, res) => {
  const { custom_link } = req.body;
  const { data, error } = await supabase.from('custom_link_requests').update({ custom_link, status: 'approved', updated_at: new Date() }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/custom-requests/:id', auth, adminOnly, async (req, res) => {
  await supabase.from('custom_link_requests').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── TEMP LINKS (en attente du postback Adunlock) ──
app.get('/api/temp-links', auth, async (req, res) => {
  let query = supabase.from('temp_links').select('*, users(name,email), offers(name,category)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
});

app.post('/api/temp-links', auth, async (req, res) => {
  const { offer_id } = req.body;
  const { data: existing } = await supabase.from('temp_links').select('id').eq('user_id', req.user.id).eq('offer_id', offer_id).single();
  if (existing) return res.status(400).json({ error: 'Demande déjà existante pour cette offre' });
  const { data, error } = await supabase.from('temp_links').insert({ user_id: req.user.id, offer_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/temp-links/:id/link', auth, adminOnly, async (req, res) => {
  const { custom_link } = req.body;
  const { data, error } = await supabase.from('temp_links').update({ custom_link, status: 'approved' }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/temp-links/:id', auth, adminOnly, async (req, res) => {
  await supabase.from('temp_links').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── GLOBAL SETTINGS ──
app.get('/api/settings', auth, async (req, res) => {
  const { data } = await supabase.from('settings').select('*').eq('key', 'temp_links_enabled').single();
  res.json({ temp_links_enabled: data ? data.value === 'true' : true });
});

app.patch('/api/settings/temp-links', auth, adminOnly, async (req, res) => {
  const { enabled } = req.body;
  await supabase.from('settings').upsert({ key: 'temp_links_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key' });
  res.json({ success: true });
});

app.get('/api/settings/all', auth, async (req, res) => {
  const { data } = await supabase.from('settings').select('*');
  const obj = {};
  (data || []).forEach(s => { obj[s.key] = s.value; });
  res.json({
    temp_links_enabled: obj.temp_links_enabled !== 'false',
    aff_links_enabled: obj.aff_links_enabled !== 'false',
    cat_casino_enabled: obj.cat_casino_enabled !== 'false',
    cat_dating_enabled: obj.cat_dating_enabled !== 'false',
    cat_ia_enabled: obj.cat_ia_enabled !== 'false',
    cat_autre_enabled: obj.cat_autre_enabled !== 'false',
    cat_influenceuse_enabled: obj.cat_influenceuse_enabled === 'true',
    maintenance_mode: obj.maintenance_mode === 'true',
    welcome_message: obj.welcome_message || ''
  });
});

app.patch('/api/settings/maintenance', auth, adminOnly, async (req, res) => {
  const { enabled } = req.body;
  await supabase.from('settings').upsert({ key: 'maintenance_mode', value: enabled ? 'true' : 'false' }, { onConflict: 'key' });
  res.json({ success: true });
});

app.patch('/api/settings/welcome', auth, adminOnly, async (req, res) => {
  const { message } = req.body;
  await supabase.from('settings').upsert({ key: 'welcome_message', value: message || '' }, { onConflict: 'key' });
  res.json({ success: true });
});

app.get('/api/logs', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('activity_logs').select('*, users(name,email,role)').order('created_at', { ascending: false }).limit(500);
  res.json(data || []);
});

app.delete('/api/logs/:id', auth, adminOnly, async (req, res) => {
  await supabase.from('activity_logs').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/logs', auth, adminOnly, async (req, res) => {
  await supabase.from('activity_logs').delete().neq('id', 0);
  res.json({ success: true });
});

app.patch('/api/settings/aff-links', auth, adminOnly, async (req, res) => {
  const { enabled } = req.body;
  await supabase.from('settings').upsert({ key: 'aff_links_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key' });
  res.json({ success: true });
});

app.patch('/api/settings/category', auth, adminOnly, async (req, res) => {
  const { category, enabled } = req.body;
  const valid = ['casino', 'dating', 'ia', 'autre', 'influenceuse'];
  if (!valid.includes(category)) return res.status(400).json({ error: 'Catégorie invalide' });
  await supabase.from('settings').upsert({ key: 'cat_' + category + '_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key' });
  res.json({ success: true });
});

// ── NOTES AFFILIÉS ──
app.patch('/api/users/:id/note', auth, adminOnly, async (req, res) => {
  const { note } = req.body;
  await supabase.from('users').update({ admin_note: note }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── EXPORT CSV ──
function toCSV(rows, headers) {
  const escape = v => '"' + String(v || '').replace(/"/g, '""') + '"';
  const lines = [headers.map(escape).join(',')];
  rows.forEach(row => lines.push(headers.map(h => escape(row[h])).join(',')));
  return lines.join('\n');
}

app.get('/api/export/affiliates', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('users').select('name,email,balance,referral_code,created_at,admin_note').neq('role', 'admin');
  const csv = toCSV(data, ['name','email','balance','referral_code','created_at','admin_note']);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="affilies.csv"');
  res.send(csv);
});

app.get('/api/export/conversions', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('conversions').select('*, users(name,email), offers(name)').order('created_at', { ascending: false });
  const rows = (data || []).map(c => ({ date: c.created_at?.split('T')[0], affilié: c.users?.name, email: c.users?.email, offre: c.offers?.name, montant: c.amount, statut: c.status, lien: c.link_id }));
  const csv = toCSV(rows, ['date','affilié','email','offre','montant','statut','lien']);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="conversions.csv"');
  res.send(csv);
});

app.get('/api/export/withdrawals', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('withdrawals').select('*, users(name,email)').order('created_at', { ascending: false });
  const rows = (data || []).map(w => ({ date: w.created_at?.split('T')[0], affilié: w.users?.name, email: w.users?.email, montant: w.amount, moyen: w.crypto, adresse: w.address, statut: w.status, raison: w.reason }));
  const csv = toCSV(rows, ['date','affilié','email','montant','moyen','adresse','statut','raison']);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="retraits.csv"');
  res.send(csv);
});

// ── NOTIFICATIONS ──
app.get('/api/notifications', auth, async (req, res) => {
  const { data } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20);
  res.json(data || []);
});

app.patch('/api/notifications/read', auth, async (req, res) => {
  await supabase.from('notifications').update({ read: true }).eq('user_id', req.user.id);
  res.json({ success: true });
});

app.delete('/api/notifications/:id', auth, async (req, res) => {
  await supabase.from('notifications').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});
