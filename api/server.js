const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.set('trust proxy', true);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// ⚠️ Si JWT_SECRET n'est pas défini dans les variables d'environnement, on génère un secret
// aléatoire à chaque démarrage plutôt que d'utiliser une valeur fixe en dur dans le code
// (l'ancienne valeur par défaut est désormais connue et donc invalidée pour de bon).
// CONSÉQUENCE si tu ne configures pas JWT_SECRET toi-même : tous les utilisateurs seront
// déconnectés à chaque redémarrage/déploiement du serveur (le secret change à chaque fois).
// Pour l'éviter, définis une vraie variable d'environnement JWT_SECRET sur ton hébergeur
// (une longue chaîne aléatoire, ex: générée avec `openssl rand -hex 32`), une seule fois.
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET non défini : un secret temporaire a été généré pour ce démarrage. Configure JWT_SECRET dans tes variables d\'environnement pour éviter que tous les utilisateurs soient déconnectés à chaque redéploiement.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── EMAIL ──
// Ces webhooks peuvent être surchargés via variables d'environnement (recommandé).
// Les valeurs en dur restent en fallback pour ne rien casser tant que tu n'as pas
// configuré les variables d'environnement — mais comme ces URLs ont déjà été vues/partagées,
// il vaut mieux les régénérer sur Discord (Paramètres du serveur → Intégrations → Webhooks
// → "Nouvelle URL de webhook") puis mettre les nouvelles dans tes variables d'environnement.
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_SALES || 'https://discord.com/api/webhooks/1526526889756332134/lCByUUSbUigvyW0TfTarZ14LxziWL6k_5iLbq_jwG8ecC9qHpFTOLFPbE9gKdqnbD_hX';
const DISCORD_REGISTER = process.env.DISCORD_WEBHOOK_REGISTER || 'https://discord.com/api/webhooks/1526534674317316106/DVjEe1IQmTYt7Xnyy37gyiJcABJoks4hpc5Z2v6dUSF3LYqXN0XJsfVRD7TnvwBKYvVo';
const DISCORD_WITHDRAWAL = process.env.DISCORD_WEBHOOK_WITHDRAWAL || 'https://discord.com/api/webhooks/1526535135003148411/T36o_LZh8U-GxnIJUEBPpagDCc52f5l00qX6va8fgj-lzUQacn3r1dtY5yh4FguLk3OX';
const DISCORD_PAYMENT = process.env.DISCORD_WEBHOOK_PAYMENT || 'https://discord.com/api/webhooks/1526535272437780600/RLIxROgmO64UPycLUJgbDN31kCuDIt7VpJmTgSSouYHolByFqZNeAB59k7ZjOm0u2qHa';
const DISCORD_TICKET = process.env.DISCORD_WEBHOOK_TICKET || 'https://discord.com/api/webhooks/1526535384685871146/q2VAq8dCK6Yd9K8fw6Q8U08JoD_-af2Ph8YZdrXeYyNlcdAZKpVHcXXi5GDKPpYw0dmN';
const DISCORD_REFERRAL = process.env.DISCORD_WEBHOOK_REFERRAL || 'https://discord.com/api/webhooks/1526536467168493658/SJ-Et9ONIpTC_YmCd7Ow_VZbOrO5FIGHB8MNaV9FcxolheQFmtf2pdou4za8UA8r73OD';
// Salon Discord dédié aux échanges de la boutique à jetons (posté via le bot, pas un webhook,
// pour pouvoir choisir de ping ou non selon le type d'offre échangée).
const DISCORD_SHOP_CHANNEL = process.env.DISCORD_SHOP_CHANNEL_ID || '1549396697560391760';
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID || '1504481208266915861';

// ── Rôle auto attribué à l'inscription ──
const DISCORD_GUILD_ID = '1520172933815730227';
const DISCORD_AFFILIATE_ROLE_ID = '1520173497048105170';

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

// Attribue un rôle à un membre du serveur Discord (nécessite DISCORD_BOT_TOKEN + que le bot
// ait la permission "Gérer les rôles" et soit positionné au-dessus du rôle ciblé)
async function assignDiscordRole(guildId, discordId, roleId) {
  if (!guildId || !discordId || !roleId || !process.env.DISCORD_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bot ' + process.env.DISCORD_BOT_TOKEN }
    });
    // 204 No Content = succès. Si le membre n'est pas (encore) sur le serveur, Discord renvoie 404.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Discord role assign error:', res.status, body);
      return false;
    }
    return true;
  } catch (e) { console.error('Discord role assign error:', e.message); return false; }
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
// Calcule et crédite la commission de parrainage pour une conversion donnée.
// Priorité du taux appliqué : taux personnalisé du filleul (referral_rate_override)
// > taux global du parrain (referral_rate) > 10% par défaut.
async function creditReferralCommission(refereeId, convAmount, conversionId) {
  const { data: referee } = await supabase.from('users').select('referred_by,referral_active,referral_rate_override').eq('id', refereeId).single();
  if (!referee || !referee.referred_by || referee.referral_active === false) return;
  const { data: referrer } = await supabase.from('users').select('balance,referral_rate').eq('id', referee.referred_by).single();
  if (!referrer) return;
  const rate = (referee.referral_rate_override ?? referrer.referral_rate ?? 10) / 100;
  const commission = parseFloat((convAmount * rate).toFixed(2));
  await supabase.from('users').update({ balance: referrer.balance + commission }).eq('id', referee.referred_by);
  await supabase.from('referral_commissions').insert({ referrer_id: referee.referred_by, referee_id: refereeId, conversion_id: conversionId, amount: commission });
}

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

// Cache très court (15s) pour éviter d'interroger la base à CHAQUE requête du site.
// La déconnexion forcée / obligation de changer de mot de passe reste quasi-instantanée
// (max 15s de délai) car on vide le cache immédiatement au moment de ces actions.
const authCache = new Map(); // userId -> { token_version, must_change_password, expiresAt }
const AUTH_CACHE_TTL_MS = 15000;
function invalidateAuthCache(userId) { authCache.delete(userId); }

async function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token invalide' }); }
  try {
    let u;
    const cached = authCache.get(payload.id);
    if (cached && cached.expiresAt > Date.now()) {
      u = cached;
    } else {
      // token_version permet de forcer une déconnexion à distance (ex: admin qui réinitialise
      // un mot de passe) : si la version en base a changé depuis l'émission de ce token, on refuse.
      const { data, error: uErr } = await supabase.from('users').select('token_version,must_change_password').eq('id', payload.id).single();
      if (uErr) {
        if (uErr.code === 'PGRST116') {
          // Aucune ligne trouvée pour cet id : le compte a réellement été supprimé, on bloque.
          return res.status(401).json({ error: 'Compte introuvable' });
        }
        // Toute autre erreur (ex: colonnes token_version/must_change_password pas encore créées
        // sur Supabase) ne doit PAS bloquer tout le site : on laisse passer avec les valeurs par
        // défaut plutôt que de renvoyer une erreur à chaque requête authentifiée.
        console.error('auth() erreur (colonne manquante ?):', uErr.message);
        req.user = payload;
        return next();
      }
      u = { ...data, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
      authCache.set(payload.id, u);
    }
    if (!u) return res.status(401).json({ error: 'Compte introuvable' });
    if ((payload.tokenVersion || 0) !== (u.token_version || 0)) {
      return res.status(401).json({ error: 'Session expirée, merci de te reconnecter.' });
    }
    req.user = payload;
    // Si un changement de mot de passe est obligatoire (ex: réinitialisé par un admin),
    // on bloque tout sauf la consultation du profil et le changement de mot de passe lui-même.
    if (u.must_change_password && req.path !== '/api/change-password' && req.path !== '/api/me') {
      return res.status(423).json({ error: 'Tu dois changer ton mot de passe avant de continuer.', code: 'MUST_CHANGE_PASSWORD' });
    }
    next();
  } catch (e) { return res.status(401).json({ error: 'Erreur d\'authentification' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin seulement' });
  next();
}

// Anti brute-force générique, sans dépendance externe (donc rien à installer,
// zéro risque de casser le déploiement). Bloque une IP après trop de requêtes.
// Note: en mémoire, donc reset si le serveur redémarre, et pas partagé entre plusieurs
// instances si jamais tu scales horizontalement un jour.
function makeRateLimiter(maxAttempts, windowMs) {
  const attempts = new Map(); // ip -> { count, firstAttempt }
  function middleware(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = attempts.get(ip);
    if (entry && now - entry.firstAttempt < windowMs && entry.count >= maxAttempts) {
      const waitMin = Math.ceil((windowMs - (now - entry.firstAttempt)) / 60000);
      return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${waitMin} min.` });
    }
    next();
  }
  function record(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.firstAttempt > windowMs) attempts.set(ip, { count: 1, firstAttempt: now });
    else entry.count++;
  }
  function clear(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    attempts.delete(ip);
  }
  return { middleware, record, clear };
}

const loginLimiter = makeRateLimiter(8, 15 * 60 * 1000); // 8 tentatives / 15 min
const loginRateLimit = loginLimiter.middleware;
const recordFailedLogin = loginLimiter.record;
const clearFailedLogin = loginLimiter.clear;

// Limite l'envoi de DM Discord de vérification à 5 par IP toutes les 10 minutes,
// pour empêcher que cette route publique soit utilisée pour spammer des gens via le bot.
const discordVerifyLimiter = makeRateLimiter(5, 10 * 60 * 1000);
const discordVerifyRateLimit = discordVerifyLimiter.middleware;

// ── REGISTER ──
// Vérifie qu'un ID Discord est valide en y envoyant un vrai message de test, avant même l'inscription
app.post('/api/verify-discord-id', discordVerifyRateLimit, async (req, res) => {
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
    checkReferralMilestone(referred_by).catch(()=>{});
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
  const token = jwt.sign({ id: data.id, email: data.email, role: data.role, name: data.name, tokenVersion: data.token_version || 0 }, JWT_SECRET, { expiresIn: '30d' });
  log(data.id, 'inscription', 'Nouveau compte créé : '+name, req);
  // Discord notification
  await notifyDiscord2(DISCORD_REGISTER, '👤 Nouvel affilié !', 0x00D68F, [
    { name: '👤 Nom', value: name, inline: true },
    { name: '📧 Email', value: email, inline: true },
    { name: '🔗 Code parrainage', value: newCode, inline: true }
  ]);
  // Attribution automatique du rôle Discord (en arrière-plan, ne bloque pas la réponse)
  assignDiscordRole(DISCORD_GUILD_ID, discord_id, DISCORD_AFFILIATE_ROLE_ID).then(ok => {
    if (!ok) console.error(`Rôle non attribué pour ${name} (discord_id: ${discord_id}) — vérifie qu'il est bien sur le serveur et que le bot a la permission requise.`);
  });
  res.json({ token, user: { id: data.id, name: data.name, email: data.email, role: data.role, balance: data.balance, referral_code: data.referral_code }, welcome_message: wmsg?.value || '' });
});

// ── LOGIN ──
app.post('/api/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user) { recordFailedLogin(req); return res.status(401).json({ error: 'Email ou mot de passe incorrect' }); }
  let valid = false;
  try { valid = await bcrypt.compare(password, user.password); } catch (e) { valid = false; }
  if (!valid && user.password === password) {
    // Compte legacy avec mot de passe stocké en clair : on l'accepte une dernière fois,
    // puis on le migre immédiatement en bcrypt pour fermer la faille sur ce compte.
    valid = true;
    const migratedHash = await bcrypt.hash(password, 10);
    await supabase.from('users').update({ password: migratedHash }).eq('id', user.id);
  }
  if (!valid) { recordFailedLogin(req); return res.status(401).json({ error: 'Email ou mot de passe incorrect' }); }
  clearFailedLogin(req);
  // Check maintenance mode for non-admin
  if (user.role !== 'admin') {
    const { data: maint } = await supabase.from('settings').select('value').eq('key', 'maintenance_mode').single();
    if (maint && maint.value === 'true') return res.status(403).json({ error: '🔧 Site en maintenance. Revenez bientôt !' });
  }
  log(user.id, 'login', 'Connexion de '+user.name+' ('+user.role+')', req);
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, tokenVersion: user.token_version || 0 }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, balance: user.balance, referral_code: user.referral_code, created_at: user.created_at, is_super_admin: user.is_super_admin || false, admin_permissions: user.admin_permissions || 'all', must_change_password: user.must_change_password || false } });
});

// ── ME ──
app.get('/api/me', auth, async (req, res) => {
  let { data, error } = await supabase.from('users').select('id,name,email,role,balance,referral_code,created_at,show_ranking,is_super_admin,admin_permissions,postback_url,discord_id,referral_rate,must_change_password,avatar_url,tokens,name_color,avatar_frame,owned_cosmetics').eq('id', req.user.id).single();
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
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères' });
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  let valid = false;
  try { valid = await bcrypt.compare(current_password, user.password); } catch (e) { valid = false; }
  if (!valid && user.password === current_password) valid = true; // compte legacy en clair — sera migré ci-dessous
  if (!valid) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  const hash = await bcrypt.hash(new_password, 10);
  await supabase.from('users').update({ password: hash, must_change_password: false }).eq('id', req.user.id);
  invalidateAuthCache(req.user.id);
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
  log(req.user.id, 'postback-modifié', postback_url ? 'URL de postback mise à jour : ' + postback_url : 'URL de postback supprimée', req);
  res.json({ success: true });
});
app.patch('/api/me/discord-id', auth, async (req, res) => {
  const { discord_id } = req.body;
  if (discord_id && !/^\d{15,25}$/.test(discord_id)) return res.status(400).json({ error: 'ID Discord invalide' });
  await supabase.from('users').update({ discord_id: discord_id || null }).eq('id', req.user.id);
  log(req.user.id, 'discord-id-modifié', discord_id ? 'ID Discord mis à jour : ' + discord_id : 'ID Discord supprimé', req);
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
    log(req.user.id, 'slug-lien-supprimé', 'Slug personnalisé retiré du lien #' + req.params.id, req);
    return res.json({ success: true, slug: null });
  }
  slug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return res.status(400).json({ error: 'Texte invalide' });
  if (RESERVED_SLUGS.includes(slug)) return res.status(400).json({ error: 'Ce texte est réservé, choisis-en un autre' });
  const { data: taken } = await supabase.from('links').select('id').eq('custom_slug', slug).neq('id', req.params.id).single();
  if (taken) return res.status(400).json({ error: 'Ce lien personnalisé est déjà pris' });
  const { error } = await supabase.from('links').update({ custom_slug: slug }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'slug-lien-modifié', 'Slug du lien #' + req.params.id + ' changé en "' + slug + '"', req);
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

  // ── ANTI-DOUBLON ──
  // addunlock (ou tout autre réseau) peut renvoyer le même postback plusieurs fois
  // (retry automatique si la réponse HTTP tarde, double envoi, etc.).
  // On vérifie donc si une conversion identique (même lien + même montant) vient
  // d'être créée il y a moins de 2 minutes avant d'en créer une nouvelle.
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: recentDuplicate } = await supabase
    .from('conversions')
    .select('id')
    .eq('link_id', ref)
    .eq('amount', convAmount)
    .gte('created_at', twoMinutesAgo)
    .limit(1)
    .maybeSingle();

  if (recentDuplicate) {
    // On répond "success" (pour qu'addunlock arrête de réessayer) sans rien recréditer
    return res.json({ success: true, conversion_id: recentDuplicate.id, duplicate: true });
  }

  const { data: conv, error } = await supabase.from('conversions').insert({ link_id: ref, user_id: link.user_id, offer_id: link.offer_id, amount: convAmount, status: 'approved' }).select().single();
  if (error) return res.status(500).json({ error: 'Erreur création conversion' });

  // Créditer le solde
  const { data: user } = await supabase.from('users').select('balance,referred_by,postback_url,discord_id').eq('id', link.user_id).single();
  if (user) {
    await supabase.from('users').update({ balance: user.balance + convAmount }).eq('id', link.user_id);
  }

  // ── On répond IMMÉDIATEMENT à addunlock une fois la conversion créditée. ──
  // Tout ce qui suit (Discord, notifications, parrainage, postback vers l'affilié)
  // ne doit plus bloquer la réponse HTTP : sinon, si Discord répond lentement,
  // addunlock peut timeout et renvoyer le postback -> doublon.
  res.json({ success: true, conversion_id: conv.id });

  // ── Tout ce qui suit s'exécute en arrière-plan, après la réponse ──
  if (user) {
    supabase.from('notifications').insert({ user_id: link.user_id, type: 'commission', message: '💰 Nouvelle vente créditée : $' + convAmount + ' (' + (link.offers?.name || '?') + ')', read: false }).then(()=>{}).catch(()=>{});
    checkCollectionComplete(link.user_id).catch(()=>{});
    // DM privé à l'affilié
    sendDiscordDM(user.discord_id, '💰 Nouvelle vente créditée !', 0x00D68F, [
      { name: '🎯 Offre', value: link.offers?.name || '?', inline: true },
      { name: '💵 Montant', value: '$' + convAmount, inline: true }
    ]).catch(()=>{});
    // Commission parrainage
    if (user.referred_by) {
      creditReferralCommission(link.user_id, convAmount, conv.id).catch(()=>{});
    }
    // Jetons de vente
    grantSaleTokens(link.user_id, conv.id).catch(()=>{});
    // Postback affilié
    if (user.postback_url) {
      const postbackUrl = user.postback_url.replace('{LINK_ID}', ref).replace('{AMOUNT}', convAmount).replace('{STATUS}', 'approved');
      isSafePostbackUrl(postbackUrl).then(safe => { if (safe) fetch(postbackUrl).catch(()=>{}); }).catch(()=>{});
    }
  }
  // Notify Discord
  notifyDiscord(link.users?.name || '?', link.offers?.name || '?', convAmount).catch(()=>{});
});

app.post('/api/conversions/manual', auth, adminOnly, async (req, res) => {
  const { user_id, offer_id, amount, status } = req.body;
  if (!user_id || !offer_id || !amount) return res.status(400).json({ error: 'Champs requis' });
  // Anti-doublon : évite qu'un double-clic ou un double envoi réseau crée deux fois
  // la même conversion manuelle (même affilié + même offre + même montant à quelques secondes d'écart).
  const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
  const { data: recentDuplicate } = await supabase.from('conversions').select('id').eq('user_id', user_id).eq('offer_id', offer_id).eq('amount', parseFloat(amount)).gte('created_at', tenSecondsAgo).limit(1).maybeSingle();
  if (recentDuplicate) return res.status(409).json({ error: 'Conversion identique déjà ajoutée il y a quelques secondes (doublon évité)' });
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
        await creditReferralCommission(user_id, parseFloat(amount), conv.id).catch(()=>{});
      }
      await grantSaleTokens(user_id, conv.id);
    }
  }
  res.json(conv);
});

app.delete('/api/conversions/:id', auth, adminOnly, async (req, res) => {
  const { data: conv } = await supabase.from('conversions').select('*').eq('id', req.params.id).single();
  if (!conv) return res.status(404).json({ error: 'Introuvable' });
  // If approved, remove amount from user balance (+ jetons accordés pour cette vente)
  if (conv.status === 'approved') {
    const { data: user } = await supabase.from('users').select('balance').eq('id', conv.user_id).single();
    if (user) await supabase.from('users').update({ balance: Math.max(0, user.balance - conv.amount) }).eq('id', conv.user_id);
    await revokeSaleTokens(conv.user_id, conv.tokens_granted);
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
    await creditReferralCommission(conv.user_id, conv.amount, conv.id).catch(()=>{});
  }
  await grantSaleTokens(conv.user_id, conv.id);
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
  const { reason } = req.body;
  const { data: conv } = await supabase.from('conversions').select('*, users(name,balance,discord_id), offers(name)').eq('id', req.params.id).single();
  if (!conv) return res.status(404).json({ error: 'Conversion introuvable' });
  if (conv.status === 'rejected') return res.status(409).json({ error: 'Cette conversion est déjà rejetée' });

  const wasApproved = conv.status === 'approved';
  let clawbackShortfall = 0;
  if (wasApproved && conv.users) {
    // Retire le montant du solde de l'affilié. S'il n'a plus assez (déjà retiré ailleurs),
    // on plafonne à 0 et on le signale dans les logs plutôt que de mettre le solde en négatif.
    const newBalance = conv.users.balance - conv.amount;
    if (newBalance < 0) clawbackShortfall = -newBalance;
    await supabase.from('users').update({ balance: Math.max(0, newBalance) }).eq('id', conv.user_id);
    // Retire aussi les jetons accordés pour cette vente, le cas échéant
    await revokeSaleTokens(conv.user_id, conv.tokens_granted);
  }

  await supabase.from('conversions').update({ status: 'rejected', reason: reason || null }).eq('id', req.params.id);
  log(req.user.id, 'conversion-rejetée', 'Conversion #'+req.params.id+' de $'+conv.amount+(wasApproved?' (était approuvée, solde retiré'+(clawbackShortfall>0?', manque $'+clawbackShortfall.toFixed(2)+' — solde déjà insuffisant':'')+')':'')+' rejetée'+(reason?' — raison : '+reason:''), req);

  if (conv.users) {
    await supabase.from('notifications').insert({ user_id: conv.user_id, type: 'conversion_rejected', message: '❌ Ta vente de $' + conv.amount + ' (' + (conv.offers?.name||'?') + ') a été rejetée' + (wasApproved?' et retirée de ton solde':'') + (reason ? ' : ' + reason : ''), read: false });
    if (conv.users.discord_id) {
      await sendDiscordDM(conv.users.discord_id, '❌ Conversion rejetée', 0xFF4757, [
        { name: '🎯 Offre', value: conv.offers?.name || '?', inline: true },
        { name: '💵 Montant', value: '$' + conv.amount, inline: true },
        ...(wasApproved ? [{ name: '⚠️ Solde', value: 'Retiré de ton solde', inline: true }] : []),
        ...(reason ? [{ name: '❓ Raison', value: reason, inline: false }] : [])
      ]);
    }
  }
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
  if (wd.status !== 'pending') return res.status(409).json({ error: 'Ce retrait a déjà été traité (statut actuel : ' + wd.status + ')' });
  await supabase.from('withdrawals').update({ status: 'paid' }).eq('id', req.params.id);
  await grantWithdrawalTokens(wd.user_id, wd.id, wd.amount);
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
  if (wd.status !== 'pending') return res.status(409).json({ error: 'Ce retrait a déjà été traité (statut actuel : ' + wd.status + ') — pas de remboursement en double.' });
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
  if (wd.status === 'paid' && wd.tokens_granted) {
    await revokeWithdrawalTokens(wd.user_id, wd.tokens_granted);
  }
  await supabase.from('withdrawals').delete().eq('id', req.params.id);
  log(req.user.id, 'retrait-supprimé', 'Retrait de $' + wd.amount + ' supprimé', req);
  res.json({ success: true });
});

// ── USERS ──
app.get('/api/users', auth, adminOnly, async (req, res) => {
  const { data: me } = await supabase.from('users').select('is_super_admin').eq('id', req.user.id).single();
  let query = supabase.from('users').select('id,name,email,role,balance,created_at,admin_note,admin_permissions,is_super_admin,discord_id,avatar_url,tokens,name_color,avatar_frame');
  if (!me?.is_super_admin) {
    query = query.eq('role', 'affiliate');
  } else {
    query = query.neq('id', req.user.id); // don't show yourself
  }
  const { data } = await query.order('created_at', { ascending: false });
  const withGains = await Promise.all((data || []).map(async u => {
    const [convsRes, commissionsRes] = await Promise.all([
      supabase.from('conversions').select('amount').eq('user_id', u.id).eq('status', 'approved'),
      supabase.from('referral_commissions').select('amount').eq('referrer_id', u.id)
    ]);
    const totalGains = (convsRes.data || []).reduce((s, c) => s + c.amount, 0) + (commissionsRes.data || []).reduce((s, c) => s + c.amount, 0);
    return { ...u, totalGains: parseFloat(totalGains.toFixed(2)) };
  }));
  res.json(withGains);
});
// Réinitialise le mot de passe d'un affilié avec celui choisi par l'admin.
// Force la déconnexion de toute session active et l'oblige à passer par un écran
// de changement de mot de passe dès sa prochaine connexion.
app.post('/api/users/:id/reset-password', auth, adminOnly, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
  const { data: target } = await supabase.from('users').select('name,discord_id,token_version').eq('id', req.params.id).single();
  if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const hash = await bcrypt.hash(newPassword, 10);
  // On incrémente token_version pour invalider immédiatement toute session déjà ouverte
  // (déconnexion forcée), et must_change_password pour l'obliger à en définir un nouveau
  // dès sa prochaine connexion, avant de pouvoir faire quoi que ce soit d'autre sur le site.
  await supabase.from('users').update({ password: hash, must_change_password: true, token_version: (target.token_version || 0) + 1 }).eq('id', req.params.id);
  invalidateAuthCache(req.params.id);
  log(req.user.id, 'mot-de-passe-réinitialisé', 'Mot de passe réinitialisé (+ déconnexion forcée) pour ' + (target.name || '#' + req.params.id), req);
  // Tentative d'envoi direct en DM Discord si l'affilié a un ID Discord renseigné
  let sentViaDiscord = false;
  if (target.discord_id) {
    sentViaDiscord = await sendDiscordDMPlain(target.discord_id, '🔑 Ton mot de passe AffiHub a été réinitialisé par un admin.\nNouveau mot de passe : `' + newPassword + '`\nConnecte-toi avec ce mot de passe, il te sera demandé d\'en choisir un nouveau immédiatement.');
  }
  res.json({ success: true, sentViaDiscord });
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
    const [filleulesRes, commissionsRes] = await Promise.all([
      supabase.from('users').select('id,name,created_at,referral_active,referral_same_ip,referral_rate_override').eq('referred_by', aff.id),
      supabase.from('referral_commissions').select('*, users!referee_id(name), conversions(amount)').eq('referrer_id', aff.id).order('created_at',{ascending:false})
    ]);
    const filleules = filleulesRes.data, commissions = commissionsRes.data;
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

// Taux personnalisé pour UN filleul précis (prend le dessus sur le taux global du parrain).
// :filleulId = l'id du filleul, pas du parrain.
app.patch('/api/admin/referral/filleul/:filleulId/rate', auth, adminOnly, async (req, res) => {
  const { rate } = req.body;
  if (rate !== null && rate !== '' && (isNaN(rate) || rate < 0 || rate > 100)) return res.status(400).json({ error: 'Taux invalide (0 à 100)' });
  const { data: filleul } = await supabase.from('users').select('name,referred_by').eq('id', req.params.filleulId).single();
  if (!filleul || !filleul.referred_by) return res.status(404).json({ error: 'Filleul introuvable ou non parrainé' });
  await supabase.from('users').update({ referral_rate_override: rate === null || rate === '' ? null : parseFloat(rate) }).eq('id', req.params.filleulId);
  log(req.user.id, 'taux-parrainage-filleul-modifié', 'Taux personnalisé de ' + (filleul.name || '#' + req.params.filleulId) + ' fixé à ' + (rate === null || rate === '' ? 'taux du parrain (par défaut)' : rate + '%'), req);
  res.json({ success: true });
});

// Suppression COMPLÈTE d'un lien de parrainage (contrairement à /toggle qui ne fait que le mettre en pause).
// Le filleul redevient "libre" (plus aucun parrain). L'historique des commissions déjà versées
// est conservé pour la comptabilité, mais aucune nouvelle commission ne sera générée.
app.delete('/api/admin/referral/:userId', auth, adminOnly, async (req, res) => {
  const { data: filleul } = await supabase.from('users').select('name,referred_by').eq('id', req.params.userId).single();
  if (!filleul || !filleul.referred_by) return res.status(404).json({ error: 'Ce parrainage n\'existe pas' });
  await supabase.from('users').update({ referred_by: null, referral_active: null, referral_rate_override: null, referral_same_ip: null }).eq('id', req.params.userId);
  log(req.user.id, 'parrainage-supprimé', 'Lien de parrainage supprimé pour ' + (filleul.name || '#' + req.params.userId), req);
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
  checkReferralMilestone(referrer_id).catch(()=>{});
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
  const { data: users } = await supabase.from('users').select('id,name,created_at,avatar_url,tokens,name_color,avatar_frame').eq('role','affiliate').eq('show_ranking',true);
  const result = await Promise.all((users||[]).map(async u => {
    const [convsRes, linksRes, referralRes] = await Promise.all([
      supabase.from('conversions').select('amount,status').eq('user_id',u.id),
      supabase.from('links').select('clicks').eq('user_id',u.id),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', u.id)
    ]);
    const approved = (convsRes.data||[]).filter(c=>c.status==='approved');
    const totalClicks = (linksRes.data||[]).reduce((s,l)=>s+l.clicks,0);
    return { ...u, totalConversions: approved.length, totalGains: approved.reduce((s,c)=>s+c.amount,0), totalClicks, referralCount: referralRes.count || 0 };
  }));
  res.json(result);
});

app.patch('/api/me/ranking', auth, async (req, res) => {
  const { show } = req.body;
  await supabase.from('users').update({ show_ranking: show }).eq('id', req.user.id);
  log(req.user.id, 'classement-'+(show?'visible':'masqué'), 'Profil '+(show?'visible':'masqué')+' dans le classement', req);
  res.json({ success: true });
});

// ── BADGES ──
// Calculés à la volée à partir des données existantes (pas de table dédiée nécessaire),
// donc automatiquement à jour pour les affiliés qui ont déjà fait ces actions par le passé.
app.get('/api/me/badges', auth, async (req, res) => {
  const [convsRes, referralRes, giftRes, wdRes, linksRes, customLinksRes] = await Promise.all([
    supabase.from('conversions').select('amount,created_at').eq('user_id', req.user.id).eq('status', 'approved'),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', req.user.id),
    supabase.from('gifts').select('id', { count: 'exact', head: true }).eq('sender_id', req.user.id).gte('amount', 5),
    supabase.from('withdrawals').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'paid'),
    supabase.from('links').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id),
    supabase.from('links').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).not('custom_slug', 'is', null)
  ]);
  const convs = convsRes.data;
  const referralCount = referralRes.count;
  const bigGiftCount = giftRes.count;
  const paidWithdrawals = wdRes.count;
  const linksCount = linksRes.count;
  const customLinksCount = customLinksRes.count;

  const salesCount = (convs || []).length;
  const totalGains = (convs || []).reduce((s, c) => s + c.amount, 0);

  const badges = [
    { id: 'first_sale', icon: '🥇', label: 'Première vente', desc: 'Réalise ta première vente', unlocked: salesCount >= 1, progress: Math.min(salesCount, 1), target: 1 },
    { id: 'sales_10', icon: '💎', label: '10 ventes', desc: 'Réalise 10 ventes', unlocked: salesCount >= 10, progress: Math.min(salesCount, 10), target: 10 },
    { id: 'sales_50', icon: '👑', label: '50 ventes', desc: 'Réalise 50 ventes', unlocked: salesCount >= 50, progress: Math.min(salesCount, 50), target: 50 },
    { id: 'gains_500', icon: '💰', label: '$500 cumulés', desc: 'Atteins $500 de gains au total', unlocked: totalGains >= 500, progress: Math.min(totalGains, 500), target: 500 },
    { id: 'gains_1000', icon: '🤑', label: '$1000 cumulés', desc: 'Atteins $1000 de gains au total', unlocked: totalGains >= 1000, progress: Math.min(totalGains, 1000), target: 1000 },
    { id: 'super_parrain', icon: '🏆', label: 'Super Parrain', desc: 'Parraine 5 affiliés', unlocked: (referralCount || 0) >= 5, progress: Math.min(referralCount || 0, 5), target: 5 },
    { id: 'gift_5', icon: '🎁', label: 'Généreux', desc: 'Envoie $5 ou plus à un autre affilié', unlocked: (bigGiftCount || 0) >= 1, progress: Math.min(bigGiftCount || 0, 1), target: 1 },
    { id: 'withdrawal_1', icon: '💵', label: 'Premier retrait', desc: 'Fais ton premier retrait', unlocked: (paidWithdrawals || 0) >= 1, progress: Math.min(paidWithdrawals || 0, 1), target: 1 },
    { id: 'withdrawal_5', icon: '💸', label: '5 retraits', desc: 'Fais 5 retraits', unlocked: (paidWithdrawals || 0) >= 5, progress: Math.min(paidWithdrawals || 0, 5), target: 5 },
    { id: 'withdrawal_10', icon: '🏦', label: '10 retraits', desc: 'Fais 10 retraits', unlocked: (paidWithdrawals || 0) >= 10, progress: Math.min(paidWithdrawals || 0, 10), target: 10 },
    { id: 'first_link', icon: '🔗', label: 'Premier lien', desc: 'Crée ton premier lien', unlocked: (linksCount || 0) >= 1, progress: Math.min(linksCount || 0, 1), target: 1 },
    { id: 'custom_link', icon: '🎨', label: 'Sur-mesure', desc: 'Personnalise ton premier lien', unlocked: (customLinksCount || 0) >= 1, progress: Math.min(customLinksCount || 0, 1), target: 1 }
  ];
  const unlockedCount = badges.filter(b => b.unlocked).length;

  // Bonus unique de $35 dès que TOUS les badges sont débloqués (une seule fois, même logique
  // que le bonus de collection complète).
  let bonusJustClaimed = false;
  if (unlockedCount === badges.length) {
    const { data: u } = await supabase.from('users').select('balance,badges_bonus_claimed,discord_id,name').eq('id', req.user.id).single();
    if (u && !u.badges_bonus_claimed) {
      await supabase.from('users').update({ balance: u.balance + 35, badges_bonus_claimed: true }).eq('id', req.user.id);
      await supabase.from('notifications').insert({ user_id: req.user.id, type: 'badges_complete', message: '🏅 Tous les badges débloqués ! $35 de bonus ajoutés à ton solde 🎉', read: false });
      log(req.user.id, 'badges-complétés', u.name + ' a débloqué tous les badges — $35 de bonus crédités', req);
      if (u.discord_id) {
        await sendDiscordDM(u.discord_id, '🏅 Tous les badges débloqués !', 0xE8B84B, [
          { name: '🏆 Bravo', value: 'Tu as débloqué tous les badges disponibles !', inline: true },
          { name: '💰 Bonus', value: '$35 ajoutés à ton solde', inline: true }
        ]);
      }
      bonusJustClaimed = true;
    }
  }
  res.json({ badges, unlockedCount, total: badges.length, bonusJustClaimed });
});

// ── MA SÉRIE (streak) ──
app.get('/api/me/streak', auth, async (req, res) => {
  const { data: convs } = await supabase.from('conversions').select('created_at').eq('user_id', req.user.id).eq('status', 'approved');
  const days = new Set((convs || []).map(c => new Date(c.created_at).toISOString().slice(0, 10)));

  let current = 0;
  const cursor = new Date();
  const todayStr = cursor.toISOString().slice(0, 10);
  if (!days.has(todayStr)) cursor.setDate(cursor.getDate() - 1);
  while (days.has(cursor.toISOString().slice(0, 10))) { current++; cursor.setDate(cursor.getDate() - 1); }

  let longest = 0, run = 0;
  const sortedDays = [...days].sort();
  for (let i = 0; i < sortedDays.length; i++) {
    if (i === 0 || (new Date(sortedDays[i]) - new Date(sortedDays[i - 1])) === 86400000) run++;
    else run = 1;
    longest = Math.max(longest, run);
  }

  // Les 35 derniers jours, pour un petit calendrier visuel façon "streak"
  const last35 = [];
  const d = new Date();
  for (let i = 34; i >= 0; i--) {
    const day = new Date(d);
    day.setDate(d.getDate() - i);
    const key = day.toISOString().slice(0, 10);
    last35.push({ date: key, hasSale: days.has(key) });
  }

  res.json({ current, longest, last35 });
});

// ── ROUE DE LA CHANCE ──
// Disponible une fois par semaine (reset chaque lundi), uniquement si l'affilié a réalisé
// au moins une vente approuvée depuis le début de la semaine en cours.
// Les segments (montants + probabilités) sont configurables depuis le panel admin, stockés
// en base (table settings, clé 'wheel_segments'). Ces valeurs par défaut ne servent que
// tant que l'admin n'a jamais rien personnalisé.
const DEFAULT_WHEEL_SEGMENTS = [
  { reward: 0, weight: 20, label: 'Perdu', type: 'money' },
  { reward: 1, weight: 30, label: '$1', type: 'money' },
  { reward: 2, weight: 20, label: '$2', type: 'money' },
  { reward: 5, weight: 15, label: '$5', type: 'money' },
  { reward: 10, weight: 10, label: '$10', type: 'money' },
  { reward: 20, weight: 8, label: '20 🪙', type: 'tokens' },
  { reward: 25, weight: 5, label: '$25 JACKPOT', type: 'money' }
];
async function getWheelSegments() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wheel_segments').single();
    if (!data?.value) return DEFAULT_WHEEL_SEGMENTS;
    const parsed = JSON.parse(data.value);
    if (!Array.isArray(parsed) || parsed.length < 2) return DEFAULT_WHEEL_SEGMENTS;
    // Rétrocompatibilité : les anciens segments enregistrés avant l'ajout du système
    // de jetons n'ont pas de champ "type" — on les considère comme des gains en $.
    return parsed.map(s => ({ ...s, type: s.type === 'tokens' ? 'tokens' : 'money' }));
  } catch (e) { return DEFAULT_WHEEL_SEGMENTS; }
}
function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=dimanche, 1=lundi...
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function pickWeightedSegment(segments) {
  const total = segments.reduce((s, seg) => s + seg.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < segments.length; i++) {
    r -= segments[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}
app.get('/api/me/wheel', auth, async (req, res) => {
  const monday = getMondayOf(new Date());
  const weekKey = monday.toISOString().slice(0, 10);
  const [{ data: user }, { count: salesThisWeek }, segments] = await Promise.all([
    supabase.from('users').select('last_wheel_week,last_wheel_reward,last_wheel_reward_type').eq('id', req.user.id).single(),
    supabase.from('conversions').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'approved').gte('created_at', monday.toISOString()),
    getWheelSegments()
  ]);
  const nextMonday = new Date(monday); nextMonday.setDate(nextMonday.getDate() + 7);
  res.json({
    eligible: (salesThisWeek || 0) >= 1,
    alreadySpun: user?.last_wheel_week === weekKey,
    lastReward: user?.last_wheel_week === weekKey ? user.last_wheel_reward : null,
    lastRewardType: user?.last_wheel_week === weekKey ? (user.last_wheel_reward_type || 'money') : null,
    nextResetAt: nextMonday.toISOString(),
    segments: segments.map(s => ({ label: s.label, reward: s.reward, type: s.type })) // le poids reste caché aux affiliés
  });
});
app.post('/api/me/wheel/spin', auth, async (req, res) => {
  const monday = getMondayOf(new Date());
  const weekKey = monday.toISOString().slice(0, 10);
  const { data: user } = await supabase.from('users').select('balance,tokens,last_wheel_week').eq('id', req.user.id).single();
  if (user?.last_wheel_week === weekKey) return res.status(409).json({ error: 'Tu as déjà tourné la roue cette semaine' });
  const { count: salesThisWeek } = await supabase.from('conversions').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('status', 'approved').gte('created_at', monday.toISOString());
  if (!salesThisWeek) return res.status(403).json({ error: 'Fais au moins une vente cette semaine pour débloquer la roue' });

  const segments = await getWheelSegments();
  const segmentIndex = pickWeightedSegment(segments);
  const seg = segments[segmentIndex];
  const reward = seg.reward;
  const isTokens = seg.type === 'tokens';
  const updates = { last_wheel_week: weekKey, last_wheel_reward: reward, last_wheel_reward_type: seg.type };
  if (isTokens) updates.tokens = (user.tokens || 0) + reward;
  else updates.balance = user.balance + reward;
  await supabase.from('users').update(updates).eq('id', req.user.id);
  await supabase.from('wheel_spins').insert({ user_id: req.user.id, reward, label: seg.label, reward_type: seg.type });
  log(req.user.id, 'roue-tournée', req.user.name + ' a tourné la roue et gagné ' + (isTokens ? reward + ' 🪙 jetons' : '$' + reward), req);
  res.json({ segmentIndex, reward, type: seg.type });
});

// Panel admin : consulter/modifier les segments de la roue
app.get('/api/admin/wheel-segments', auth, adminOnly, async (req, res) => {
  res.json(await getWheelSegments());
});
app.patch('/api/admin/wheel-segments', auth, adminOnly, async (req, res) => {
  const { segments } = req.body;
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > 15) {
    return res.status(400).json({ error: 'Il faut entre 2 et 15 segments' });
  }
  for (const s of segments) {
    if (typeof s.label !== 'string' || !s.label.trim()) return res.status(400).json({ error: 'Chaque segment doit avoir un nom' });
    if (typeof s.reward !== 'number' || s.reward < 0) return res.status(400).json({ error: 'Montant invalide (doit être ≥ 0)' });
    if (typeof s.weight !== 'number' || s.weight <= 0) return res.status(400).json({ error: 'Probabilité invalide (doit être > 0)' });
  }
  const cleaned = segments.map(s => ({ label: s.label.trim(), reward: s.reward, weight: s.weight, type: s.type === 'tokens' ? 'tokens' : 'money' }));
  await supabase.from('settings').upsert({ key: 'wheel_segments', value: JSON.stringify(cleaned) }, { onConflict: 'key' });
  log(req.user.id, 'roue-configurée', 'Segments de la roue de la chance mis à jour (' + cleaned.length + ' segments)', req);
  res.json({ success: true });
});

// Historique des tirages de l'affilié connecté
app.get('/api/me/wheel-history', auth, async (req, res) => {
  const { data } = await supabase.from('wheel_spins').select('reward,label,created_at,reward_type').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(30);
  res.json(data || []);
});

// ── AVATAR / PHOTO DE PROFIL ──
// L'image elle-même est uploadée directement depuis le front vers le bucket Supabase
// "avatars" (comme pour les images d'offres), puis on enregistre juste l'URL ici.
app.patch('/api/me/avatar', auth, async (req, res) => {
  const { avatar_url } = req.body;
  await supabase.from('users').update({ avatar_url: avatar_url || null }).eq('id', req.user.id);
  log(req.user.id, 'avatar-modifié', avatar_url ? 'Photo de profil mise à jour' : 'Photo de profil supprimée', req);
  res.json({ success: true });
});

// ── JETONS — MOYENS D'EN OBTENIR (liste informative) ──
// Stockés dans la table settings (comme les segments de la roue), sous forme de tableau JSON.
const DEFAULT_TOKEN_METHODS = [
  { id: 'm1', icon: '🔁', title: 'Réaliser une vente', description: 'Chaque conversion approuvée te rapporte des jetons en plus de ta commission.', tokens: 5, active: true },
  { id: 'm2', icon: '💸', title: 'Faire un retrait', description: 'Jetons offerts selon le montant retiré, une fois le retrait payé : $25-$50 → 5 🪙 · $50-$100 → 10 🪙 · $100-$500 → 20 🪙 · $500 et plus → 25 🪙.', tokens: 0, active: true },
  { id: 'm3', icon: '🎁', title: 'Faire un cadeau à un affilié', description: 'Envoie un cadeau à un autre affilié et gagne des jetons à chaque envoi.', tokens: 5, active: true },
  { id: 'm4', icon: '🤝', title: 'Parrainer 5 personnes', description: 'Atteins 5 filleuls parrainés et reçois un gros bonus de jetons, une seule fois.', tokens: 10, active: true },
  { id: 'm5', icon: '🎡', title: 'Tourner la roue de la chance', description: 'Un tour gratuit chaque semaine (si tu as fait une vente) — certains lots rapportent directement des jetons.', tokens: 0, active: true }
];
async function getTokenMethods() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'token_earn_methods').single();
    if (!data?.value) return DEFAULT_TOKEN_METHODS;
    const parsed = JSON.parse(data.value);
    if (!Array.isArray(parsed)) return DEFAULT_TOKEN_METHODS;
    return parsed;
  } catch (e) { return DEFAULT_TOKEN_METHODS; }
}
app.get('/api/token-methods', auth, async (req, res) => {
  const methods = await getTokenMethods();
  res.json(req.user.role === 'admin' ? methods : methods.filter(m => m.active !== false));
});
app.patch('/api/admin/token-methods', auth, adminOnly, async (req, res) => {
  const { methods } = req.body;
  if (!Array.isArray(methods)) return res.status(400).json({ error: 'Liste invalide' });
  for (const m of methods) {
    if (typeof m.title !== 'string' || !m.title.trim()) return res.status(400).json({ error: 'Chaque moyen doit avoir un titre' });
  }
  const cleaned = methods.map((m, i) => ({
    id: m.id || 'm' + Date.now() + '_' + i,
    icon: (m.icon || '🎟️').toString().slice(0, 8),
    title: m.title.trim(),
    description: (m.description || '').toString().trim(),
    tokens: parseInt(m.tokens) || 0,
    active: m.active !== false
  }));
  await supabase.from('settings').upsert({ key: 'token_earn_methods', value: JSON.stringify(cleaned) }, { onConflict: 'key' });
  log(req.user.id, 'jetons-moyens-modifiés', 'Moyens d\'obtenir des jetons mis à jour (' + cleaned.length + ')', req);
  res.json(cleaned);
});
// Réinitialise la liste à sa valeur par défaut (utile si elle a été enregistrée
// avant une mise à jour des textes par défaut côté code).
app.post('/api/admin/token-methods/reset', auth, adminOnly, async (req, res) => {
  await supabase.from('settings').delete().eq('key', 'token_earn_methods');
  log(req.user.id, 'jetons-moyens-réinitialisés', 'Liste des moyens d\'obtenir des jetons réinitialisée aux valeurs par défaut', req);
  res.json(DEFAULT_TOKEN_METHODS);
});

// ── JETONS — CRÉDIT RÉEL AUTOMATIQUE PAR VENTE ──
// Nombre de jetons accordés à chaque conversion approuvée (réglable par l'admin).
// Le montant réellement accordé est mémorisé sur la conversion elle-même
// (colonne tokens_granted) pour pouvoir le retirer proprement en cas de rejet/suppression,
// même si l'admin change ensuite ce réglage.
async function getTokensPerSale() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'tokens_per_sale').single();
    const n = parseInt(data?.value);
    return Number.isFinite(n) && n >= 0 ? n : 5;
  } catch (e) { return 5; }
}
app.patch('/api/admin/settings/tokens-per-sale', auth, adminOnly, async (req, res) => {
  const n = parseInt(req.body.tokens_per_sale);
  if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Valeur invalide' });
  await supabase.from('settings').upsert({ key: 'tokens_per_sale', value: String(n) }, { onConflict: 'key' });
  log(req.user.id, 'jetons-par-vente-modifié', 'Jetons accordés par vente réglés sur ' + n, req);
  res.json({ success: true, tokens_per_sale: n });
});
// Crédite les jetons d'une vente qui vient d'être approuvée (appelé depuis les différents
// endroits où une conversion passe au statut "approved"). Best-effort : une erreur ici
// ne doit jamais faire échouer l'approbation de la vente elle-même.
async function grantSaleTokens(userId, conversionId) {
  try {
    const amount = await getTokensPerSale();
    if (amount <= 0) return;
    const { data: user } = await supabase.from('users').select('tokens').eq('id', userId).single();
    await supabase.from('users').update({ tokens: (user?.tokens || 0) + amount }).eq('id', userId);
    await supabase.from('conversions').update({ tokens_granted: amount }).eq('id', conversionId);
  } catch (e) { console.error('grantSaleTokens error:', e.message); }
}
// Retire les jetons précédemment accordés pour une conversion (rejet / suppression d'une vente
// déjà approuvée). Utilise le montant mémorisé sur la conversion, pas le réglage actuel.
async function revokeSaleTokens(userId, tokensGranted) {
  try {
    if (!tokensGranted) return;
    const { data: user } = await supabase.from('users').select('tokens').eq('id', userId).single();
    await supabase.from('users').update({ tokens: Math.max(0, (user?.tokens || 0) - tokensGranted) }).eq('id', userId);
  } catch (e) { console.error('revokeSaleTokens error:', e.message); }
}

// Rattrapage rétroactif : attribue les jetons pour toutes les ventes déjà approuvées
// avant l'existence de ce système (tokens_granted encore à 0/NULL).
app.post('/api/admin/tokens/backfill', auth, adminOnly, async (req, res) => {
  const amount = await getTokensPerSale();
  const { data: convs, error } = await supabase.from('conversions').select('id,user_id').eq('status', 'approved').or('tokens_granted.is.null,tokens_granted.eq.0');
  if (error) return res.status(500).json({ error: error.message });
  const perUser = {};
  (convs || []).forEach(c => { perUser[c.user_id] = (perUser[c.user_id] || 0) + amount; });
  for (const userId of Object.keys(perUser)) {
    const { data: user } = await supabase.from('users').select('tokens').eq('id', userId).single();
    await supabase.from('users').update({ tokens: (user?.tokens || 0) + perUser[userId] }).eq('id', userId);
  }
  if (amount > 0 && (convs || []).length > 0) {
    await supabase.from('conversions').update({ tokens_granted: amount }).eq('status', 'approved').or('tokens_granted.is.null,tokens_granted.eq.0');
  }
  log(req.user.id, 'jetons-rattrapage', 'Rattrapage rétroactif : ' + (convs || []).length + ' vente(s) traitée(s), ' + Object.keys(perUser).length + ' affilié(s) crédité(s)', req);
  res.json({ success: true, conversionsUpdated: (convs || []).length, usersCredited: Object.keys(perUser).length, tokensPerSale: amount });
});

// Attribution manuelle de jetons à un affilié (pour tous les "moyens" listés qui ne
// sont pas branchés automatiquement : parrainage, événement spécial, bonus ponctuel...).
// Un montant négatif permet aussi de retirer des jetons si besoin.
app.post('/api/admin/tokens/grant', auth, adminOnly, async (req, res) => {
  const { user_id, amount, reason } = req.body;
  const amt = parseInt(amount);
  if (!user_id) return res.status(400).json({ error: 'Affilié requis' });
  if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: 'Montant invalide' });
  const { data: user } = await supabase.from('users').select('name,tokens,discord_id').eq('id', user_id).single();
  if (!user) return res.status(404).json({ error: 'Affilié introuvable' });
  const newTokens = Math.max(0, (user.tokens || 0) + amt);
  await supabase.from('users').update({ tokens: newTokens }).eq('id', user_id);
  log(req.user.id, 'jetons-attribués', (amt > 0 ? '+' : '') + amt + ' 🪙 pour ' + user.name + (reason ? ' — ' + reason : ''), req);
  await supabase.from('notifications').insert({ user_id, type: 'tokens_grant', message: (amt > 0 ? '🪙 Tu as reçu ' + amt + ' jetons !' : '🪙 ' + Math.abs(amt) + ' jetons ont été retirés') + (reason ? ' : ' + reason : ''), read: false });
  if (user.discord_id) {
    await sendDiscordDM(user.discord_id, amt > 0 ? '🪙 Jetons reçus !' : '🪙 Jetons retirés', amt > 0 ? 0xF5C842 : 0xFF4757, [
      { name: '🪙 Montant', value: (amt > 0 ? '+' : '') + amt, inline: true },
      ...(reason ? [{ name: '📝 Raison', value: reason, inline: false }] : [])
    ]);
  }
  res.json({ success: true, tokens: newTokens });
});

// ── JETONS — RETRAITS PAR PALIER ──
// Réglable par l'admin : une liste de paliers {min, max, tokens}. On applique le premier
// palier où min <= montant <= max. Accordé quand le retrait passe au statut "payé"
// (pas juste demandé), pour éviter d'accorder des jetons sur un retrait jamais honoré.
const DEFAULT_WITHDRAWAL_TIERS = [
  { min: 25, max: 50, tokens: 5 },
  { min: 50, max: 100, tokens: 10 },
  { min: 100, max: 500, tokens: 20 },
  { min: 500, max: 999999999, tokens: 25 }
];
async function getWithdrawalTokenTiers() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'withdrawal_token_tiers').single();
    if (!data?.value) return DEFAULT_WITHDRAWAL_TIERS;
    const parsed = JSON.parse(data.value);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_WITHDRAWAL_TIERS;
    return parsed;
  } catch (e) { return DEFAULT_WITHDRAWAL_TIERS; }
}
app.get('/api/admin/withdrawal-tiers', auth, adminOnly, async (req, res) => {
  res.json(await getWithdrawalTokenTiers());
});
app.patch('/api/admin/withdrawal-tiers', auth, adminOnly, async (req, res) => {
  const { tiers } = req.body;
  if (!Array.isArray(tiers) || tiers.length === 0) return res.status(400).json({ error: 'Liste invalide' });
  for (const t of tiers) {
    if (typeof t.min !== 'number' || typeof t.max !== 'number' || t.min < 0 || t.max <= t.min) return res.status(400).json({ error: 'Chaque palier doit avoir un min < max valides' });
    if (typeof t.tokens !== 'number' || t.tokens < 0) return res.status(400).json({ error: 'Jetons invalides (doit être ≥ 0)' });
  }
  const cleaned = tiers.map(t => ({ min: t.min, max: t.max, tokens: t.tokens })).sort((a, b) => a.min - b.min);
  await supabase.from('settings').upsert({ key: 'withdrawal_token_tiers', value: JSON.stringify(cleaned) }, { onConflict: 'key' });
  log(req.user.id, 'jetons-paliers-retrait-modifiés', 'Paliers de jetons par retrait mis à jour (' + cleaned.length + ')', req);
  res.json(cleaned);
});
function tokensForWithdrawalAmount(amount, tiers) {
  const tier = tiers.find(t => amount >= t.min && amount <= t.max);
  return tier ? tier.tokens : 0;
}
async function grantWithdrawalTokens(userId, withdrawalId, amount) {
  try {
    const tiers = await getWithdrawalTokenTiers();
    const tokensAmount = tokensForWithdrawalAmount(amount, tiers);
    if (tokensAmount <= 0) return;
    const { data: user } = await supabase.from('users').select('tokens').eq('id', userId).single();
    await supabase.from('users').update({ tokens: (user?.tokens || 0) + tokensAmount }).eq('id', userId);
    await supabase.from('withdrawals').update({ tokens_granted: tokensAmount }).eq('id', withdrawalId);
  } catch (e) { console.error('grantWithdrawalTokens error:', e.message); }
}
async function revokeWithdrawalTokens(userId, tokensGranted) {
  try {
    if (!tokensGranted) return;
    const { data: user } = await supabase.from('users').select('tokens').eq('id', userId).single();
    await supabase.from('users').update({ tokens: Math.max(0, (user?.tokens || 0) - tokensGranted) }).eq('id', userId);
  } catch (e) { console.error('revokeWithdrawalTokens error:', e.message); }
}

// ── JETONS — CADEAU ENTRE AFFILIÉS ──
async function getGiftTokens() {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'gift_tokens').single();
    const n = parseInt(data?.value);
    return Number.isFinite(n) && n >= 0 ? n : 5;
  } catch (e) { return 5; }
}
app.patch('/api/admin/settings/gift-tokens', auth, adminOnly, async (req, res) => {
  const n = parseInt(req.body.gift_tokens);
  if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Valeur invalide' });
  await supabase.from('settings').upsert({ key: 'gift_tokens', value: String(n) }, { onConflict: 'key' });
  log(req.user.id, 'jetons-cadeau-modifié', 'Jetons par cadeau envoyé réglés sur ' + n, req);
  res.json({ success: true, gift_tokens: n });
});

// ── JETONS — PALIER DE PARRAINAGE ──
// Bonus unique (pas répétable) quand un affilié atteint le nombre de filleuls requis.
async function getReferralMilestoneSettings() {
  try {
    const { data } = await supabase.from('settings').select('key,value').in('key', ['referral_milestone_count', 'referral_milestone_tokens']);
    const obj = {};
    (data || []).forEach(s => { obj[s.key] = s.value; });
    const count = parseInt(obj.referral_milestone_count);
    const tokens = parseInt(obj.referral_milestone_tokens);
    return {
      count: Number.isFinite(count) && count > 0 ? count : 5,
      tokens: Number.isFinite(tokens) && tokens >= 0 ? tokens : 10
    };
  } catch (e) { return { count: 5, tokens: 10 }; }
}
app.patch('/api/admin/settings/referral-milestone', auth, adminOnly, async (req, res) => {
  const count = parseInt(req.body.count);
  const tokens = parseInt(req.body.tokens);
  if (!Number.isFinite(count) || count <= 0) return res.status(400).json({ error: 'Nombre de filleuls invalide' });
  if (!Number.isFinite(tokens) || tokens < 0) return res.status(400).json({ error: 'Jetons invalides' });
  await supabase.from('settings').upsert([
    { key: 'referral_milestone_count', value: String(count) },
    { key: 'referral_milestone_tokens', value: String(tokens) }
  ], { onConflict: 'key' });
  log(req.user.id, 'jetons-palier-parrainage-modifié', 'Palier de parrainage réglé sur ' + count + ' filleuls → ' + tokens + ' jetons', req);
  res.json({ success: true, count, tokens });
});
// Vérifie si un parrain vient d'atteindre le palier de filleuls, et le crédite une seule fois.
async function checkReferralMilestone(referrerId) {
  try {
    const { count: total } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', referrerId);
    const { count, tokens } = await getReferralMilestoneSettings();
    if ((total || 0) < count || tokens <= 0) return;
    const { data: referrer } = await supabase.from('users').select('name,tokens,referral_milestone_claimed,discord_id').eq('id', referrerId).single();
    if (!referrer || referrer.referral_milestone_claimed) return;
    await supabase.from('users').update({ tokens: (referrer.tokens || 0) + tokens, referral_milestone_claimed: true }).eq('id', referrerId);
    await supabase.from('notifications').insert({ user_id: referrerId, type: 'referral_milestone', message: '🤝 Bravo, tu as parrainé ' + count + ' affiliés ! +' + tokens + ' 🪙 jetons bonus.', read: false });
    if (referrer.discord_id) {
      await sendDiscordDM(referrer.discord_id, '🤝 Palier de parrainage atteint !', 0xa855f7, [
        { name: '👥 Filleuls', value: String(count), inline: true },
        { name: '🪙 Bonus', value: '+' + tokens + ' jetons', inline: true }
      ]);
    }
  } catch (e) { console.error('checkReferralMilestone error:', e.message); }
}

// ── BOUTIQUE À JETONS ──
// Nécessite les tables "shop_items" et "shop_orders" + la colonne "tokens" sur "users"
// (voir le SQL fourni séparément pour la création de ces objets dans Supabase).
app.get('/api/shop/items', auth, async (req, res) => {
  let query = supabase.from('shop_items').select('*').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('active', true);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
app.post('/api/admin/shop/items', auth, adminOnly, async (req, res) => {
  const { title, description, image_url, price_tokens, item_type, cosmetic_type, cosmetic_value } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Titre requis' });
  const price = parseInt(price_tokens);
  if (!price || price <= 0) return res.status(400).json({ error: 'Prix en jetons invalide' });
  const isCosmetic = item_type === 'cosmetic';
  if (isCosmetic) {
    if (!['name_color', 'avatar_frame'].includes(cosmetic_type)) return res.status(400).json({ error: 'Type de personnalisation invalide' });
    if (!cosmetic_value) return res.status(400).json({ error: 'Valeur de personnalisation requise' });
  }
  const { data, error } = await supabase.from('shop_items').insert({
    title: title.trim(), description: (description || '').trim(), image_url: image_url || null, price_tokens: price, active: true,
    item_type: isCosmetic ? 'cosmetic' : 'normal',
    cosmetic_type: isCosmetic ? cosmetic_type : null,
    cosmetic_value: isCosmetic ? cosmetic_value : null
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'boutique-offre-créée', 'Offre boutique "' + title + '" créée (' + price + ' jetons)', req);
  res.json(data);
});
app.patch('/api/admin/shop/items/:id', auth, adminOnly, async (req, res) => {
  const { title, description, image_url, price_tokens, active, item_type, cosmetic_type, cosmetic_value } = req.body;
  const updates = {};
  if (title !== undefined) { if (!title.trim()) return res.status(400).json({ error: 'Titre requis' }); updates.title = title.trim(); }
  if (description !== undefined) updates.description = (description || '').trim();
  if (image_url !== undefined) updates.image_url = image_url || null;
  if (price_tokens !== undefined) { const p = parseInt(price_tokens); if (!p || p <= 0) return res.status(400).json({ error: 'Prix en jetons invalide' }); updates.price_tokens = p; }
  if (active !== undefined) updates.active = !!active;
  if (item_type !== undefined) {
    const isCosmetic = item_type === 'cosmetic';
    updates.item_type = isCosmetic ? 'cosmetic' : 'normal';
    if (isCosmetic) {
      if (!['name_color', 'avatar_frame'].includes(cosmetic_type)) return res.status(400).json({ error: 'Type de personnalisation invalide' });
      if (!cosmetic_value) return res.status(400).json({ error: 'Valeur de personnalisation requise' });
      updates.cosmetic_type = cosmetic_type;
      updates.cosmetic_value = cosmetic_value;
    } else {
      updates.cosmetic_type = null;
      updates.cosmetic_value = null;
    }
  }
  const { data, error } = await supabase.from('shop_items').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'boutique-offre-modifiée', 'Offre boutique "' + (data?.title || '?') + '" modifiée', req);
  res.json(data);
});
app.delete('/api/admin/shop/items/:id', auth, adminOnly, async (req, res) => {
  const { data: item } = await supabase.from('shop_items').select('title').eq('id', req.params.id).single();
  await supabase.from('shop_items').delete().eq('id', req.params.id);
  log(req.user.id, 'boutique-offre-supprimée', 'Offre boutique "' + (item?.title || '?') + '" supprimée', req);
  res.json({ success: true });
});

// Achat d'une offre de la boutique par un affilié : débite ses jetons et l'offre est
// acquise immédiatement, aucune validation admin nécessaire. On garde quand même une
// trace dans "shop_orders" (statut "fulfilled" direct) pour l'historique et les stats.
// Pour une offre cosmétique, elle est aussi ajoutée à la collection de personnalisations
// possédées par l'affilié (owned_cosmetics), qu'il pourra ensuite équiper depuis ses Paramètres.
app.post('/api/shop/purchase/:id', auth, async (req, res) => {
  const { data: item } = await supabase.from('shop_items').select('*').eq('id', req.params.id).single();
  if (!item || item.active === false) return res.status(404).json({ error: 'Offre introuvable ou indisponible' });
  const { data: user } = await supabase.from('users').select('name,tokens,discord_id,owned_cosmetics').eq('id', req.user.id).single();
  const balance = user?.tokens || 0;
  if (balance < item.price_tokens) return res.status(400).json({ error: 'Jetons insuffisants' });
  let owned = [];
  try { owned = JSON.parse(user?.owned_cosmetics || '[]'); if (!Array.isArray(owned)) owned = []; } catch (e) { owned = []; }
  if (item.item_type === 'cosmetic') {
    if (owned.some(c => c.item_id === item.id)) return res.status(409).json({ error: 'Tu possèdes déjà cette personnalisation' });
  }
  const userUpdates = { tokens: balance - item.price_tokens };
  if (item.item_type === 'cosmetic') {
    owned.push({ item_id: item.id, cosmetic_type: item.cosmetic_type, cosmetic_value: item.cosmetic_value, title: item.title });
    userUpdates.owned_cosmetics = JSON.stringify(owned);
  }
  await supabase.from('users').update(userUpdates).eq('id', req.user.id);
  const isCosmetic = item.item_type === 'cosmetic';
  const { data: order, error } = await supabase.from('shop_orders').insert({ user_id: req.user.id, item_id: item.id, item_title: item.title, item_type: item.item_type || 'normal', cosmetic_type: isCosmetic ? item.cosmetic_type : null, cosmetic_value: isCosmetic ? item.cosmetic_value : null, price_tokens: item.price_tokens, status: isCosmetic ? 'fulfilled' : 'pending' }).select().single();
  if (error) { await supabase.from('users').update({ tokens: balance, owned_cosmetics: user?.owned_cosmetics || '[]' }).eq('id', req.user.id); return res.status(500).json({ error: error.message }); }
  log(req.user.id, 'boutique-achat', user.name + ' a échangé ' + item.price_tokens + ' jetons contre "' + item.title + '"' + (isCosmetic ? ' (obtenu immédiatement)' : ' (en attente de livraison)'), req);
  await sendDiscordChannelMsg(DISCORD_SHOP_CHANNEL, isCosmetic ? '🎨 Nouvel échange (personnalisation) !' : '🛍️ Nouvel échange boutique — à livrer !', isCosmetic ? 0xa855f7 : 0xF5C842, [
    { name: '👤 Affilié', value: user.name, inline: true },
    { name: '🎁 Offre', value: item.title, inline: true },
    { name: '🪙 Jetons', value: String(item.price_tokens), inline: true }
  ], isCosmetic ? undefined : '<@' + ADMIN_DISCORD_ID + '>');
  res.json(order);
});
// Équiper/retirer une personnalisation possédée (couleur de pseudo / cadre de photo)
app.patch('/api/me/cosmetics', auth, async (req, res) => {
  const { name_color, avatar_frame } = req.body;
  const { data: user } = await supabase.from('users').select('owned_cosmetics').eq('id', req.user.id).single();
  let owned = [];
  try { owned = JSON.parse(user?.owned_cosmetics || '[]'); if (!Array.isArray(owned)) owned = []; } catch (e) { owned = []; }
  const updates = {};
  if (name_color !== undefined) {
    if (name_color === null) updates.name_color = null;
    else { if (!owned.some(c => c.cosmetic_type === 'name_color' && c.cosmetic_value === name_color)) return res.status(403).json({ error: 'Tu ne possèdes pas cette couleur' }); updates.name_color = name_color; }
  }
  if (avatar_frame !== undefined) {
    if (avatar_frame === null) updates.avatar_frame = null;
    else { if (!owned.some(c => c.cosmetic_type === 'avatar_frame' && c.cosmetic_value === avatar_frame)) return res.status(403).json({ error: 'Tu ne possèdes pas ce cadre' }); updates.avatar_frame = avatar_frame; }
  }
  await supabase.from('users').update(updates).eq('id', req.user.id);
  res.json({ success: true, ...updates });
});
// Historique des commandes : l'affilié voit les siennes, l'admin voit tout
app.get('/api/shop/orders', auth, async (req, res) => {
  let query = supabase.from('shop_orders').select('*, users(name,email)').order('created_at', { ascending: false });
  if (req.user.role !== 'admin') query = query.eq('user_id', req.user.id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
// Valide/livre une commande d'offre "normale" en attente (l'admin lui a remis la récompense manuellement)
app.patch('/api/admin/shop/orders/:id/deliver', auth, adminOnly, async (req, res) => {
  const { data: order } = await supabase.from('shop_orders').select('*, users(name,discord_id)').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'Cette commande n\'est pas en attente (statut actuel : ' + order.status + ')' });
  await supabase.from('shop_orders').update({ status: 'fulfilled' }).eq('id', req.params.id);
  log(req.user.id, 'boutique-commande-livrée', 'Commande #' + order.id + ' (' + order.item_title + ') marquée comme livrée pour ' + (order.users?.name || '?'), req);
  await supabase.from('notifications').insert({ user_id: order.user_id, type: 'shop_order_fulfilled', message: '🛍️ Ta commande "' + order.item_title + '" a été livrée !', read: false });
  if (order.users?.discord_id) {
    await sendDiscordDM(order.users.discord_id, '🛍️ Commande livrée !', 0x00D68F, [
      { name: '🎁 Offre', value: order.item_title, inline: true },
      { name: '🪙 Jetons', value: String(order.price_tokens), inline: true }
    ]);
  }
  res.json({ success: true });
});
// Annule un échange (cosmétique ou normal, quel que soit son statut actuel sauf déjà annulé) :
// rembourse les jetons, et pour une personnalisation, la retire de la collection de l'affilié
// (et la déséquipe automatiquement si elle était en cours d'utilisation).
app.patch('/api/admin/shop/orders/:id/cancel', auth, adminOnly, async (req, res) => {
  const { data: order } = await supabase.from('shop_orders').select('*, users(name,tokens,discord_id,owned_cosmetics,name_color,avatar_frame)').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });
  if (order.status === 'cancelled') return res.status(409).json({ error: 'Cette commande est déjà annulée' });
  const u = order.users;
  const userUpdates = { tokens: (u?.tokens || 0) + order.price_tokens };
  if (order.item_type === 'cosmetic') {
    let owned = [];
    try { owned = JSON.parse(u?.owned_cosmetics || '[]'); if (!Array.isArray(owned)) owned = []; } catch (e) { owned = []; }
    owned = owned.filter(c => c.item_id !== order.item_id);
    userUpdates.owned_cosmetics = JSON.stringify(owned);
    if (order.cosmetic_type === 'name_color' && u?.name_color === order.cosmetic_value) userUpdates.name_color = null;
    if (order.cosmetic_type === 'avatar_frame' && u?.avatar_frame === order.cosmetic_value) userUpdates.avatar_frame = null;
  }
  await supabase.from('users').update(userUpdates).eq('id', order.user_id);
  await supabase.from('shop_orders').update({ status: 'cancelled' }).eq('id', req.params.id);
  log(req.user.id, 'boutique-commande-annulée', 'Commande #' + order.id + ' (' + order.item_title + ') annulée pour ' + (u?.name || '?') + ' — ' + order.price_tokens + ' 🪙 remboursés', req);
  await supabase.from('notifications').insert({ user_id: order.user_id, type: 'shop_order_cancelled', message: '↩️ Ton échange "' + order.item_title + '" a été annulé, tes ' + order.price_tokens + ' jetons ont été remboursés.', read: false });
  if (u?.discord_id) {
    await sendDiscordDM(u.discord_id, '↩️ Échange annulé', 0xFF4757, [
      { name: '🎁 Offre', value: order.item_title, inline: true },
      { name: '🪙 Jetons remboursés', value: String(order.price_tokens), inline: true }
    ]);
  }
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
  log(req.user.id, 'ticket-répondu', (req.user.role === 'admin' ? 'Réponse admin' : 'Réponse affilié') + ' sur le ticket #' + req.params.id, req);
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
    log(req.user.id, 'demande-lien-perso-mise-à-jour', req.user.name + ' a mis à jour sa demande pour "' + (offer?.name || '?') + '"', req);
    await sendDiscordChannelMsg('1541198868019159051', '🎨 Demande de lien perso (mise à jour)', 0xa855f7, [
      { name: '👤 Affilié', value: req.user.name, inline: true },
      { name: '🎯 Offre', value: offer?.name || '?', inline: true },
      { name: '🖥️ Serveur', value: server_name || '—', inline: true }
    ], '<@1504481208266915861>');
    return res.json(data);
  }
  const { data, error } = await supabase.from('custom_link_requests').insert({ user_id: req.user.id, offer_id, server_name, slogan, tag1, tag2, tag3, logo_url, salons, photo1_url, photo2_url, photo3_url, photo4_url, photo5_url, photo6_url, photos_blurred, photo_text }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  log(req.user.id, 'demande-lien-perso-créée', req.user.name + ' a créé une demande de lien perso pour "' + (offer?.name || '?') + '"', req);
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
    welcome_message: obj.welcome_message || '',
    tokens_per_sale: obj.tokens_per_sale !== undefined ? (parseInt(obj.tokens_per_sale) || 0) : 5,
    gift_tokens: obj.gift_tokens !== undefined ? (parseInt(obj.gift_tokens) || 0) : 5,
    referral_milestone_count: obj.referral_milestone_count !== undefined ? (parseInt(obj.referral_milestone_count) || 5) : 5,
    referral_milestone_tokens: obj.referral_milestone_tokens !== undefined ? (parseInt(obj.referral_milestone_tokens) || 0) : 10
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
  log(req.user.id, 'annonce-lue', 'Annonce #' + req.params.id + ' marquée comme lue', req);
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
  log(req.user.id, 'notifications-lues', 'Toutes les notifications marquées comme lues', req);
  res.json({ success: true });
});
app.delete('/api/notifications/:id', auth, async (req, res) => {
  await supabase.from('notifications').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  log(req.user.id, 'notification-supprimée', 'Notification #' + req.params.id + ' supprimée', req);
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
  // Anti CSV-injection : si une cellule commence par = + - @ (déclencheur de formule dans
  // Excel/Google Sheets), on préfixe d'une apostrophe pour forcer l'affichage en texte brut.
  const sanitize = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return s;
  };
  const escape = v => '"' + sanitize(v).replace(/"/g, '""') + '"';
  const DELIM = ';'; // Excel en français attend un point-virgule comme séparateur par défaut
  const lines = [headers.map(escape).join(DELIM)];
  rows.forEach(row => lines.push(headers.map(h => escape(row[h])).join(DELIM)));
  // Le BOM UTF-8 (\uFEFF) en tête est indispensable pour qu'Excel affiche correctement
  // les accents (é, à, ç...) au lieu de les afficher en caractères bizarres (Ã©, etc.)
  return '\uFEFF' + lines.join('\r\n');
}
app.get('/api/export/affiliates', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('users').select('name,email,balance,referral_code,created_at,admin_note').neq('role', 'admin');
  const csv = toCSV(data, ['name','email','balance','referral_code','created_at','admin_note']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="affilies.csv"');
  res.send(csv);
});
app.get('/api/export/conversions', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('conversions').select('*, users(name,email), offers(name)').order('created_at', { ascending: false });
  const rows = (data || []).map(c => ({ date: c.created_at?.split('T')[0], affilié: c.users?.name, email: c.users?.email, offre: c.offers?.name, montant: c.amount, statut: c.status, lien: c.link_id }));
  const csv = toCSV(rows, ['date','affilié','email','offre','montant','statut','lien']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="conversions.csv"');
  res.send(csv);
});
app.get('/api/export/withdrawals', auth, adminOnly, async (req, res) => {
  const { data } = await supabase.from('withdrawals').select('*, users(name,email)').order('created_at', { ascending: false });
  const rows = (data || []).map(w => ({ date: w.created_at?.split('T')[0], affilié: w.users?.name, email: w.users?.email, montant: w.amount, moyen: w.crypto, adresse: w.address, statut: w.status, raison: w.reason }));
  const csv = toCSV(rows, ['date','affilié','email','montant','moyen','adresse','statut','raison']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="retraits.csv"');
  res.send(csv);
});

// Liste minimale des autres affiliés (id + nom uniquement), utilisée pour choisir
// un destinataire de cadeau. Pas de données sensibles (email, solde, etc.) exposées.
app.get('/api/affiliates-list', auth, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name').eq('role', 'affiliate').neq('id', req.user.id).order('name');
  res.json(data || []);
});

// ── CADEAUX ENTRE AFFILIÉS ──
// Anti-doublon (même principe que pour les conversions manuelles) : évite qu'un double-clic
// ou un double envoi réseau envoie deux fois le même cadeau.
app.post('/api/gifts', auth, async (req, res) => {
  const { receiver_id, amount, message } = req.body;
  const amt = parseFloat(amount);
  if (!receiver_id) return res.status(400).json({ error: 'Choisis un destinataire' });
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Montant invalide' });
  if (receiver_id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas t\'envoyer un cadeau à toi-même' });
  if (message && message.length > 200) return res.status(400).json({ error: 'Message trop long (200 caractères max)' });

  const { data: sender } = await supabase.from('users').select('name,balance').eq('id', req.user.id).single();
  if (!sender) return res.status(404).json({ error: 'Compte introuvable' });
  if (sender.balance < amt) return res.status(400).json({ error: 'Solde insuffisant' });

  const { data: receiver } = await supabase.from('users').select('name,balance,discord_id,role').eq('id', receiver_id).single();
  if (!receiver || receiver.role !== 'affiliate') return res.status(404).json({ error: 'Destinataire introuvable' });

  const tenSecondsAgo = new Date(Date.now() - 10 * 1000).toISOString();
  const { data: recentDuplicate } = await supabase.from('gifts').select('id').eq('sender_id', req.user.id).eq('receiver_id', receiver_id).eq('amount', amt).gte('created_at', tenSecondsAgo).limit(1).maybeSingle();
  if (recentDuplicate) return res.status(409).json({ error: 'Cadeau identique déjà envoyé il y a quelques secondes (doublon évité)' });

  await supabase.from('users').update({ balance: sender.balance - amt }).eq('id', req.user.id);
  await supabase.from('users').update({ balance: receiver.balance + amt }).eq('id', receiver_id);
  const { data: gift } = await supabase.from('gifts').insert({ sender_id: req.user.id, receiver_id, amount: amt, message: message || null }).select().single();

  log(req.user.id, 'cadeau-envoyé', sender.name + ' a envoyé $' + amt + ' à ' + receiver.name, req);
  // Jetons pour l'envoi d'un cadeau
  const giftTokensAmount = await getGiftTokens();
  if (giftTokensAmount > 0) {
    const { data: senderFresh } = await supabase.from('users').select('tokens').eq('id', req.user.id).single();
    await supabase.from('users').update({ tokens: (senderFresh?.tokens || 0) + giftTokensAmount }).eq('id', req.user.id);
  }
  await supabase.from('notifications').insert({ user_id: receiver_id, type: 'gift_received', message: '🎁 ' + sender.name + ' t\'a envoyé $' + amt + (message ? ' : "' + message + '"' : '') + ' !', read: false });
  if (receiver.discord_id) {
    await sendDiscordDM(receiver.discord_id, '🎁 Tu as reçu un cadeau !', 0xF0427A, [
      { name: '👤 De la part de', value: sender.name, inline: true },
      { name: '💰 Montant', value: '$' + amt, inline: true },
      ...(message ? [{ name: '💬 Message', value: message, inline: false }] : [])
    ]);
  }
  res.json(gift);
});

// Historique des cadeaux (envoyés + reçus) de l'utilisateur connecté
app.get('/api/gifts', auth, async (req, res) => {
  const { data: sent } = await supabase.from('gifts').select('*, receiver:receiver_id(name)').eq('sender_id', req.user.id).order('created_at', { ascending: false });
  const { data: received } = await supabase.from('gifts').select('*, sender:sender_id(name)').eq('receiver_id', req.user.id).order('created_at', { ascending: false });
  res.json({ sent: sent || [], received: received || [] });
});


app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route introuvable' });
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AffiHub running on port ${PORT}`));
