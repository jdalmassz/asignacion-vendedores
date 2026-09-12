# El frontend: se construye con Vite y lo sirve nginx.
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# La dirección de la API se incrusta al construir: Vite sustituye `import.meta.env` en el
# empaquetado, así que no vale ponerla al arrancar. Por defecto `/api`, relativa, que es
# la que reenvía nginx.
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html

# Como plantilla, no como configuración: la imagen de nginx sustituye las variables de
# /etc/nginx/templates al arrancar y deja el resultado en conf.d.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# A dónde va /api. Se puede cambiar sin reconstruir, que es de lo que se trata.
ENV BACKEND_HOST=asignacion-backend
ENV BACKEND_PORT=4000

EXPOSE 80
