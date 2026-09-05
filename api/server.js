const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'affihub_secret_2024';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── EMAIL ──
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1526526889756332134/lCByUUSbUigvyW0TfTarZ14LxziWL6k_5iLbq_jwG8ecC9qHpFTOLFPbE9gKdqnbD_hX';
const DISCORD_REGISTER = 'https://discord.com/api/webhooks/1526534674317316106/DVjEe1IQmTYt7Xnyy37gyiJcABJoks4hpc5Z2v6dUSF3LYqXN0XJsfVRD7TnvwBKYvVo';
const DISCORD_WITHDRAWAL = 'https://discord.com/api/webhooks/1526535135003148411/T36o_LZh8U-GxnIJUEBPpagDCc52f5l00qX6va8fgj-lzUQacn3r1dtY5yh4FguLk3OX';
const DISCORD_PAYMENT = 'https://discord.com/api/webhooks/1526535272437780600/RLIxROgmO64UPycLUJgbDN31kCuDIt7VpJmTgSSouYHolByFqZNeAB59k7ZjOm0u2qHa';
const DISCORD_TICKET = 'https://discord.com/api/webhooks/1526535384685871146/q2VAq8dCK6Yd9K8fw6Q8U08JoD_-af2Ph8YZdrXeYyNlcdAZKpVHcXXi5GDKPpYw0dmN';
const DISCORD_REFERRAL = 'https://discord.com/api/webhooks/1526536467168493658/SJ-Et9ONIpTC_YmCd7Ow_VZbOrO5FIGHB8MNaV9FcxolheQFmtf2pdou4za8UA8r73OD';

async function notifyDiscord(affiliateName, offerName, amount) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '<@&1520173497048105170>',
        embeds: [{
          title: '💰 Nouvelle conversion !',
          color: 0xF5C842,
          fields: [
            { name: '👤 Affilié', value: affiliateName, inline: true },
            { name: '🎯 Offre', value: offerName, inline: true },
            { name: '💵 Montant', value: '$' + amount, inline: true }
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'AffiHub' }
        }]
      })
    });
  } catch(e) { console.error('Discord webhook error:', e.message); }
}

async function notifyDiscord2(webhook, title, color, fields, content) {
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: content || undefined,
        embeds: [{
          title,
          color,
          fields,
          timestamp: new Date().toISOString(),
          footer: { text: 'AffiHub' }
        }]
      })
    });
  } catch(e) { console.error('Discord webhook error:', e.message); }
}

// ── DM privé à un affilié via un bot Discord (nécessite DISCORD_BOT_TOKEN) ──
async function sendDiscordDM(discordId, title, color, fields) {
  if (!discordId || !process.env.DISCORD_BOT_TOKEN) return;
  try {
    const chanRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { 'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: discordId })
    });
    const chan = await chanRes.json();
    if (!chan.id) { console.error('Discord DM: impossible d\'ouvrir le channel', chan); return; }
    await fetch('https://discord.com/api/v10/channels/' + chan.id + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title, color, fields, timestamp: new Date().toISOString(), footer: { text: 'AffiHub' } }] })
    });
  } catch (e) { console.error('Discord DM error:', e.message); }
}

// Poste un message directement dans un salon (via son ID) en utilisant le bot déjà configuré
async function sendDiscordChannelMsg(channelId, title, color, fields, mention) {
  if (!channelId || !process.env.DISCORD_BOT_TOKEN) return;
  try {
    await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mention || undefined, embeds: [{ title, color, fields, timestamp: new Date().toISOString(), footer: { text: 'AffiHub' } }] })
    });
  } catch (e) { console.error('Discord channel msg error:', e.message); }
}

// DM texte brut (pour les envois groupés), renvoie true/false
async function sendDiscordDMPlain(discordId, content, image_url) {
  if (!discordId || !process.env.DISCORD_BOT_TOKEN) return false;
  try {
    const chanRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { 'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: discordId })
    });
    const chan = await chanRes.json();
    if (!chan.id) return false;
    let msgRes;
    if (image_url) {
      // Télécharge l'image puis l'envoie comme vraie pièce jointe (pas de lien visible)
      const imgRes = await fetch(image_url);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const ext = (image_url.split('.').pop() || 'png').split('?')[0].slice(0, 4);
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content }));
      form.append('files[0]', new Blob([imgBuffer]), 'image.' + ext);
      msgRes = await fetch('https://discord.com/api/v10/channels/' + chan.id + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN },
        body: form
      });
    } else {
      msgRes = await fetch('https://discord.com/api/v10/channels/' + chan.id + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
    }
    return msgRes.ok;
  } catch (e) { console.error('Discord DM plain error:', e.message); return false; }
}

async function sendEmail(to, subject, html) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'AffiHub <onboarding@resend.dev>', to, subject, html })
    });
    if (!res.ok) console.error('Email error:', await res.text());
  } catch(e) { console.error('Email error:', e.message); }
}

// ── LOG HELPER ──
function log(userId, action, details, req) {
  const ip = req?.headers?.['x-forwarded-for']?.split(',')[0] || req?.socket?.remoteAddress || '';
  supabase.from('activity_logs').insert({ user_id: userId, action, details, ip }).then(()=>{}).catch(()=>{});
}

// ── Protection SSRF pour postback_url (empêche d'atteindre des adresses internes/privées) ──
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 127) return true;                          // loopback
    if (p[0] === 10) return true;                            // 10.0.0.0/8
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16.0.0/12
    if (p[0] === 192 && p[1] === 168) return true;           // 192.168.0.0/16
    if (p[0] === 169 && p[1] === 254) return true;           // link-local / metadata cloud
    if (p[0] === 0) return true;                             // 0.0.0.0/8
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1') return true;                            // loopback
    if (l.startsWith('fc') || l.startsWith('fd')) return true; // fc00::/7 (unique local)
    if (l.startsWith('fe80')) return true;                    // link-local
    if (l.startsWith('::ffff:')) {                            // IPv4 mappée en IPv6
      const v4 = l.split(':').pop();
      if (net.isIPv4(v4)) return isPrivateIP(v4);
    }
    return false;
  }
  return true; // format inconnu → on bloque par sécurité
}
async function isSafePostbackUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname === 'localhost') return false;
    const addresses = await dns.lookup(u.hostname, { all: true });
    if (!addresses.length) return false;
    for (const a of addresses) { if (isPrivateIP(a.address)) return false; }
    return true;
  } catch (e) { return false; }
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
// Vérifie qu'un ID Discord est valide en y envoyant un vrai message de test, avant même l'inscription
app.post('/api/verify-discord-id', async (req, res) => {
  const { discord_id } = req.body;
  if (!discord_id || !/^\d{15,25}$/.test(discord_id)) return res.status(400).json({ error: 'Format invalide (uniquement des chiffres)' });
  const ok = await sendDiscordDMPlain(discord_id, '✅ Ton ID Discord fonctionne bien sur AffiHub ! Tu recevras tes alertes de vente ici.');
  if (!ok) return res.status(400).json({ error: 'Impossible d\'envoyer un message à cet ID. Vérifie qu\'il est correct et que tu partages bien un serveur avec le bot AffiHub.' });
  res.json({ success: true });
});

app.post('/api/register', async (req, res) => {
  const { name, email, password, referral_code, discord_id } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Champs requis' });
  if (!discord_id || !/^\d{15,25}$/.test(discord_id)) return res.status(400).json({ error: 'ID Discord requis et valide' });
  // Check maintenance mode
  const { data: maint } = await supabase.from('settings').select('value').eq('key', 'maintenance_mode').single();
  if (maint && maint.value === 'true') return res.status(403).json({ error: '🔧 Site en maintenance. Revenez bientôt !' });
  const hash = await bcrypt.hash(password, 10);
  const signupIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  // Generate referral code from username (lowercase, no spaces, unique)
  const baseCode = name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 20);
  // Check if code already exists and make it unique if needed
  let newCode = baseCode;
  let suffix = 1;
  while(true) {
    const { data: existing } = await supabase.from('users').select('id').eq('referral_code', newCode).single();
    if (!existing) break;
    newCode = baseCode + suffix;
    suffix++;
  }
  let referred_by = null;
  let referral_same_ip = false;
  if (referral_code) {
    const { data: referrer } = await supabase.from('users').select('id,signup_ip').eq('referral_code', referral_code).single();
    if (referrer) {
      referred_by = referrer.id;
      if (signupIp && referrer.signup_ip && signupIp === referrer.signup_ip) referral_same_ip = true;
    }
  }
  const { data, error } = await supabase.from('users').insert({ name, email, password: hash, role: 'affiliate', balance: 0, referral_code: newCode, referred_by, referral_same_ip, signup_ip: signupIp, show_ranking: true, discord_id }).select().single();
  if (error) return res.status(400).json({ error: 'Email déjà utilisé' });
  // Notify referrer on Discord if referred
  if (referred_by) {
    const { data: referrer } = await supabase.from('users').select('name').eq('id', referred_by).single();
    if (referrer) {
      const fields = [
        { name: '👤 Parrain', value: referrer.name, inline: true },
        { name: '🆕 Filleul', value: name, inline: true },
        { name: '💰 Commission', value: '10% sur chaque vente', inline: true }
      ];
      if (referral_same_ip) fields.push({ name: '⚠️ Alerte', value: 'Même IP que le parrain — double compte possible !', inline: false });
      await notifyDiscord2(DISCORD_REFERRAL, referral_same_ip ? '⚠️ Nouveau parrainage — DOUBLE COMPTE DÉTECTÉ' : '🤝 Nouveau parrainage !', referral_same_ip ? 0xff4757 : 0xa855f7, fields);
    }
  }
  // Get welcome message
  const { data: wmsg } = await supabase.from('settings').select('value').eq('key', 'welcome_message').single();
  // Send welcome email
  sendEmail(email, '🎉 Bienvenue sur AffiHub !', `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:16px;padding:32px;border:1px solid #222">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px;margin-bottom:8px">🎉</div>
        <h2 style="color:#F5C842;margin-bottom:4px">Bienvenue sur AffiHub !</h2>
        <p style="color:#aaa;font-size:14px">Bonjour <b style="color:#fff">${name}</b>, ton compte est prêt.</p>
      </div>
      <div style="background:#111;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:24px">
        <div style="margin-bottom:12px;display:flex;justify-content:space-between"><span style="color:#777">Nom</span><span style="color:#fff;font-weight:700">${name}</span></div>
        <div style="margin-bottom:12px;display:flex;justify-content:space-between"><span style="color:#777">Email</span><span style="color:#fff">${email}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#777">Code parrainage</span><span style="color:#F5C842;font-weight:800;font-family:monospace">${newCode}</span></div>
      </div>
      ${wmsg?.value ? `<div style="background:rgba(245,200,66,.06);border:1px solid rgba(245,200,66,.2);border-radius:12px;padding:16px;margin-bottom:24px"><p style="color:#F5C842;font-size:13px;line-height:1.7;margin:0">${wmsg.value}</p></div>` : ''}
      <div style="font-size:12px;color:#aaa;line-height:2">
        <div>✅ Retrait minimum : <b style="color:#fff">$25</b></div>
        <div>✅ Commission parrainage : <b style="color:#fff">10%</b></div>
        <div>✅ 7 moyens de paiement disponibles</div>
        <div>💬 Support Discord : <b style="color:#fff">ananous.</b></div>
      </div>
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid #222;text-align:center;color:#555;font-size:12px">AffiHub — Plateforme d'affiliation privée</div>
    </div>
  `);
  const token = jwt.sign({ id: data.id, email: data.email, role: data.role, name: data.name }, JWT_SECRET);
  log(data.id, 'inscription', 'Nouveau compte créé : '+name, req);
  // Discord notification
  await notifyDiscord2(DISCORD_REGISTER, '👤 Nouvel affilié !', 0x00D68F, [
    { name: '👤 Nom', value: name, inline: true },
    { name: '📧 Email', value: email, inline: true },
    { name: '🔗 Code parrainage', value: newCode, inline: true }
  ]);
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
  log(user.id, 'login', 'Connexion de '+user.name+' ('+user.role+')', req);
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, balance: user.balance, referral_code: user.referral_code, created_at: user.created_at, is_super_admin: user.is_super_admin || false, admin_permissions: user.admin_permissions || 'all' } });
});

// ── ME ──
app.get('/api/me', auth, async (req, res) => {
  let { data, error } = await supabase.from('users').select('id,name,email,role,balance,referral_code,created_at,show_ranking,is_super_admin,admin_permissions,postback_url,discord_id,referral_rate').eq('id', req.user.id).single();
  if (error) {
    console.error('/api/me erreur (colonne manquante ?):', error.message);
    const fallback = await supabase.from('users').select('id,name,email,role,balance,referral_code,created_at,show_ranking,is_super_admin,admin_permissions,postback_url').eq('id', req.user.id).single();
    data = fallback.data;
  }
  if (data) {
    try {
      const { data: convs } = await supabase.from('conversions').select('created_at').eq('user_id', req.user.id).eq('status', 'approved');
      const days = new Set((convs || []).map(c => new Date(c.created_at).toISOString().slice(0, 10)));
      let streak = 0;
      const cursor = new Date();
      const todayStr = cursor.toISOString().slice(0, 10);
      if (!days.has(todayStr)) cursor.setDate(cursor.getDate() - 1); // pas encore vendu aujourd'hui : ok tant qu'hier compte
      while (days.has(cursor.toISOString().slice(0, 10))) { streak++; cursor.setDate(cursor.getDate() - 1); }
      data.streak = streak;
    } catch (e) { data.streak = 0; }
  }
  res.json(data);
});

app.patch('/api/users/:id/permissions', auth, async (req, res) => {
  // Only super admin can change permissions
  const { data: me } = await supabase.from('users').select('is_super_admin').eq('id', req.user.id).single();
  if (!me?.is_super_admin) return res.status(403).json({ error: 'Non autorisé' });
  const { permissions } = req.body;
  await supabase.from('users').update({ admin_permissions: JSON.stringify(permissions) }).eq('id', req.params.id);
  log(req.user.id, 'permissions-modifiées', 'Permissions admin #'+req.params.id+' modifiées', req);
  res.json({ success: true });
});

// ── CHANGE PASSWORD ──
app.post('/api/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  const valid = user.password === current_password || await bcrypt.compare(current_password, user.password);
  if (!valid) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  const hash = await bcrypt.hash(new_password, 10);
  await supabase.from('users').update({ password: hash }).eq('id', req.user.id);
  log(req.user.id, 'mot-de-passe-changé', 'Mot de passe modifié', req);
  res.json({ success: true });
});

app.patch('/api/me/postback', auth, async (req, res) => {
  const { postback_url } = req.body;
  if (postback_url) {
    const test = postback_url.replace('{LINK_ID}', 'test').replace('{AMOUNT}', '1').replace('{STATUS}', 'approved');
    const safe = await isSafePostbackUrl(test);
    if (!safe) return res.status(400).json({ error: 'URL invalide ou non autorisée (adresse interne/privée refusée)' });
  }
  await supabase.from('users').update({ postback_url: postback_url || null }).eq('id', req.user.id);
  res.json({ success: true });
});
app.patch('/api/me/discord-id', auth, async (req, res) => {
  const { discord_id } = req.body;
  if (discord_id && !/^\d{15,25}$/.test(discord_id)) return res.status(400).json({ error: 'ID Discord invalide' });
  await supabase.from('users').update({ discord_id: discord_id || null }).eq('id', req.user.id);
  res.json({ success: true });
});

app.patch('/api/admin/users/:id/discord-id', auth, adminOnly, async (req, res) => {
  const { discord_id } = req.body;
  if (discord_id && !/^\d{15,25}$/.test(discord_id)) return res.status(400).json({ error: 'ID Discord invalide' });
  const { data: target } = await supabase.from('users').select('name,discord_id').eq('id', req.params.id).single();
  if (!target) return res.status(404).json({ error: 'Affilié introuvable' });
  await supabase.from('users').update({ discord_id: discord_id || null }).eq('id', req.params.id);
  if (discord_id) {
    log(req.user.id, 'id-discord-ajouté', 'ID Discord ' + (target.discord_id ? 'modifié' : 'ajouté') + ' pour ' + target.name, req);
  } else {
    log(req.user.id, 'id-discord-supprimé', 'ID Discord supprimé pour ' + target.name, req);
  }
  res.json({ success: true });
});

app.post('/api/admin/dm-all', auth, adminOnly, async (req, res) => {
  const { message, image_url, user_ids } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message requis' });
  let query = supabase.from('users').select('id,discord_id').eq('role', 'affiliate').not('discord_id', 'is', null);
  if (Array.isArray(user_ids) && user_ids.length > 0) query = query.in('id', user_ids);
  const { data: users } = await query;
  const targets = (users || []).filter(u => u.discord_id);
  let sent = 0, failed = 0;
  for (const u of targets) {
    const ok = await sendDiscordDMPlain(u.discord_id, message.trim(), image_url);
    if (ok) sent++; else failed++;
  }
  log(req.user.id, 'dm-groupé-discord', 'DM envoyé à ' + sent + '/' + targets.length + ' affiliés' + (image_url ? ' (avec image)' : '') + (Array.isArray(user_ids) && user_ids.length ? ' (sélection personnalisée)' : ''), req);
  await supabase.from('dm_broadcasts').insert({
    admin_id: req.user.id, message: message.trim(), image_url: image_url || null,
    target_count: targets.length, sent_count: sent, failed_count: failed,
    custom_selection: Array.isArray(user_ids) && user_ids.length > 0
  });
  res.json({ total: targets.length, sent, failed });
});

app.get('/api/admin/dm-broadcasts', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('dm_broadcasts').select('*, users(name)').order('created_at', { ascending: false }).limit(50);
  res.json(data || []);
});

// ── TRACKING CLIC ──
async function doRedirect(link, res) {
  await supabase.from('links').update({ clicks: link.clicks + 1 }).eq('id', link.id);
  const destination = link.custom_url || link.offers.url;
  const separator = destination.includes('?') ? '&' : '?';
  res.redirect(destination + separator + 'sub=' + link.id);
}
app.get('/go/:linkId', async (req, res) => {
  const { data: link } = await supabase.from('links').select('*, offers(url)').eq('id', req.params.linkId).single();
  if (!link || !link.active) return res.status(404).send('Lien invalide ou désactivé');
  await doRedirect(link, res);
});
// Liens vanity personnalisés (ex: /mathys-casino) — même suivi/postback que /go/:linkId, juste une autre porte d'entrée
const RESERVED_SLUGS = ['go', 'api', 'admin', 'login', 'register'];
app.get('/:slug', async (req, res, next) => {
  const slug = req.params.slug;
  if (RESERVED_SLUGS.includes(slug) || slug.startsWith('api')) return next();
  const { data: link } = await supabase.from('links').select('*, offers(url)').eq('custom_slug', slug).single();
  if (!link) return next();
  if (!link.active) return res.status(404).send('Lien invalide ou désactivé');
  await doRedirect(link, res);
});
app.patch('/api/links/:id/slug', auth, async (req, res) => {
  let { slug } = req.body;
  const { data: link } = await supabase.from('links').select('user_id').eq('id', req.params.id).single();
  if (!link) return res.status(404).json({ error: 'Lien introuvable' });
  if (req.user.role !== 'admin' && link.user_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  if (!slug || !slug.trim()) {
    await supabase.from('links').update({ custom_slug: null }).eq('id', req.params.id);
    return res.json({ success: true, slug: null });
  }
  slug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return res.status(400).json({ error: 'Texte invalide' });
  if (RESERVED_SLUGS.includes(slug)) return res.status(400).json({ error: 'Ce texte est réservé, choisis-en un autre' });
  const { data: taken } = await supabase.from('links').select('id').eq('custom_slug', slug).neq('id', req.params.id).single();
  if (taken) return res.status(400).json({ error: 'Ce lien personnalisé est déjà pris' });
  const { error } = await supabase.from('links').update({ custom_slug: slug }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, slug });
});

// Aperçu de la destination d'un lien, sans compter comme un clic
app.get('/api/links/:id/preview', auth, async (req, res) => {
  const { data: link } = await supabase.from('links').select('*, offers(url)').eq('id', req.params.id).single();
  if (!link) return res.status(404).json({ error: 'Lien invalide' });
  if (req.user.role !== 'admin' && link.user_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
  const destination = link.custom_url || link.offers.url;
  const separator = destination.includes('?') ? '&' : '?';
  res.json({ url: destination + separator + 'sub=' + link.id });
});

// ── POSTBACK CONVERSION ──
app.get('/api/postback', async (req, res) => {
  const { ref, amount, status, secret } = req.query;
  if (!process.env.POSTBACK_SECRET || secret !== process.env.POSTBACK_SECRET) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  if (!ref) return res.status(400).json({ error: 'ref manquant' });
  if (status === 'reversed') {
    const { data: conv } = await supabase.from('conversions').select('*, users(balance)').eq('link_id', ref).eq('status', 'approved').order('created_at', { ascending: false }).limit(1).single();
    if (conv) {
      await supabase.from('conversions').update({ status: 'rejected' }).eq('id', conv.id);
      const newBalance = Math.max(0, (conv.users?.balance || 0) - conv.amount);
      await supabase.from('users').update({ balance: newBalance }).eq('id', conv.user_id);
    }
    return res.json({ success: true, action: 'reversed' });
  }
  const { data: link } = await supabase.from('links').select('*, offers(commission,name), users(name)').eq('id', ref).single();
  if (!link || !link.active) return res.status(404).json({ error: 'Lien invalide' });
  const convAmount = link.offers?.commission || parseFloat(amount) || 10;
  const { data: conv, error } = await supabase.from('conversions').insert({ link_id: ref, user_id: link.user_id, offer_id: link.offer_id, amount: convAmount, status: 'approved' }).select().single();
  if (error) return res.status(500).json({ error: 'Erreur création conversion' });
  // Créditer le solde
  const { data: user } = await supabase.from('users').select('balance,referred_by,postback_url,discord_id').eq('id', link.user_id).single();
  if (user) {
    await supabase.from('users').update({ balance: user.balance + convAmount }).eq('id', link.user_id);
    await supabase.from('notifications').insert({ user_id: link.user_id, type: 'commission', message: '💰 Nouvelle vente créditée : $' + convAmount + ' (' + (link.offers?.name || '?') + ')', read: false });
    await checkCollectionComplete(link.user_id);
    // DM privé à l'affilié
    await sendDiscordDM(user.discord_id, '💰 Nouvelle vente créditée !', 0x00D68F, [
      { name: '🎯 Offre', value: link.offers?.name || '?', inline: true },
      { name: '💵 Montant', value: '$' + convAmount, inline: true }
    ]);
    // Commission parrainage
    if (user.referred_by) {
      const { data: referee } = await supabase.from('users').select('referral_active').eq('id', link.user_id).single();
      if (referee && referee.referral_active !== false) {
        const { data: referrer } = await supabase.from('users').select('balance,referral_rate').eq('id', user.referred_by).single();
        if (referrer) {
          const rate = (referrer.referral_rate ?? 10) / 100;
          const commission = parseFloat((convAmount * rate).toFixed(2));
          await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', user.referred_by);
          await supabase.from('referral_commissions').insert({ referrer_id: user.referred_by, referee_id: link.user_id, conversion_id: conv.id, amount: commission });
        }
      }
    }
    // Postback affilié
    if (user.postback_url) {
      const postbackUrl = user.postback_url.replace('{LINK_ID}', ref).replace('{AMOUNT}', convAmount).replace('{STATUS}', 'approved');
      isSafePostbackUrl(postbackUrl).then(safe => { if (safe) fetch(postbackUrl).catch(()=>{}); }).catch(()=>{});
    }
  }
  // Notify Discord
  await notifyDiscord(link.users?.name || '?', link.offers?.name || '?', convAmount);
  res.json({ success: true, conversion_id: conv.id });
});

app.post('/api/conversions/manual', auth, adminOnly, async (req, res) => {
  const { user_id, offer_id, amount, status } = req.body;
  if (!user_id || !offer_id || !amount) return res.status(400).json({ error: 'Champs requis' });
  // Find existing link or use null for manual conversions
  const { data: link } = await supabase.from('links').select('id').eq('user_id', user_id).eq('offer_id', offer_id).single();
  const link_id = link ? link.id : null;
  const { data: conv, error } = await supabase.from('conversions').insert({ link_id, user_id, offer_id, amount: parseFloat(amount), status: status || 'pending' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'conversion-ajoutée', 'Conversion manuelle de $' + amount + ' ajoutée (statut: ' + (status || 'pending') + ')', req);
  if (status === 'approved') {
    const { data: user } = await supabase.from('users').select('name,balance,referred_by,discord_id').eq('id', user_id).single();
    if (user) {
      await supabase.from('users').update({ balance: user.balance + parseFloat(amount) }).eq('id', user_id);
      const { data: offer } = await supabase.from('offers').select('name').eq('id', offer_id).single();
      await supabase.from('notifications').insert({ user_id, type: 'commission', message: '💰 Nouvelle vente créditée : $' + amount + ' (' + (offer?.name || '?') + ')', read: false });
      await checkCollectionComplete(user_id);
      await notifyDiscord(user.name || '?', offer?.name || '?', amount);
      await sendDiscordDM(user.discord_id, '💰 Nouvelle vente créditée !', 0x00D68F, [
        { name: '🎯 Offre', value: offer?.name || '?', inline: true },
        { name: '💵 Montant', value: '$' + amount, inline: true }
      ]);
      if (user.referred_by) {
        const { data: referee } = await supabase.from('users').select('referral_active').eq('id', user_id).single();
        if (referee && referee.referral_active !== false) {
          const { data: referrer } = await supabase.from('users').select('balance,referral_rate').eq('id', user.referred_by).single();
          if (referrer) {
            const rate = (referrer.referral_rate ?? 10) / 100;
            const commission = parseFloat((parseFloat(amount) * rate).toFixed(2));
            await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', user.referred_by);
            await supabase.from('referral_commissions').insert({ referrer_id: user.referred_by, referee_id: user_id, conversion_id: conv.id, amount: commission });
          }
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
  log(req.user.id, 'conversion-supprimée', 'Conversion #' + req.params.id + ' supprimée ($' + conv.amount + ')', req);
  res.json({ success: true });
});

// ── APPROVE CONVERSION + PARRAINAGE ──
app.patch('/api/conversions/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: conv } = await supabase.from('conversions').select('*, users(name), offers(name)').eq('id', req.params.id).single();
  if (!conv || conv.status !== 'pending') return res.status(400).json({ error: 'Conversion invalide' });
  await supabase.from('conversions').update({ status: 'approved' }).eq('id', req.params.id);
  log(req.user.id, 'conversion-approuvée', 'Conversion #'+req.params.id+' approuvée ($'+conv.amount+')', req);
  const { data: user } = await supabase.from('users').select('balance,referred_by,postback_url,discord_id').eq('id', conv.user_id).single();
  await supabase.from('users').update({ balance: user.balance + conv.amount }).eq('id', conv.user_id);
  await supabase.from('notifications').insert({ user_id: conv.user_id, type: 'commission', message: '💰 Nouvelle vente créditée : $' + conv.amount + ' (' + (conv.offers?.name || '?') + ')', read: false });
  await checkCollectionComplete(conv.user_id);
  // DM privé à l'affilié
  await sendDiscordDM(user.discord_id, '💰 Nouvelle vente créditée !', 0x00D68F, [
    { name: '🎯 Offre', value: conv.offers?.name || '?', inline: true },
    { name: '💵 Montant', value: '$' + conv.amount, inline: true }
  ]);
  // Notify Discord
  await notifyDiscord(conv.users?.name || '?', conv.offers?.name || '?', conv.amount);
  if (user.referred_by) {
    const { data: referee } = await supabase.from('users').select('referral_active').eq('id', conv.user_id).single();
    if (referee && referee.referral_active !== false) {
      const { data: referrer } = await supabase.from('users').select('balance,referral_rate').eq('id', user.referred_by).single();
      if (referrer) {
        const rate = (referrer.referral_rate ?? 10) / 100;
        const commission = parseFloat((conv.amount * rate).toFixed(2));
        await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', user.referred_by);
        await supabase.from('referral_commissions').insert({ referrer_id: user.referred_by, referee_id: conv.user_id, conversion_id: conv.id, amount: commission });
      }
    }
  }
  // Send postback to affiliate's own system if configured
  if (user.postback_url) {
    const postbackUrl = user.postback_url
      .replace('{LINK_ID}', conv.link_id || '')
      .replace('{AMOUNT}', conv.amount)
      .replace('{STATUS}', 'approved');
    isSafePostbackUrl(postbackUrl).then(safe => {
      if (safe) fetch(postbackUrl).catch(err => console.error('Postback affilié échoué:', err.message));
    }).catch(()=>{});
  }
  res.json({ success: true });
});

app.patch('/api/conversions/:id/reject', auth, adminOnly, async (req, res) => {
  await supabase.from('conversions').update({ status: 'rejected' }).eq('id', req.params.id);
  log(req.user.id, 'conversion-rejetée', 'Conversion #'+req.params.id+' rejetée', req);
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
// ── COLLECTION DE CARTES ──
async function getCollectionForUser(userId) {
  const { data: offers } = await supabase.from('offers').select('*').order('id');
  const { data: convs } = await supabase.from('conversions').select('offer_id,created_at').eq('user_id', userId).eq('status', 'approved').order('created_at');
  const { data: grants } = await supabase.from('manual_card_grants').select('offer_id,granted_at').eq('user_id', userId);
  const unlocked = {};
  (convs || []).forEach(c => {
    if (!unlocked[c.offer_id]) unlocked[c.offer_id] = { count: 0, first: c.created_at, manual: false };
    unlocked[c.offer_id].count++;
  });
  (grants || []).forEach(g => {
    if (!unlocked[g.offer_id]) unlocked[g.offer_id] = { count: 0, first: g.granted_at, manual: true };
  });
  return (offers || []).map(o => ({
    id: o.id, name: o.name, category: o.category, image_url: o.image_url,
    unlocked: !!unlocked[o.id],
    sales_count: unlocked[o.id]?.count || 0,
    unlocked_at: unlocked[o.id]?.first || null,
    manual: unlocked[o.id]?.manual || false
  }));
}
// Bonus de $50, versé une seule fois, quand la collection passe à 100%
async function checkCollectionComplete(userId) {
  try {
    const collection = await getCollectionForUser(userId);
    if (collection.length === 0 || !collection.every(c => c.unlocked)) return;
    const { data: user } = await supabase.from('users').select('balance,collection_bonus_claimed,discord_id').eq('id', userId).single();
    if (!user || user.collection_bonus_claimed) return;
    await supabase.from('users').update({ balance: user.balance + 50, collection_bonus_claimed: true }).eq('id', userId);
    await supabase.from('notifications').insert({ user_id: userId, type: 'collection_complete', message: '🎴 Collection complète ! $50 de bonus ajoutés à ton solde 🎉', read: false });
    await sendDiscordDM(user.discord_id, '🎴 Collection complète !', 0xE8B84B, [
      { name: '🏆 Bravo', value: 'Toutes les cartes débloquées !', inline: true },
      { name: '💰 Bonus', value: '$50 ajoutés à ton solde', inline: true }
    ]);
  } catch (e) { console.error('checkCollectionComplete error:', e.message); }
}

app.get('/api/me/collection', auth, async (req, res) => {
  res.json(await getCollectionForUser(req.user.id));
});
app.get('/api/admin/collection/:userId', auth, adminOnly, async (req, res) => {
  res.json(await getCollectionForUser(req.params.userId));
});
app.post('/api/admin/grant-card', auth, adminOnly, async (req, res) => {
  const { user_id, offer_id } = req.body;
  if (!user_id || !offer_id) return res.status(400).json({ error: 'user_id et offer_id requis' });
  const { data: existing } = await supabase.from('manual_card_grants').select('id').eq('user_id', user_id).eq('offer_id', offer_id).single();
  if (existing) return res.status(400).json({ error: 'Déjà débloquée manuellement' });
  const { error } = await supabase.from('manual_card_grants').insert({ user_id, offer_id, granted_by: req.user.id });
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'carte-débloquée-manuellement', 'Carte offre #' + offer_id + ' débloquée pour affilié #' + user_id, req);
  await checkCollectionComplete(user_id);
  res.json({ success: true });
});
app.delete('/api/admin/grant-card/:userId/:offerId', auth, adminOnly, async (req, res) => {
  await supabase.from('manual_card_grants').delete().eq('user_id', req.params.userId).eq('offer_id', req.params.offerId);
  log(req.user.id, 'carte-retirée', 'Déblocage manuel retiré (offre #' + req.params.offerId + ', affilié #' + req.params.userId + ')', req);
  res.json({ success: true });
});
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
  log(req.user.id, 'offre-créée', 'Offre "' + name + '" créée', req);
  res.json(data);
});
app.patch('/api/offers/:id', auth, adminOnly, async (req, res) => {
  const { name, description, url, commission, category, image_url, active } = req.body;
  if (active !== undefined && !name) {
    const { data, error } = await supabase.from('offers').update({ active }).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    log(req.user.id, 'offre-'+(active?'activée':'désactivée'), 'Offre "'+(data?.name||'#'+req.params.id)+'" '+(active?'activée':'désactivée'), req);
    return res.json(data);
  }
  if (!name || !url) return res.status(400).json({ error: 'Nom et URL requis' });
  const { data, error } = await supabase.from('offers').update({ name, description, url, commission: commission || 10, category: category || 'autre', image_url: image_url || null, active: active !== undefined ? active : true }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'offre-modifiée', 'Offre "'+name+'" modifiée', req);
  res.json(data);
});
app.delete('/api/offers/:id', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  const { data: offer } = await supabase.from('offers').select('name').eq('id', id).single();
  const { data: links } = await supabase.from('links').select('id').eq('offer_id', id);
  if (links && links.length > 0) {
    const linkIds = links.map(l => l.id);
    await supabase.from('conversions').delete().in('link_id', linkIds);
    await supabase.from('links').delete().eq('offer_id', id);
  }
  await supabase.from('offers').delete().eq('id', id);
  log(req.user.id, 'offre-supprimée', 'Offre "' + (offer?.name || '#' + id) + '" supprimée', req);
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
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = ''; for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  // Shorten the link
  const { data, error } = await supabase.from('links').insert({ id, user_id: req.user.id, offer_id, clicks: 0, active: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'lien-généré', 'Lien généré pour "'+( offer?.name||'offre #'+offer_id)+'" : '+id, req);
  res.json(data);
});
app.patch('/api/links/:id', auth, adminOnly, async (req, res) => {
  const { active } = req.body;
  const { data } = await supabase.from('links').update({ active }).eq('id', req.params.id).select().single();
  log(req.user.id, 'lien-'+(active?'activé':'désactivé'), 'Lien '+req.params.id+' '+(active?'activé':'désactivé')+' par admin', req);
  res.json(data);
});
app.delete('/api/links/:id', auth, async (req, res) => {
  const { data: link } = await supabase.from('links').select('user_id').eq('id', req.params.id).single();
  if (!link) return res.status(404).json({ error: 'Lien introuvable' });
  if (req.user.role !== 'admin' && link.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });
  // Détache les conversions existantes (garde l'historique + l'argent déjà crédité intact) avant de supprimer le lien
  const { error: detachErr } = await supabase.from('conversions').update({ link_id: null }).eq('link_id', req.params.id);
  if (detachErr) return res.status(500).json({ error: 'Suppression impossible : ' + detachErr.message });
  const { error } = await supabase.from('links').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Suppression impossible : ' + error.message });
  log(req.user.id, 'lien-supprimé', 'Lien '+req.params.id+' supprimé', req);
  res.json({ success: true });
});

// ── WITHDRAWALS ──
app.get('/api/withdrawals', auth, async (req, res) => {
  let query = supabase.from('withdrawals').select('*, users(name)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
});
const GIFT_CARDS = {
  playstation: { label: 'PlayStation', amounts: [20, 50] },
  xbox: { label: 'Xbox', amounts: [10, 25, 50] },
  roblox: { label: 'Roblox', amounts: [10, 20, 50] },
  nintendo: { label: 'Nintendo', amounts: [15, 25, 50, 75, 100] },
  twitch: { label: 'Twitch', amounts: [15, 25, 50] },
  amazon: { label: 'Amazon', amounts: [10, 25, 50] },
  zalando: { label: 'Zalando', amounts: [20, 50, 100] },
  airbnb: { label: 'Airbnb', amounts: [50] },
  footlocker: { label: 'Footlocker', amounts: [25, 50] },
  netflix: { label: 'Netflix', amounts: [25, 50, 100] },
  adidas: { label: 'Adidas', amounts: [25] },
  primark: { label: 'Primark', amounts: [15, 25] },
  flixbus: { label: 'FlixBus', amounts: [20, 50, 100] },
  safemoni: { label: 'Safemoni', amounts: [10, 20, 50] },
  tripgift: { label: 'Tripgift', amounts: [50, 100, 250] },
  hotelsgift: { label: 'Hotelsgift', amounts: [50, 100, 250] }
};

app.post('/api/withdrawals', auth, async (req, res) => {
  const { amount, crypto, address, gift_provider } = req.body;
  const { data: user } = await supabase.from('users').select('balance,name,discord_id').eq('id', req.user.id).single();
  if (!user) return res.status(400).json({ error: 'Utilisateur introuvable' });
  if (!user.discord_id) return res.status(400).json({ error: 'Renseigne ton ID Discord dans Paramètres avant de demander un retrait' });
  let finalAddress = address;
  if (crypto === 'CADEAU') {
    const card = GIFT_CARDS[gift_provider];
    if (!card) return res.status(400).json({ error: 'Carte cadeau invalide' });
    if (!card.amounts.includes(Number(amount))) return res.status(400).json({ error: 'Montant invalide pour cette carte' });
    if (amount < 25) return res.status(400).json({ error: 'Retrait minimum $25' });
    if (amount > user.balance) return res.status(400).json({ error: 'Solde insuffisant pour cette carte cadeau' });
    finalAddress = card.label + ' - $' + amount;
  } else {
    if (user.balance < 25) return res.status(400).json({ error: 'Solde insuffisant (minimum $25)' });
    if (amount < 25 || amount > user.balance) return res.status(400).json({ error: 'Montant invalide' });
  }
  await supabase.from('users').update({ balance: user.balance - amount }).eq('id', req.user.id);
  const { data } = await supabase.from('withdrawals').insert({ user_id: req.user.id, amount, crypto, address: finalAddress, status: 'pending' }).select().single();
  // Discord notification
  await notifyDiscord2(DISCORD_WITHDRAWAL, '💸 Demande de retrait !', 0xF0427A, [
    { name: '👤 Affilié', value: user.name, inline: true },
    { name: '💰 Montant', value: '$' + amount, inline: true },
    { name: '💳 Moyen', value: crypto === 'CADEAU' ? finalAddress : crypto, inline: true }
  ], '<@1504481208266915861>');
  log(req.user.id, 'retrait-demandé', 'Demande de $'+amount+' en '+crypto, req);
  res.json(data);
});
app.patch('/api/withdrawals/:id/approve', auth, adminOnly, async (req, res) => {
  const { data: wd } = await supabase.from('withdrawals').select('*, users(name)').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  await supabase.from('withdrawals').update({ status: 'paid' }).eq('id', req.params.id);
  // Discord notification
  log(req.user.id, 'retrait-payé', 'Retrait #'+req.params.id+' de $'+wd.amount+' payé à '+(wd.users?.name||'?'), req);
  await supabase.from('notifications').insert({ user_id: wd.user_id, type: 'withdrawal_paid', message: '💸 Ton retrait de $' + wd.amount + ' a été payé !', read: false });
  await notifyDiscord2(DISCORD_PAYMENT, '✅ Retrait payé !', 0x00D68F, [
    { name: '👤 Affilié', value: wd.users?.name || '?', inline: true },
    { name: '💰 Montant', value: '$' + wd.amount, inline: true },
    { name: '💳 Moyen', value: wd.crypto, inline: true }
  ]);
  res.json({ success: true });
});
app.patch('/api/withdrawals/:id/reject', auth, adminOnly, async (req, res) => {
  const { reason } = req.body;
  const { data: wd } = await supabase.from('withdrawals').select('*, users(name)').eq('id', req.params.id).single();
  if (!wd) return res.status(404).json({ error: 'Introuvable' });
  await supabase.from('withdrawals').update({ status: 'rejected', reason }).eq('id', req.params.id);
  const { data: user } = await supabase.from('users').select('balance').eq('id', wd.user_id).single();
  await supabase.from('users').update({ balance: user.balance + wd.amount }).eq('id', wd.user_id);
  // Discord notification
  log(req.user.id, 'retrait-rejeté', 'Retrait #'+req.params.id+' de '+(wd.users?.name||'?')+' rejeté', req);
  await supabase.from('notifications').insert({ user_id: wd.user_id, type: 'withdrawal_rejected', message: '❌ Ton retrait de $' + wd.amount + ' a été rejeté' + (reason ? ' : ' + reason : '') + '. Le montant a été remis sur ton solde.', read: false });
  await notifyDiscord2(DISCORD_PAYMENT, '❌ Retrait rejeté', 0xFF4757, [
    { name: '👤 Affilié', value: wd.users?.name || '?', inline: true },
    { name: '💰 Montant', value: '$' + wd.amount, inline: true },
    { name: '❓ Raison', value: reason || 'Non précisée', inline: true }
  ]);
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
  log(req.user.id, 'retrait-supprimé', 'Retrait de $' + wd.amount + ' supprimé', req);
  res.json({ success: true });
});

// ── USERS ──
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const { data: me } = await supabase.from('users').select('is_super_admin').eq('id', req.user.id).single();
  let query = supabase.from('users').select('id,name,email,role,balance,created_at,admin_note,admin_permissions,is_super_admin,discord_id');
  if (!me?.is_super_admin) {
    query = query.eq('role', 'affiliate');
  } else {
    query = query.neq('id', req.user.id); // don't show yourself
  }
  const { data } = await query.order('created_at', { ascending: false });
  const withGains = await Promise.all((data || []).map(async u => {
    const { data: convs } = await supabase.from('conversions').select('amount').eq('user_id', u.id).eq('status', 'approved');
    const { data: commissions } = await supabase.from('referral_commissions').select('amount').eq('referrer_id', u.id);
    const totalGains = (convs || []).reduce((s, c) => s + c.amount, 0) + (commissions || []).reduce((s, c) => s + c.amount, 0);
    return { ...u, totalGains: parseFloat(totalGains.toFixed(2)) };
  }));
  res.json(withGains);
});
app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  const uid = req.params.id;
  try {
    const { data: links } = await supabase.from('links').select('id').eq('user_id', uid);
    if (links && links.length > 0) {
      const linkIds = links.map(l => l.id);
      await supabase.from('conversions').delete().in('link_id', linkIds);
    }
    await supabase.from('activity_logs').delete().eq('user_id', uid);
    await supabase.from('notifications').delete().eq('user_id', uid);
    await supabase.from('announcements_read').delete().eq('user_id', uid);
    await supabase.from('conversions').delete().eq('user_id', uid);
    await supabase.from('links').delete().eq('user_id', uid);
    await supabase.from('withdrawals').delete().eq('user_id', uid);
    await supabase.from('referral_commissions').delete().eq('referrer_id', uid);
    await supabase.from('referral_commissions').delete().eq('referee_id', uid);
    await supabase.from('users').update({ referred_by: null }).eq('referred_by', uid);
    await supabase.from('custom_link_requests').delete().eq('user_id', uid);
    const { data: tickets } = await supabase.from('tickets').select('id').eq('user_id', uid);
    if (tickets && tickets.length > 0) {
      const ticketIds = tickets.map(t => t.id);
      await supabase.from('ticket_messages').delete().in('ticket_id', ticketIds);
    }
    await supabase.from('ticket_messages').delete().eq('user_id', uid);
    await supabase.from('tickets').delete().eq('user_id', uid);
    log(req.user.id, 'affilié-supprimé', 'Compte supprimé : '+uid, req);
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
  const { data: affiliates } = await supabase.from('users').select('id,name,email,balance,created_at,referral_code,referral_rate').eq('role','affiliate');
  const result = await Promise.all((affiliates||[]).map(async aff => {
    const { data: filleules } = await supabase.from('users').select('id,name,created_at,referral_active,referral_same_ip').eq('referred_by', aff.id);
    const { data: commissions } = await supabase.from('referral_commissions').select('*, users!referee_id(name), conversions(amount)').eq('referrer_id', aff.id).order('created_at',{ascending:false});
    const totalEarned = (commissions||[]).reduce((s,c)=>s+c.amount,0);
    return { ...aff, filleules: filleules||[], commissions: commissions||[], totalEarned };
  }));
  res.json(result.filter(a => a.filleules.length > 0 || a.commissions.length > 0));
});

app.patch('/api/admin/referral/:userId/toggle', auth, adminOnly, async (req, res) => {
  const { active } = req.body;
  const { data: u } = await supabase.from('users').select('name').eq('id', req.params.userId).single();
  await supabase.from('users').update({ referral_active: active }).eq('id', req.params.userId);
  log(req.user.id, 'parrainage-' + (active ? 'réactivé' : 'arrêté'), 'Parrainage ' + (active ? 'réactivé' : 'arrêté') + ' pour ' + (u?.name || '#' + req.params.userId), req);
  res.json({ success: true });
});

app.patch('/api/admin/referral/:userId/rate', auth, adminOnly, async (req, res) => {
  const { rate } = req.body;
  if (rate !== null && (isNaN(rate) || rate < 0 || rate > 100)) return res.status(400).json({ error: 'Taux invalide (0 à 100)' });
  const { data: u } = await supabase.from('users').select('name').eq('id', req.params.userId).single();
  await supabase.from('users').update({ referral_rate: rate === null || rate === '' ? null : parseFloat(rate) }).eq('id', req.params.userId);
  log(req.user.id, 'taux-parrainage-modifié', 'Taux de commission de ' + (u?.name || '#' + req.params.userId) + ' fixé à ' + (rate === null || rate === '' ? '10% (défaut)' : rate + '%'), req);
  res.json({ success: true });
});

app.post('/api/admin/referrals/link', auth, adminOnly, async (req, res) => {
  const { referrer_id, referee_id } = req.body;
  if (!referrer_id || !referee_id) return res.status(400).json({ error: 'Parrain et filleul requis' });
  if (referrer_id === referee_id) return res.status(400).json({ error: 'Un affilié ne peut pas être son propre parrain' });
  const { data: referrer } = await supabase.from('users').select('id,name').eq('id', referrer_id).single();
  const { data: referee } = await supabase.from('users').select('id,name,referred_by').eq('id', referee_id).single();
  if (!referrer || !referee) return res.status(404).json({ error: 'Affilié introuvable' });
  await supabase.from('users').update({ referred_by: referrer_id, referral_active: true }).eq('id', referee_id);
  log(req.user.id, 'parrainage-lié-manuellement', referrer.name + ' devient le parrain de ' + referee.name, req);
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
  log(req.user.id, 'classement-'+(show?'visible':'masqué'), 'Profil '+(show?'visible':'masqué')+' dans le classement', req);
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
  // Check if affiliate already has an open ticket
  if (req.user.role !== 'admin') {
    const { data: existing } = await supabase.from('tickets').select('id').eq('user_id', req.user.id).eq('status', 'open').single();
    if (existing) return res.status(400).json({ error: 'Tu as déjà un ticket ouvert. Ferme-le avant d\'en créer un nouveau.' });
  }
  const { data: ticket, error } = await supabase.from('tickets').insert({ user_id: req.user.id, reason, status: 'open' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('ticket_messages').insert({ ticket_id: ticket.id, user_id: req.user.id, content, image_url: image_url || null });
  // Discord notification
  const reasons = {'question':'❓ Question','bug':'🐛 Bug','payement':'💸 Paiement','compte':'👤 Compte','offre':'🎯 Offre','mes-liens':'🔗 Mes liens','suggestion':'💡 Suggestion'};
  log(req.user.id, 'ticket-créé', 'Ticket créé : '+reason, req);
  await notifyDiscord2(DISCORD_TICKET, '🎫 Nouveau ticket support !', 0x4D9EFF, [
    { name: '👤 Affilié', value: req.user.name, inline: true },
    { name: '🏷️ Raison', value: reasons[reason] || reason, inline: true },
    { name: '💬 Message', value: content.substring(0, 100) + (content.length > 100 ? '...' : ''), inline: false }
  ], '<@1504481208266915861>');
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
  log(req.user.id, 'ticket-'+status, 'Ticket #'+req.params.id+' '+(status==='resolved'?'résolu':status==='closed'?'fermé':'mis à jour'), req);
  res.json({ success: true });
});

app.delete('/api/tickets/:id', auth, adminOnly, async (req, res) => {
  const { data: t } = await supabase.from('tickets').select('reason,users(name)').eq('id', req.params.id).single();
  await supabase.from('ticket_messages').delete().eq('ticket_id', req.params.id);
  await supabase.from('tickets').delete().eq('id', req.params.id);
  log(req.user.id, 'ticket-supprimé', 'Ticket "' + (t?.reason || '?') + '" de ' + (t?.users?.name || '?') + ' supprimé', req);
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
  log(req.user.id, 'image-uploadée', 'Image "' + fileName + '" uploadée', req);
  res.json({ url: urlData.publicUrl });
});

// ── CUSTOM LINK REQUESTS ──
app.get('/api/custom-requests', auth, async (req, res) => {
  let query = supabase.from('custom_link_requests').select('*, users(name,email), offers(name), links(custom_slug,clicks)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data } = await query;
  res.json(data || []);
});

app.post('/api/custom-requests', auth, async (req, res) => {
  const { offer_id, server_name, slogan, tag1, tag2, tag3, logo_url, salons, photo1_url, photo2_url, photo3_url, photo4_url, photo5_url, photo6_url, photos_blurred, photo_text } = req.body;
  if (!server_name || !slogan || !tag1 || !tag2 || !tag3 || !salons) {
    return res.status(400).json({ error: 'Tous les champs texte sont obligatoires' });
  }
  if (Number(offer_id) === 54) {
    if (!logo_url || !photo_text) return res.status(400).json({ error: 'Logo et texte des photos obligatoires' });
    if (!photo1_url || !photo2_url || !photo3_url || !photo4_url || !photo5_url || !photo6_url) {
      return res.status(400).json({ error: 'Les 6 photos sont obligatoires' });
    }
  } else if (Number(offer_id) === 55) {
    if (!photo1_url || !photo2_url || !photo3_url || !photo4_url || !photo5_url) {
      return res.status(400).json({ error: 'Les 5 photos sont obligatoires' });
    }
  }
  const { data: offer } = await supabase.from('offers').select('name').eq('id', offer_id).single();
  // Ne fusionne qu'avec une demande encore EN ATTENTE (pas déjà approuvée), pour permettre plusieurs liens perso au fil du temps
  const { data: existing } = await supabase.from('custom_link_requests').select('id').eq('user_id', req.user.id).eq('offer_id', offer_id).eq('status', 'pending').single();
  if (existing) {
    const { data, error } = await supabase.from('custom_link_requests').update({ server_name, slogan, tag1, tag2, tag3, logo_url, salons, photo1_url, photo2_url, photo3_url, photo4_url, photo5_url, photo6_url, photos_blurred, photo_text, status: 'pending', updated_at: new Date() }).eq('id', existing.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    await sendDiscordChannelMsg('1541198868019159051', '🎨 Demande de lien perso (mise à jour)', 0xa855f7, [
      { name: '👤 Affilié', value: req.user.name, inline: true },
      { name: '🎯 Offre', value: offer?.name || '?', inline: true },
      { name: '🖥️ Serveur', value: server_name || '—', inline: true }
    ], '<@1504481208266915861>');
    return res.json(data);
  }
  const { data, error } = await supabase.from('custom_link_requests').insert({ user_id: req.user.id, offer_id, server_name, slogan, tag1, tag2, tag3, logo_url, salons, photo1_url, photo2_url, photo3_url, photo4_url, photo5_url, photo6_url, photos_blurred, photo_text }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await sendDiscordChannelMsg('1541198868019159051', '🎨 Nouvelle demande de lien perso !', 0xa855f7, [
    { name: '👤 Affilié', value: req.user.name, inline: true },
    { name: '🎯 Offre', value: offer?.name || '?', inline: true },
    { name: '🖥️ Serveur', value: server_name || '—', inline: true }
  ], '<@1504481208266915861>');
  res.json(data);
});

app.patch('/api/custom-requests/:id/link', auth, adminOnly, async (req, res) => {
  const { custom_link } = req.body;
  if (!custom_link || !custom_link.trim()) return res.status(400).json({ error: 'Lien de destination requis' });
  const { data: reqRow } = await supabase.from('custom_link_requests').select('user_id,offer_id').eq('id', req.params.id).single();
  if (!reqRow) return res.status(404).json({ error: 'Demande introuvable' });
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let linkId = ''; for (let i = 0; i < 6; i++) linkId += chars[Math.floor(Math.random() * chars.length)];
  const { error: linkErr } = await supabase.from('links').insert({ id: linkId, user_id: reqRow.user_id, offer_id: reqRow.offer_id, custom_url: custom_link.trim(), clicks: 0, active: true });
  if (linkErr) return res.status(500).json({ error: linkErr.message });
  const trackedUrl = req.protocol + '://' + req.get('host') + '/go/' + linkId;
  const { data, error } = await supabase.from('custom_link_requests').update({ custom_link: trackedUrl, link_id: linkId, status: 'approved', updated_at: new Date() }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const { data: offer } = await supabase.from('offers').select('name').eq('id', reqRow.offer_id).single();
  await supabase.from('notifications').insert({ user_id: reqRow.user_id, type: 'custom_link', message: '🎨 Ton lien personnalisé pour "' + (offer?.name || 'une offre') + '" a été envoyé, va le récupérer dans Mes liens !', read: false });
  log(req.user.id, 'lien-perso-envoyé', 'Lien personnalisé envoyé pour l\'offre "' + (offer?.name || '?') + '"', req);
  res.json(data);
});

app.delete('/api/custom-requests/:id', auth, adminOnly, async (req, res) => {
  const { data: r } = await supabase.from('custom_link_requests').select('server_name,users(name)').eq('id', req.params.id).single();
  await supabase.from('custom_link_requests').delete().eq('id', req.params.id);
  log(req.user.id, 'lien-perso-demande-supprimée', 'Demande de lien perso "' + (r?.server_name || '?') + '" de ' + (r?.users?.name || '?') + ' supprimée', req);
  res.json({ success: true });
});

// ── GLOBAL SETTINGS ──
app.get('/api/settings/all', auth, async (req, res) => {
  const { data } = await supabase.from('settings').select('*');
  const obj = {};
  (data || []).forEach(s => { obj[s.key] = s.value; });
  res.json({
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
  log(req.user.id, 'maintenance-'+(enabled?'activée':'désactivée'), 'Mode maintenance '+(enabled?'activé':'désactivé'), req);
  res.json({ success: true });
});

app.patch('/api/settings/welcome', auth, adminOnly, async (req, res) => {
  const { message } = req.body;
  await supabase.from('settings').upsert({ key: 'welcome_message', value: message || '' }, { onConflict: 'key' });
  log(req.user.id, 'message-bienvenue-modifié', 'Message de bienvenue modifié', req);
  res.json({ success: true });
});

app.patch('/api/settings/aff-links', auth, adminOnly, async (req, res) => {
  const { enabled } = req.body;
  await supabase.from('settings').upsert({ key: 'aff_links_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key' });
  log(req.user.id, 'reglage-mes-liens', 'Page "Mes liens" ' + (enabled ? 'activée' : 'désactivée'), req);
  res.json({ success: true });
});

app.patch('/api/settings/category', auth, adminOnly, async (req, res) => {
  const { category, enabled } = req.body;
  const valid = ['casino', 'dating', 'ia', 'autre', 'influenceuse'];
  if (!valid.includes(category)) return res.status(400).json({ error: 'Catégorie invalide' });
  await supabase.from('settings').upsert({ key: 'cat_' + category + '_enabled', value: enabled ? 'true' : 'false' }, { onConflict: 'key' });
  log(req.user.id, 'reglage-categorie', 'Catégorie "' + category + '" ' + (enabled ? 'activée' : 'désactivée'), req);
  res.json({ success: true });
});


// ── ANNOUNCEMENTS ──
app.get('/api/announcements', auth, async (req, res) => {
  if (req.user.role === 'admin') {
    const { data } = await supabase.from('announcements').select('*, users!created_by(name)').order('created_at', { ascending: false });
    return res.json(data || []);
  }
  const { data: read } = await supabase.from('announcements_read').select('announcement_id').eq('user_id', req.user.id);
  const readIds = (read || []).map(r => r.announcement_id);
  const { data: announcements } = await supabase.from('announcements').select('*').or('type.eq.global,target_user_id.eq.'+req.user.id).order('created_at', { ascending: false });
  const unread = (announcements || []).filter(a => !readIds.includes(a.id));
  res.json(unread);
});
app.post('/api/announcements', auth, adminOnly, async (req, res) => {
  const { title, message, type, target_user_id } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Titre et message requis' });
  const { data, error } = await supabase.from('announcements').insert({ title, message, type: type || 'global', target_user_id: target_user_id || null, created_by: req.user.id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'annonce-créée', 'Annonce "'+title+'" ('+(type||'global')+') créée', req);
  res.json(data);
});
app.post('/api/announcements/:id/read', auth, async (req, res) => {
  await supabase.from('announcements_read').upsert({ announcement_id: parseInt(req.params.id), user_id: req.user.id }, { onConflict: 'announcement_id,user_id' });
  res.json({ success: true });
});
app.delete('/api/announcements/:id', auth, adminOnly, async (req, res) => {
  const { data: ann } = await supabase.from('announcements').select('title').eq('id', req.params.id).single();
  await supabase.from('announcements_read').delete().eq('announcement_id', req.params.id);
  await supabase.from('announcements').delete().eq('id', req.params.id);
  log(req.user.id, 'annonce-supprimée', 'Annonce "'+(ann?.title||'#'+req.params.id)+'" supprimée', req);
  res.json({ success: true });
});

// ── LOGS ──
app.get('/api/logs', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('activity_logs').select('*, users(name,email,role)').order('created_at', { ascending: false }).limit(500);
  res.json(data || []);
});
app.delete('/api/logs/:id', auth, adminOnly, async (req, res) => {
  await supabase.from('activity_logs').delete().eq('id', req.params.id);
  log(req.user.id, 'log-supprimé', 'Entrée de log #' + req.params.id + ' supprimée', req);
  res.json({ success: true });
});
app.delete('/api/logs', auth, adminOnly, async (req, res) => {
  await supabase.from('activity_logs').delete().neq('id', 0);
  log(req.user.id, 'logs-purgés', 'Historique des logs entièrement vidé', req);
  res.json({ success: true });
});

// ── DISCORD SERVERS (bibliothèque de liens gérée par l'admin) ──
app.get('/api/discord-servers', auth, async (req, res) => {
  const { data } = await supabase.from('discord_servers').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});
app.post('/api/discord-servers', auth, adminOnly, async (req, res) => {
  const { name, categories, link } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!link || !link.trim()) return res.status(400).json({ error: 'Lien requis' });
  if (!categories || !categories.length) return res.status(400).json({ error: 'Choisis au moins une catégorie' });
  const cats = Array.isArray(categories) ? categories.join(',') : categories;
  const { data, error } = await supabase.from('discord_servers').insert({ name: name.trim(), categories: cats, link: link.trim() }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'discord-serveur-créé', 'Serveur Discord "' + name.trim() + '" créé', req);
  res.json(data);
});
app.patch('/api/discord-servers/:id', auth, adminOnly, async (req, res) => {
  const { name, categories, link } = req.body;
  const update = {};
  if (name !== undefined) update.name = name.trim();
  if (link !== undefined) update.link = link.trim();
  if (categories !== undefined) update.categories = Array.isArray(categories) ? categories.join(',') : categories;
  const { data, error } = await supabase.from('discord_servers').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'discord-serveur-modifié', 'Serveur Discord "' + (data?.name || '?') + '" modifié', req);
  res.json(data);
});
app.delete('/api/discord-servers/:id', auth, adminOnly, async (req, res) => {
  const { data: s } = await supabase.from('discord_servers').select('name').eq('id', req.params.id).single();
  await supabase.from('discord_servers').delete().eq('id', req.params.id);
  log(req.user.id, 'discord-serveur-supprimé', 'Serveur Discord "' + (s?.name || '?') + '" supprimé', req);
  res.json({ success: true });
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

// ── NOTES AFFILIÉS ──
app.patch('/api/users/:id/note', auth, adminOnly, async (req, res) => {
  const { note } = req.body;
  const { data: u } = await supabase.from('users').select('name').eq('id', req.params.id).single();
  await supabase.from('users').update({ admin_note: note }).eq('id', req.params.id);
  log(req.user.id, 'note-admin-modifiée', 'Note admin ' + (note ? 'mise à jour' : 'supprimée') + ' pour ' + (u?.name || '#' + req.params.id), req);
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

// Filet de sécurité (placé tout en dernier, après TOUTES les routes) : jamais de HTML renvoyé à une requête /api,
// et redirection simple vers l'accueil pour toute autre page inconnue
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route introuvable' });
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AffiHub running on port ${PORT}`));
