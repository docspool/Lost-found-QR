#!/bin/sh
set -e

# /app/data est un volume monté depuis l'hôte : ses permissions ne dépendent pas
# de l'image Docker. On les corrige à chaque démarrage (encore en root ici), puis
# on abandonne les privilèges vers l'utilisateur non-root "node" pour lancer l'appli.
mkdir -p /app/data
chown -R node:node /app/data

exec su-exec node "$@"
