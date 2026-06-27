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
  const { data, error } = await supabase.from('offers').insert({ name, description, url, commission: commission || 10, category: category || 'autre', image_url: image_url || null }).select().single();
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
  // Get offer name for friendly URL
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
  // Allow affiliate to delete their own link, or admin to delete any
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
  const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
  if (!user || user.balance < 10) return res.status(400).json({ error: 'Solde insuffisant (minimum $10)' });
  if (amount < 10 || amount > user.balance) return res.status(400).json({ error: 'Montant invalide' });
  await supabase.from('users').update({ balance: user.balance - amount }).eq('id', req.user.id);
  const { data } = await supabase.from('withdrawals').insert({ user_id: req.user.id, amount, crypto, address, status: 'pending' }).select().single();
  res.json(data);
});
app.patch('/api/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  await supabase.from('withdrawals').update({ status: 'paid' }).eq('id', req.params.id);
  res.json({ success: true });
});
app.patch('/api/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  await supabase.from('withdrawals').update({ status: 'rejected', reason }).eq('id', req.params.id);
  const { data: user } = await supabase.from('users').select('balance').eq('id', wd.user_id).single();
  await supabase.from('users').update({ balance: user.balance + wd.amount }).eq('id', wd.user_id);
  res.json({ success: true });
});
app.delete('/api/withdrawals/:id', auth, adminOnly, async (req, res) => {
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  // Si le retrait est encore en attente, on rembourse le solde
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
    // Supprimer dans l'ordre pour éviter les erreurs de foreign key
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
    await supabase.from('users').delete().eq('id', uid);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AffiHub running on port ${PORT}`));

// ── IMAGE UPLOAD ──
app.post('/api/upload-image', auth, adminOnly, async (req, res) => {
  const { data: base64, fileName, mimeType } = req.body;
  if (!base64 || !fileName) return res.status(400).json({ error: 'Données manquantes' });
  const buffer = Buffer.from(base64, 'base64');
  const uniqueName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const { data, error } = await supabase.storage.from('offers').upload(uniqueName, buffer, {
    contentType: mimeType || 'image/jpeg',
    upsert: false
  });
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = supabase.storage.from('offers').getPublicUrl(uniqueName);
  res.json({ url: urlData.publicUrl });
});
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
  await supabase.from('tickets').update({ status }).eq('id', req.params.id);
  res.json({ success: true });
});
