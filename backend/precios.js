/**
 * El precio corregido a mano.
 *
 * # Por qué hace falta
 *
 * El precio vigente que enseña la app sale de la **última venta**, porque Ventra no
 * publica el precio en la ficha del producto (ver `ventra.js`). Eso sirve mientras la
 * tarifa no cambie, y falla justo en el instante en que cambia:
 *
 *
 * Aquí se guarda la corrección de un producto. Mientras exista, manda sobre el precio de
 * la última venta, y en pantalla se dice que está corregida y de qué fecha —se distingue
 * de una venta—, para que no se haga pasar por lo que no es.
 *
 * # Dónde se escribe
 *
 * En la MongoDB de ESTA app (colección `precios`, en `asignacion_vendedores`). Las
 * fuentes externas —Ventra, PEDIDO, MariaDB— no se tocan: siguen siendo de sólo lectura.
 *
 * Si algún día Ventra publica el precio de catálogo por su API, esto se retira y vuelve
 * a mandar la ficha del producto.
 */
import { db, hoyEnCuba } from './almacen.js';

const COLECCION = 'precios';

/**
 * La caché en memoria: dos pantallas seguidas no leen Mongo dos veces.
 *
 * Se vacía al escribir, así que una corrección se ve en la siguiente petición, sin
 * esperar a que caduque. Y si Mongo no está, se devuelve lo último que se leyó —o una
 * lista vacía la primera vez— en vez de reventar: una corrección no puede tumbar el
 * almacén.
 */
let cache = { cuando: 0, mapa: new Map() };
const TTL = 30 * 1000;
let indiceCreado = false;

/** El código tal como se guarda y se busca: sin espacios y en mayúsculas. */
function normalizar(codigo) {
  return String(codigo || '').trim().toUpperCase();
}

/** Las correcciones guardadas, como `Map<codigo, { precio, fecha, motivo }>`. */
export async function preciosCorregidos() {
  if (cache.cuando && Date.now() - cache.cuando < TTL) return cache.mapa;

  try {
    const d = await db();
    const filas = await d.collection(COLECCION).find({}).toArray();
    const mapa = new Map();

    for (const f of filas) {
      const codigo = normalizar(f.codigo);
      const precio = Number(f.precio);

      if (codigo && Number.isFinite(precio) && precio > 0) {
        mapa.set(codigo, { precio, fecha: f.fecha || null, motivo: f.motivo || null });
      }
    }

    cache = { cuando: Date.now(), mapa };
    return mapa;
  } catch (e) {
    // Mongo caído o sin conectar todavía: se enseña el de la última venta, que es lo que
    // había antes de esto. Se avisa en el log, que es donde se mira cuando algo falta.
    console.warn('[precios] no se pudieron leer las correcciones:', e.message);
    return cache.mapa;
  }
}

/**
 * Guarda (o cambia) la corrección de un producto.
 *
 * `upsert` y no «mirar y luego guardar»: entre una cosa y la otra caben dos peticiones a
 * la vez, y con el índice único y el upsert no puede quedar el mismo código dos veces.
 */
export async function corregirPrecio(codigo, precio, motivo) {
  const cod = normalizar(codigo);
  const n = Number(precio);

  if (!cod) throw new Error('Falta el código del producto.');
  if (!Number.isFinite(n) || n <= 0) throw new Error('El precio tiene que ser un número mayor que cero.');

  const d = await db();

  if (!indiceCreado) {
    try {
      await d.collection(COLECCION).createIndex({ codigo: 1 }, { unique: true });
    } catch (e) {
      // No debe pasar, pero si algún día quedara un duplicado viejo no se queda sin poder
      // guardar por eso: se sigue sin índice y ya.
      console.warn('[precios] no se pudo crear el índice único:', e.message);
    }
    indiceCreado = true;
  }

  await d.collection(COLECCION).updateOne(
    { codigo: cod },
    {
      $set: {
        precio: n,
        motivo: motivo ? String(motivo).slice(0, 200) : null,
        fecha: hoyEnCuba(),
        actualizadoEn: new Date(),
      },
    },
    { upsert: true },
  );

  cache = { cuando: 0, mapa: new Map() };

  return { codigo: cod, precio: n, fecha: hoyEnCuba() };
}

/** Quita la corrección: el producto vuelve al precio de su última venta. */
export async function borrarCorreccion(codigo) {
  const cod = normalizar(codigo);

  if (!cod) return false;

  const d = await db();
  const r = await d.collection(COLECCION).deleteOne({ codigo: cod });

  cache = { cuando: 0, mapa: new Map() };

  return r.deletedCount > 0;
}
