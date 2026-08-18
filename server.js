require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-too';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'qr-lost-found';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(__dirname + '/public'));
app.use(
  cookieSession({
    name: 'qrlf_session',
    secret: SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000
  })
);

// ---------- Helpers ----------

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/admin/login');
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
app.post('/o/:slug/scan', (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!obj) return res.status(404).json({ ok: false });

  const { latitude, longitude, accuracy } = req.body || {};
  db.prepare(
    `INSERT INTO scans (object_id, latitude, longitude, accuracy, user_agent) VALUES (?, ?, ?, ?, ?)`
  ).run(obj.id, latitude ?? null, longitude ?? null, accuracy ?? null, req.headers['user-agent'] || '');

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
app.post('/o/:slug/submit', (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!obj) return res.status(404).render('not-found');

  const { finder_name, finder_contact, finder_message, latitude, longitude, accuracy } = req.body;

  db.prepare(
    `INSERT INTO submissions (object_id, finder_name, finder_contact, finder_message, latitude, longitude, accuracy, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    obj.id,
    finder_name || '',
    finder_contact || '',
    finder_message || '',
    latitude || null,
    longitude || null,
    accuracy || null,
    req.headers['user-agent'] || ''
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

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.authed = true;
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'Mot de passe incorrect' });
});

app.post('/admin/logout', (req, res) => {
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
  res.render('admin-dashboard', { objects, baseUrl: BASE_URL });
});

// Formulaire nouvel objet
app.get('/admin/objects/new', requireAuth, (req, res) => {
  res.render('admin-object-form', { obj: null });
});

app.post('/admin/objects/new', requireAuth, (req, res) => {
  const { title, message, contact_info } = req.body;
  let slug = (req.body.slug || '').trim();
  if (!slug) slug = nanoid(8);
  slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  db.prepare(
    `INSERT INTO objects (slug, title, message, contact_info) VALUES (?, ?, ?, ?)`
  ).run(slug, title, message || '', contact_info || '');

  res.redirect('/admin');
});

// Édition d'un objet existant
app.get('/admin/objects/:id/edit', requireAuth, (req, res) => {
  const obj = db.prepare('SELECT * FROM objects WHERE id = ?').get(req.params.id);
  if (!obj) return res.redirect('/admin');
  res.render('admin-object-form', { obj });
});

app.post('/admin/objects/:id/edit', requireAuth, (req, res) => {
  const { title, message, contact_info, active } = req.body;
  db.prepare(
    `UPDATE objects SET title = ?, message = ?, contact_info = ?, active = ? WHERE id = ?`
  ).run(title, message || '', contact_info || '', active ? 1 : 0, req.params.id);
  res.redirect('/admin');
});

app.post('/admin/objects/:id/delete', requireAuth, (req, res) => {
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
  res.render('admin-object-history', { obj, scans, submissions, baseUrl: BASE_URL });
});

app.listen(PORT, () => {
  console.log(`QR Lost & Found démarré sur le port ${PORT}`);
});
