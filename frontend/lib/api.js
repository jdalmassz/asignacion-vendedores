/**
 * Dónde está la API.
 *
 * Estaba escrita a mano como `http://localhost:4000/api`, que funciona en el portátil
 * de quien la escribió y en ningún otro sitio: puesto en el servidor, el navegador del
 * usuario intentaría hablar con SU propio ordenador.
 *
 * Por defecto `/api`, que es una ruta relativa: el mismo nginx que sirve la página la
 * reenvía al backend por la red interna. `NEXT_PUBLIC_API_URL` permite apuntar a otro
 * sitio en desarrollo — Next la sustituye al construir, no al arrancar.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api'
