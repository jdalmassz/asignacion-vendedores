/**
 * Dónde se guardan las asignaciones y los cobros.
 *
 * # Por qué esto y no los ficheros JSON
 *
 * Antes eran `asignaciones.json` y `cobros.json` escritos con `fs.writeFileSync` al lado
 * del código. Eso funciona en el portátil de quien lo escribe y **se pierde entero en el
 * servidor**: el contenedor se recrea desde la imagen en cada despliegue, así que todo lo
 * que se hubiera guardado desaparece sin avisar a nadie. El primer despliegue después de
 * que alguien empiece a usarlo en serio se lleva su trabajo por delante.
 *
 * MongoDB porque estos datos no tienen forma fija —una asignación de hoy puede llevar
 * mañana un campo más— y porque no hay relaciones que mantener: son dos listas.
 *
 * # Las dos cosas que se arreglan de camino
 *
 * - **El id ya no es `length + 1`.** Con eso, borrar la asignación 3 de 5 hacía que la
 *   siguiente volviera a ser la 5: dos registros con el mismo id, y borrar uno borraba los
 *   dos. Ahora lo pone Mongo (`_id`) y no se repite jamás.
 * - **El mes ya no está escrito a mano.** Había un `startsWith('2026-09')` incrustado: en
 *   octubre la pantalla se habría quedado vacía sin que nadie entendiera por qué.
 */
import { MongoClient, ObjectId } from 'mongodb';

const URI = process.env.MONGO_URL || 'mongodb://localhost:27017';
const NOMBRE_BASE = process.env.MONGO_DB || 'asignacion_vendedores';

let cliente = null;
let base = null;

/**
 * La conexión, una sola para todo el proceso.
 *
 * El driver de Mongo ya trae su propio pool y reconecta solo, así que abrir una por
 * petición sería pagar el saludo cada vez para nada.
 */
async function db() {
  if (base) return base;

  cliente = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  await cliente.connect();
  base = cliente.db(NOMBRE_BASE);

  // Índices: por fecha porque la pantalla siempre pide un mes, y el folio ÚNICO porque
  // marcar dos veces el mismo cobro tiene que ser inofensivo, no crear dos filas.
  await base.collection('asignaciones').createIndex({ fecha: -1 });
  await base.collection('cobros').createIndex({ folio: 1 }, { unique: true });

  return base;
}

// ---- Asignaciones ----

/** Las de un mes (`AAAA-MM`), de la más nueva a la más vieja. */
export async function listarAsignaciones(mes) {
  const d = await db();
  const filtro = mes ? { fecha: { $regex: `^${mes}` } } : {};

  return (await d.collection('asignaciones').find(filtro).sort({ fecha: -1 }).toArray())
    .map(salida);
}

export async function crearAsignacion(a) {
  const d = await db();
  const doc = {
    vendedor: a.vendedor,
    producto_id: a.producto_id,
    producto_nombre: a.producto_nombre,
    cantidad: a.cantidad,
    fecha: a.fecha || new Date().toISOString().split('T')[0],
    creadoEn: new Date(),
  };
  const r = await d.collection('asignaciones').insertOne(doc);

  return salida({ ...doc, _id: r.insertedId });
}

/** Devuelve si borró algo, para poder contestar 404 cuando no existe. */
export async function borrarAsignacion(id) {
  const d = await db();
  const r = await d.collection('asignaciones').deleteOne(porId(id));

  return r.deletedCount > 0;
}

// ---- Cobros manuales ----

export async function listarCobros() {
  const d = await db();

  return (await d.collection('cobros').find({}).toArray()).map((c) => ({ folio: c.folio, fecha: c.fecha }));
}

/**
 * Marca un folio como cobrado. Idempotente: marcarlo dos veces deja una sola marca.
 *
 * `upsert` y no «mirar y luego insertar»: entre la comprobación y la escritura caben dos
 * peticiones a la vez, y entonces se crean las dos. Con el índice único y el upsert, eso
 * no puede pasar.
 */
export async function marcarCobro(folio) {
  const d = await db();
  const f = String(folio).toUpperCase();

  await d.collection('cobros').updateOne(
    { folio: f },
    { $setOnInsert: { folio: f, fecha: new Date().toISOString().split('T')[0] } },
    { upsert: true },
  );
}

export async function desmarcarCobro(folio) {
  const d = await db();
  const r = await d.collection('cobros').deleteOne({ folio: String(folio).toUpperCase() });

  return r.deletedCount > 0;
}

/** El conjunto de folios cobrados a mano, que es como lo usa el resto del código. */
export async function cobrosManualesSet() {
  return new Set((await listarCobros()).map((c) => String(c.folio || '').toUpperCase()));
}

// ---- Auxiliares ----

/**
 * El `_id` de Mongo sale como `id` de texto.
 *
 * La pantalla ya trataba el id como una etiqueta opaca —lo recibe y lo devuelve al
 * borrar—, así que cambiar el número por el identificador de Mongo no le afecta. Se
 * mantiene el nombre `id` para no tener que tocar el frontend.
 */
function salida(doc) {
  const { _id, creadoEn, ...resto } = doc;

  return { id: String(_id), ...resto };
}

/** Acepta el id venga como venga: los antiguos eran números, los nuevos son de Mongo. */
function porId(id) {
  const texto = String(id);

  // `ObjectId` sólo acepta 24 caracteres hexadecimales; con cualquier otra cosa lanza.
  if (/^[0-9a-fA-F]{24}$/.test(texto)) {
    return { _id: new ObjectId(texto) };
  }

  return { idAntiguo: Number(texto) || texto };
}

export async function cerrar() {
  if (cliente) await cliente.close();
  cliente = null;
  base = null;
}
