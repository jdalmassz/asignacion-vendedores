/**
 * Next.js sirve la página como HTML estático, igual que hacía Vite.
 *
 * `output: 'export'` genera la carpeta `out/`, que es la que nginx copia tal cual en
 * la imagen. No hay servidor Node detrás: la página se construye y se reparte, y
 * `/api` sigue yendo al backend por el mismo nginx de siempre (`nginx.conf.template`),
 * con `BACKEND_HOST` y `BACKEND_PORT` que se sustituyen al arrancar.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },

  /**
   * En desarrollo, `/api` va al backend local —lo mismo que hacía el proxy de Vite—.
   *
   * Así el código es el MISMO en el portátil y en el servidor: siempre llama a `/api`
   * y quien lo reenvía cambia —aquí `next dev`, allí nginx—. En producción la respuesta
   * es una lista vacía: el HTML sale estático y el reenvío lo hace nginx, que es lo que
   * `nginx.conf.template` ya hacía.
   */
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return []
    return [{ source: '/api/:path*', destination: `${process.env.API_LOCAL || 'http://localhost:4000'}/api/:path*` }]
  },
}

export default nextConfig
