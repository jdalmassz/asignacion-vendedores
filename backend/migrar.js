/**
 * Pasa a MongoDB lo que quedó en los ficheros JSON.
 *
 * Se corre UNA vez, a mano. No va en el arranque del servidor a propósito: una migración
 * que se ejecuta sola en cada despliegue es una que un día duplica todo sin que nadie la
 * haya llamado.
 *
 * Es repetible: si se corre dos veces no duplica, porque compara por el contenido de cada
 * asignación y el folio de cada cobro ya es único en la base.
 */
import fs from 'fs';
import { MongoClient } from 'mongodb';

const URI = process.env.MONGO_URL;
const NOMBRE = process.env.MONGO_DB || 'asignacion_vendedores';

if (!URI) {
  console.error('Falta MONGO_URL');
  process.exit(1);
}

const leer = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : []);

const cliente = new MongoClient(URI);
await cliente.connect();
const db = cliente.db(NOMBRE);

let nuevas = 0;
for (const a of leer('asignaciones.json')) {
  const clave = {
    vendedor: a.vendedor, producto_id: a.producto_id,
    cantidad: a.cantidad, fecha: a.fecha,
  };
  const r = await db.collection('asignaciones').updateOne(
    clave,
    { $setOnInsert: { ...clave, producto_nombre: a.producto_nombre, idAntiguo: a.id, creadoEn: new Date() } },
    { upsert: true },
  );

  if (r.upsertedCount) nuevas++;
}

let cobrosNuevos = 0;
for (const c of leer('cobros.json')) {
  const f = String(c.folio || '').toUpperCase();

  if (!f) continue;

  const r = await db.collection('cobros').updateOne(
    { folio: f },
    { $setOnInsert: { folio: f, fecha: c.fecha || new Date().toISOString().split('T')[0] } },
    { upsert: true },
  );

  if (r.upsertedCount) cobrosNuevos++;
}

console.log(`asignaciones nuevas: ${nuevas} · cobros nuevos: ${cobrosNuevos}`);
console.log(`total en la base: ${await db.collection('asignaciones').countDocuments()} asignaciones, ${await db.collection('cobros').countDocuments()} cobros`);
await cliente.close();
