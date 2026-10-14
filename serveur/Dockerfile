# Serveur Terrariums — image minimale. Les données (comptes, historique, clés
# VAPID, rapports) vivent dans /donnees : à monter sur un volume.
#   docker build -t terrarium-serveur -f serveur/Dockerfile .
#   docker run -d --name terrarium -p 8080:8080 -p 1883:1883 -v terrarium-donnees:/donnees \
#     -e ADMIN_JETON=$(openssl rand -hex 24) -e CONTACT_VAPID=mailto:vous@exemple.fr terrarium-serveur
FROM node:22-alpine
WORKDIR /srv/terrarium
ENV NODE_ENV=production DONNEES=/donnees PORT=8080 PORT_MQTT=1883
COPY serveur/package.json serveur/package-lock.json ./serveur/
RUN cd serveur && npm ci --omit=dev && npm cache clean --force
COPY serveur ./serveur
# L'application peut être servie depuis le même serveur (SERVIR_APP=1).
COPY app ./app
RUN mkdir -p /donnees && chown -R node:node /donnees /srv/terrarium
USER node
EXPOSE 8080 1883
VOLUME ["/donnees"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/infos >/dev/null || exit 1
CMD ["node", "serveur/serveur.js"]
