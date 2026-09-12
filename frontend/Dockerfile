# El frontend: se construye con Vite y lo sirve nginx.
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# La dirección de la API se incrusta al construir: Vite sustituye `import.meta.env` en el
# empaquetado, así que no vale ponerla al arrancar el contenedor.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
