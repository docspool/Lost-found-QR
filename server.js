require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Configuration obligatoire ----------
// Pas de valeurs par défaut pour les secrets : si .env n'est pas chargé,
// l'appli doit s'arrêter plutôt que de démarrer avec des identifiants publics (fail-closed).
const REQUIRED_ENV = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'BASE_URL', 'NTFY_TOPIC'];
for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    throw new Error(`Variable d'environnement obligatoire manquante : ${name}`);
  }
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET doit contenir au moins 32 caractères');
}

const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const BASE_URL = process.env.BASE_URL;
const RETENTION_DAYS = process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : null;

// Le conteneur est derrière Nginx Proxy Manager (HTTPS en amont, HTTP en interne) :
// on fait confiance au premier hop de proxy pour req.secure / req.ip.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'"]
      }
    }
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(__dirname + '/public'));
app.use(
  cookieSession({
    name: 'qrlf_session',
    secret: SESSION_SECRET,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/admin',
    httpOnly: true,
    secure: true,
    sameSite: 'strict'
  })
);

// ---------- Helpers ----------

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/admin/login');
}

// Jeton anti-CSRF (synchronizer token) stocké dans la session admin signée.
function ensureCsrfToken(req) {
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrf;
}

function verifyCsrf(req, res, next) {
  const token = req.body._csrf;
  if (!token || !req.session || token !== req.session.csrf) {
    return res.status(403).send('Requête refusée (jeton CSRF invalide ou manquant).');
  }
  next();
}

function truncate(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function validCoordinates(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) && la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

function validAccuracy(acc) {
  if (acc === undefined || acc === null || acc === '') return true;
  const a = Number(acc);
  return Number.isFinite(a) && a >= 0 && a <= 100000;
}

// Nettoie latitude/longitude/accuracy : renvoie des valeurs sûres pour SQLite,
// ou null si les données envoyées ne sont pas des coordonnées plausibles.
function sanitizeGeo(latitude, longitude, accuracy) {
  if (latitude == null || longitude == null || !validCoordinates(latitude, longitude)) {
    return { latitude: null, longitude: null, accuracy: null };
  }
  return {
    latitude: Number(latitude),
    longitude: Number(longitude),
    accuracy: validAccuracy(accuracy) && accuracy != null ? Number(accuracy) : null
  };
}

async function sendNtfy({ title, message, mapsUrl, priority = 'default', tags = [] }) {
  try {
    const payload = {
      topic: NTFY_TOPIC,
      title,
      message,
      priority: { min: 1, low: 2, default: 3, high: 4, max: 5 }[priority] || 3,
      tags
    };
    if (mapsUrl) {
      payload.actions = [{ action: 'view', label: 'Voir sur la carte', url: mapsUrl }];
    }
    // L'endpoint racine avec un corps JSON supporte correctement l'UTF-8 (emojis, accents),
    // contrairement au passage du titre/tags via des headers HTTP.
    await fetch(`${NTFY_URL.replace(/\/$/, '')}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Erreur envoi ntfy:', err.message);
  }
}

function mapsLink(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// Purge optionnelle des données de localisation au-delà de RETENTION_DAYS.
// Désactivée par défaut (aucune valeur définie) pour ne pas changer le comportement existant.
function purgeOldLocationData() {
  if (!RETENTION_DAYS || !Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) return;
  const cutoff = `-${RETENTION_DAYS} days`;
  db.prepare(`DELETE FROM scans WHERE created_at < datetime('now', ?)`).run(cutoff);
  db.prepare(`DELETE FROM submissions WHERE created_at < datetime('now', ?)`).run(cutoff);
}

if (RETENTION_DAYS) {
  purgeOldLocationData();
  setInterval(purgeOldLocationData, 24 * 60 * 60 * 1000);
}

// ---------- Rate limiting ----------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});

// ---------- Pages publiques (objet) ----------

// Page d'accueil neutre (pas de lien admin), pour éviter le "Cannot GET /"
app.get('/', (req, res) => {
  res.render('home');
});

// Page affichée quand quelqu'un scanne le QR code
app.get('/o/:slug', (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!obj) return res.status(404).render('not-found');
  res.render('object-public', { obj, submitted: false });
});

// Log silencieux du scan (appelé en JS au chargement, avec géoloc si dispo)
app.post('/o/:slug/scan', scanLimiter, (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!obj) return res.status(404).json({ ok: false });

  const { latitude, longitude, accuracy } = sanitizeGeo(
    req.body?.latitude,
    req.body?.longitude,
    req.body?.accuracy
  );
  db.prepare(
    `INSERT INTO scans (object_id, latitude, longitude, accuracy, user_agent) VALUES (?, ?, ?, ?, ?)`
  ).run(obj.id, latitude, longitude, accuracy, truncate(req.headers['user-agent'] || '', 300));

  const maps = mapsLink(latitude, longitude);
  sendNtfy({
    title: `📷 QR scanné : ${obj.title}`,
    message: maps
      ? `Ton objet "${obj.title}" vient d'être scanné. Position approximative disponible.`
      : `Ton objet "${obj.title}" vient d'être scanné (position non partagée pour l'instant).`,
    mapsUrl: maps,
    tags: ['eyes']
  });

  res.json({ ok: true });
});

// Soumission du formulaire par la personne qui a trouvé l'objet
app.post('/o/:slug/submit', submitLimiter, (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!obj) return res.status(404).render('not-found');

  const finder_name = truncate(req.body.finder_name, 100);
  const finder_contact = truncate(req.body.finder_contact, 200);
  const finder_message = truncate(req.body.finder_message, 2000);
  const { latitude, longitude, accuracy } = sanitizeGeo(
    req.body.latitude,
    req.body.longitude,
    req.body.accuracy
  );

  db.prepare(
    `INSERT INTO submissions (object_id, finder_name, finder_contact, finder_message, latitude, longitude, accuracy, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    obj.id,
    finder_name,
    finder_contact,
    finder_message,
    latitude,
    longitude,
    accuracy,
    truncate(req.headers['user-agent'] || '', 300)
  );

  const maps = mapsLink(latitude, longitude);
  const lines = [
    `Objet : ${obj.title}`,
    finder_name ? `Nom : ${finder_name}` : null,
    finder_contact ? `Contact : ${finder_contact}` : null,
    finder_message ? `Message : ${finder_message}` : null
  ].filter(Boolean);

  sendNtfy({
    title: `✅ Quelqu'un a rempli le formulaire : ${obj.title}`,
    message: lines.join('\n'),
    mapsUrl: maps,
    priority: 'high',
    tags: ['tada']
  });

  res.render('object-public', { obj, submitted: true });
});

// ---------- Admin ----------

app.get('/admin/login', (req, res) => {
  res.render('admin-login', { error: null });
});

app.post('/admin/login', loginLimiter, (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.authed = true;
    ensureCsrfToken(req);
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'Mot de passe incorrect' });
});

app.post('/admin/logout', requireAuth, verifyCsrf, (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

// Tableau de bord : liste des objets
app.get('/admin', requireAuth, (req, res) => {
  const objects = db
    .prepare(
      `SELECT o.*,
        (SELECT COUNT(*) FROM scans s WHERE s.object_id = o.id) AS scan_count,
        (SELECT COUNT(*) FROM submissions su WHERE su.object_id = o.id) AS submission_count
       FROM objects o ORDER BY o.created_at DESC`
    )
    .all();
  res.render('admin-dashboard', { objects, baseUrl: BASE_URL, csrfToken: ensureCsrfToken(req) });
});

// Formulaire nouvel objet
app.get('/admin/objects/new', requireAuth, (req, res) => {
  res.render('admin-object-form', { obj: null, csrfToken: ensureCsrfToken(req) });
});

app.post('/admin/objects/new', requireAuth, verifyCsrf, (req, res) => {
  const title = truncate(req.body.title, 100);
  const message = truncate(req.body.message, 2000);
  const contact_info = truncate(req.body.contact_info, 500);
  if (!title) return res.redirect('/admin/objects/new');

  // Le slug est toujours généré côté serveur : un slug choisi à la main (ex. "sac-noir-arnaud")
  // finit sur une étiquette et révèle des infos sur l'URL publique elle-même.
  const slug = nanoid(12);

  db.prepare(
    `INSERT INTO objects (slug, title, message, contact_info) VALUES (?, ?, ?, ?)`
  ).run(slug, title, message, contact_info);

  res.redirect('/admin');
});

// Édition d'un objet existant
app.get('/admin/objects/:id/edit', requireAuth, (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE id = ?').get(req.params.id);
  if (!obj) return res.redirect('/admin');
  res.render('admin-object-form', { obj, csrfToken: ensureCsrfToken(req) });
});

app.post('/admin/objects/:id/edit', requireAuth, verifyCsrf, (req, res) => {
  const title = truncate(req.body.title, 100);
  const message = truncate(req.body.message, 2000);
  const contact_info = truncate(req.body.contact_info, 500);
  const active = req.body.active;
  if (!title) return res.redirect(`/admin/objects/${req.params.id}/edit`);

  db.prepare(
    `UPDATE objects SET title = ?, message = ?, contact_info = ?, active = ? WHERE id = ?`
  ).run(title, message, contact_info, active ? 1 : 0, req.params.id);
  res.redirect('/admin');
});

app.post('/admin/objects/:id/delete', requireAuth, verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM objects WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

// Historique (scans + soumissions) d'un objet
app.get('/admin/objects/:id/history', requireAuth, (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE id = ?').get(req.params.id);
  if (!obj) return res.redirect('/admin');
  const scans = db
    .prepare('SELECT * FROM scans WHERE object_id = ? ORDER BY created_at DESC')
    .all(req.params.id);
  const submissions = db
    .prepare('SELECT * FROM submissions WHERE object_id = ? ORDER BY created_at DESC')
    .all(req.params.id);
  res.render('admin-object-history', { obj, scans, submissions, baseUrl: BASE_URL, csrfToken: ensureCsrfToken(req) });
});

// Efface l'historique GPS (scans + réponses) d'un objet, sans supprimer l'objet lui-même.
app.post('/admin/objects/:id/clear-history', requireAuth, verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM scans WHERE object_id = ?').run(req.params.id);
  db.prepare('DELETE FROM submissions WHERE object_id = ?').run(req.params.id);
  res.redirect(`/admin/objects/${req.params.id}/history`);
});

app.listen(PORT, () => {
  console.log(`QR Lost & Found démarré sur le port ${PORT}`);
});
