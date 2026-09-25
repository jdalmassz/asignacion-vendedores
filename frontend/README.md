# Asignación de vendedores — frontend

Next.js (React) con **salida estática**: `npm run build` genera `out/`, que es el HTML que
sirve nginx. No hay servidor Node en producción.

## Estructura

```
app/            layout.js (título, favicon, viewport) · page.js · globals.css
components/     App.js (la pantalla entera) · AppIcon.js · Transition.js
lib/            api.js (URL de la API) · datos.js (cálculos: barras, iniciales, totales)
public/         favicon.svg · icons.svg
```

`components/App.js` guarda el estado y pinta las cuatro secciones, el formulario de nueva
asignación y el detalle de pedidos. `Transition.js` reproduce las transiciones de Vue
(`ventana`, `seccion`, `cambio`) con las mismas clases del CSS.

## En desarrollo

```bash
npm install
npm run dev        # http://localhost:8093
```

`next dev` reenvía `/api` a `http://localhost:4000` (el backend), igual que hacía el proxy
de Vite; se cambia con `API_LOCAL`. En el servidor ese reenvío lo hace nginx
(`nginx.conf.template`), con `BACKEND_HOST` y `BACKEND_PORT`.

## Construir

```bash
npm run build      # escribe out/
```

La URL de la API se incrusta al construir (`NEXT_PUBLIC_API_URL`, por defecto `/api`), lo
mismo que hacía `VITE_API_URL`.
