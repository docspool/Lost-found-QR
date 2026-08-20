# QR Lost & Found

Petite application "scan if found" : chaque objet a un QR code qui pointe vers une page
publique où le finder peut laisser ses coordonnées pour organiser une remise en main propre.
Chaque scan et chaque réponse déclenchent une notification via [ntfy](https://ntfy.sh),
et une page admin permet de gérer les objets et de consulter l'historique.

## Déploiement sur le serveur maison (Docker + Nginx Proxy Manager)

Le conteneur ne publie aucun port sur l'hôte : il rejoint directement le réseau Docker
externe utilisé par **Nginx Proxy Manager** (`nginx_default` dans notre cas — adapte le
nom si le tien diffère, trouvable avec `docker network ls`).

```bash
cd qr-lost-found
cp .env.example .env
nano .env   # ADMIN_PASSWORD, SESSION_SECRET, NTFY_TOPIC (BASE_URL et DOMAIN sont déjà bons)

docker compose up -d --build
```

Vérifie que le conteneur a bien rejoint le réseau :

```bash
docker inspect qr-lost-found --format='{{json .NetworkSettings.Networks}}'
```

### Config côté Nginx Proxy Manager

Crée un Proxy Host dans l'UI de NPM :

- **Domain Names** : `<ton-domaine>`
- **Forward Hostname/IP** : `qr-lost-found` (le nom du conteneur, résolu via le réseau Docker partagé)
- **Forward Port** : `3000`
- **Scheme** : `http`
- Onglet **SSL** : "Request a new SSL Certificate" (Let's Encrypt) + Force SSL

Assure-toi que le sous-domaine `<ton-domaine>` pointe bien vers ton IP publique (DNS +
redirection des ports 80/443 sur ta box vers le serveur qui fait tourner NPM).

## Notifications (ntfy)

- Le plus simple : utiliser **ntfy.sh** gratuitement. Choisis un nom de topic difficile à
  deviner, mets-le dans `NTFY_TOPIC`, puis abonne-toi à ce topic
  depuis l'app ntfy (Android/iOS) ou via le site web.
- Si tu préfères, tu peux self-héberger ntfy sur ton VPS (même pattern Traefik que les
  autres services) et pointer `NTFY_URL` dessus.

## Créer un objet et son QR code

1. Va sur `https://<ton-domaine>/admin`, connecte-toi.
2. "+ Nouvel objet" → renseigne un titre, un message affiché au finder, et éventuellement
   tes coordonnées.
3. La page publique de l'objet est disponible à `https://<ton-domaine>/o/<slug>`, avec un
   slug généré automatiquement (identifiant aléatoire, non personnalisable) pour éviter
   qu'un lien lisible ne révèle des informations sur l'objet ou son propriétaire.
4. Génère un QR code pointant vers cette URL (n'importe quel générateur QR, ex. la
   commande `qrencode` ou un service en ligne) et colle-le sur le sac.

## Historique

Depuis le tableau de bord admin, clique sur le nombre de scans ou de réponses d'un objet
pour voir le détail : date, position GPS (lien Google Maps), et contenu du formulaire
rempli par le finder.

## Notes de sécurité

- `ADMIN_PASSWORD`, `SESSION_SECRET`, `BASE_URL` et `NTFY_TOPIC` sont **obligatoires** :
  l'application refuse de démarrer si l'une d'entre elles est absente (pas de valeur par
  défaut connue publiquement). `SESSION_SECRET` doit faire au moins 32 caractères
  (`openssl rand -hex 32`).
- Le cookie de session admin est scopé au path `/admin`, `Secure`, `HttpOnly` et
  `SameSite=Strict` — l'appli suppose qu'elle tourne derrière un reverse proxy HTTPS
  (`trust proxy` est activé). En dev local sans HTTPS, la connexion admin ne fonctionnera
  pas tant que le cookie `secure` ne peut pas être posé.
- `/admin/login` et les endpoints publics `/o/:slug/scan` et `/o/:slug/submit` sont
  limités en fréquence (rate limiting) par IP.
- Les actions admin qui modifient des données (créer/éditer/supprimer un objet, effacer
  l'historique, se déconnecter) sont protégées par un jeton anti-CSRF.
- Un bouton "Effacer l'historique" par objet permet de purger les scans et soumissions
  (dont les positions GPS). La variable optionnelle `RETENTION_DAYS` (voir `.env.example`)
  active une purge automatique périodique.
- Les données (SQLite) sont dans `./data`, incluses automatiquement dans le backup global
  `~/docker` si tu utilises le script de backup existant.
- Le conteneur tourne en utilisateur non-root (`node`). Comme `./data` est un volume monté
  depuis l'hôte, `docker-entrypoint.sh` corrige ses permissions (`chown`) à chaque démarrage
  du conteneur avant de lancer l'appli — inutile de le faire manuellement sur l'hôte.

Après avoir modifié `package.json`, pense à lancer `npm install` pour installer les
nouvelles dépendances (`helmet`, `express-rate-limit`) et régénérer `package-lock.json`.
