# El frontend: se construye con Next.js —que genera HTML estático— y lo sirve nginx.
FROM node:22-alpine AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm ci
COPY . .
# La dirección de la API se incrusta al construir: Next sustituye `process.env.NEXT_PUBLIC_*`
# en el empaquetado, así que no vale ponerla al arrancar. Por defecto `/api`, relativa, que
# es la que reenvía nginx.
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM nginx:alpine
# `output: 'export'` en next.config.mjs: la salida es `out/`, no hay servidor Node detrás.
COPY --from=build /app/out /usr/share/nginx/html

# Como plantilla, no como configuración: la imagen de nginx sustituye las variables de
# /etc/nginx/templates al arrancar y deja el resultado en conf.d.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# A dónde va /api. Se puede cambiar sin reconstruir, que es de lo que se trata.
ENV BACKEND_HOST=asignacion-backend
ENV BACKEND_PORT=4000

EXPOSE 80
