# El backend: Express + Mongo + MySQL (de lectura).
FROM node:22-alpine

WORKDIR /app

# Primero las dependencias y luego el código: así un cambio en `server.js` no obliga a
# reinstalar node_modules en cada construcción.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# El puerto lo decide el entorno; 4000 es sólo el valor por defecto del código.
EXPOSE 4000

CMD ["node", "server.js"]
