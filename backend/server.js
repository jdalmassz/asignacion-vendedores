import express from 'express';
import cors from 'cors';
import compression from 'compression';
import * as ventra from './ventra.js';
import {
  listarAsignaciones, mesesConAsignaciones, crearAsignacion, borrarAsignacion,
  listarCobros, marcarCobro, desmarcarCobro, cobrosManualesSet,
} from './almacen.js';

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

try {
  process.loadEnvFile();
} catch (e) {
  // .env no existe: usar variables de entorno del sistema
}

// Procovar API config
const API_BASE = process.env.PROCOVAR_API_BASE || 'https://pedidos.procovar.cloud/api';
const API_KEY = process.env.PROCOVAR_API_KEY || '';
const SUCURSAL_ID = process.env.PROCOVAR_SUCURSAL_ID || '';

/**
 * Los datos del punto de venta ya no salen de MySQL, sino de la API de Ventra.
 *
 * La base `camaguey` vive en la red local de la sucursal (`192.168.1.217`) y desde el
 * servidor no se alcanza. Ventra la publica por HTTP y es lo que usa analitics. Ver
 * `ventra.js`.
 */

// Caché en memoria con TTL. cachea la promesa para evitar "thundering herd"
// (varias requests concurrentes comparten el mismo fetch).
const cache = new Map();

function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn).catch(err => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { ts: now, promise });
  return promise;
}

function invalidate(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}


function normalizeVendedorName(note) {
  if (!note) return null;
  const idx = note.indexOf('V-');
  if (idx === -1) return null;
  let name = note.substring(idx + 2).split(';')[0].trim();
  name = name.replace(/Ñ/gi, 'N');
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  name = name.replace(/PADRAN/gi, 'PADRON');
  name = name.replace(/HECAVARRAA/gi, 'HECAVARRIA');
  name = name.replace(/IRADIEL(?!\sCISNEROS)/gi, 'IRADIEL CISNEROS');
  name = name.replace(/[^A-Za-z\s]/g, '').toUpperCase();
  return name.replace(/\s+/g, ' ').trim();
}

function normProdTokens(s) {
  if (!s) return [];
  return s
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/0\.5|0,5/g, ' 500 ')
    .replace(/1\.5|1,5/g, ' 1500 ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !/^(CERVEZA|MALTA|BOTELLA|BLISTER|REGIO|GUAJIRA)$/.test(t));
}

function canonCode(g) {
  return String(g.Code || '').trim() || String(g.ID);
}

// Índice de productos para búsquedas O(1) en vez de recorrer el array por cada ítem.
function makeGoodsIndex(goods) {
  const byCanon = new Map();
  const byRawCode = new Map();
  const byId = new Map();
  const tokensList = [];
  for (const g of goods) {
    byId.set(g.ID, g);
    byCanon.set(canonCode(g).toUpperCase(), g);
    if (g.Code) byRawCode.set(String(g.Code).trim(), g);
    tokensList.push({ id: g.ID, tokens: new Set(normProdTokens(g.Name)) });
  }
  return { byCanon, byRawCode, byId, tokensList };
}

async function loadGoodsIndex() {
  return cached('goodsIndex', 5 * 60 * 1000, async () => {
    return makeGoodsIndex(await ventra.productos());
  });
}

function findGoodIDForAsign(a, index) {
  const pid = String(a.producto_id || '').trim();
  const byCode = index.byRawCode.get(pid);
  if (byCode) return byCode.ID;

  const aTokens = normProdTokens(a.producto_nombre + ' ' + a.producto_id);
  let best = null, bestScore = 0;
  for (const g of index.tokensList) {
    let score = 0;
    for (const t of aTokens) if (g.tokens.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = g.id; }
  }
  return bestScore >= 2 ? best : null;
}

function goodIdFromItem(it, index) {
  if (!it) return null;
  const c = String(it.codigo || '').trim().toUpperCase();
  if (c) {
    const byCode = index.byCanon.get(c);
    if (byCode) return byCode.ID;
  }
  return findGoodIDForAsign({ producto_id: it.codigo || '', producto_nombre: it.producto || it.codigo || '' }, index) || null;
}

/**
 * El día de hoy EN CUBA, `AAAA-MM-DD`.
 *
 * El contenedor corre en UTC y Cuba va cuatro horas por detrás. Con
 * `new Date().toISOString()` —que es lo que había en media docena de sitios— a partir
 * de las ocho de la tarde de La Habana el servidor ya cree que es mañana. El día 30 a
 * las 20:30 eso significa que ya es octubre: la lista de asignaciones se queda vacía y
 * el resumen pierde el mes entero, cuatro horas antes de tiempo, todos los meses.
 *
 * `en-CA` porque ese formato ES `AAAA-MM-DD`, y con `timeZone` el horario de verano lo
 * resuelve el propio sistema en vez de restar cuatro a mano y equivocarse en marzo.
 */
const FECHA_CUBA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Havana',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function hoyEnCuba() {
  return FECHA_CUBA.format(new Date());
}

/** El mes en curso en Cuba, `AAAA-MM`. */
function mesEnCuba() {
  return hoyEnCuba().slice(0, 7);
}

/** El primer y el último día del mes en curso, `AAAA-MM-DD`. */
function rangoDelMes() {
  const [a, m] = hoyEnCuba().split('-');
  // Día 0 del mes siguiente = último del actual. `Date.UTC` para que el propio cálculo
  // no vuelva a depender de la zona del proceso.
  const ultimo = new Date(Date.UTC(Number(a), Number(m), 0)).getUTCDate();

  return [`${a}-${m}-01`, `${a}-${m}-${String(ultimo).padStart(2, '0')}`];
}

async function apiGet(path) {
  const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}sucursalId=${SUCURSAL_ID}`;
  const resp = await fetch(url, {
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json'
    }
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function fetchAllOrders(desde, hasta) {
  return cached(`orders:${desde}:${hasta}`, 60 * 1000, () => fetchAllOrdersUncached(desde, hasta));
}

async function fetchAllOrdersUncached(desde, hasta) {
  const allOrders = [];
  let page = 1;
  const limit = 1000;
  let totalPages = 1;

  while (page <= totalPages) {
    /**
     * `fechaDesde` y `fechaHasta`, no `desde` y `hasta`.
     *
     * PEDIDO lee esos dos nombres y **ignora en silencio** cualquier otro: con `desde` y
     * `hasta` no filtraba nada y esto se traía los 63.000 pedidos de todas las sucursales,
     * de mil en mil, tres veces por pantalla. No fallaba: tardaba y contaba de más.
     */
    let path = `/orders?page=${page}&limit=${limit}`;
    if (desde) path += `&fechaDesde=${desde}`;
    if (hasta) path += `&fechaHasta=${hasta}`;

    const result = await apiGet(path);

    if (Array.isArray(result)) {
      allOrders.push(...result);
      break;
    }

    if (result.data) {
      allOrders.push(...result.data);
      if (result.pagination) {
        totalPages = result.pagination.totalPages;
      }
    } else {
      break;
    }

    page++;
    await new Promise(r => setTimeout(r, 200));
  }

  // Filtro extra por fecha (la API devuelve pedidos fuera de rango en las últimas páginas)
  const desdeTs = desde ? new Date(desde + 'T00:00:00').getTime() : null;
  const hastaTs = hasta ? new Date(hasta + 'T23:59:59').getTime() : null;
  const filtrados = allOrders.filter(o => {
    if (!o.fecha) return true;
    const ts = new Date(o.fecha).getTime();
    if (desdeTs && ts < desdeTs) return false;
    if (hastaTs && ts > hastaTs) return false;
    return true;
  });

  // Deduplicar por id (la paginación repite pedidos en páginas distintas)
  const vistos = new Set();
  return filtrados.filter(o => {
    if (!o.id) return true;
    if (vistos.has(o.id)) return false;
    vistos.add(o.id);
    return true;
  });
}

// GET /api/vendedores — desde Procovar API
app.get('/api/vendedores', async (req, res) => {
  try {
    const vendedores = await apiGet('/vendedores');
    const activos = vendedores.filter(v => v.activo);
    activos.sort((a, b) => a.nombre.localeCompare(b.nombre));
    res.json({ vendedores: activos.map(v => ({
      id: v.id,
      nombre: v.nombre,
      codigo: v.codigo
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/productos — productos únicos de Procovar API con stock
app.get('/api/productos', async (req, res) => {
  try {
    const orders = await fetchAllOrders(...rangoDelMes());
    const seen = {};
    for (const order of orders) {
      if (!order.items) continue;
      for (const item of order.items) {
        const name = item.producto || item.codigo;
        if (name && !seen[name]) {
          seen[name] = {
            id: item.codigo || name,
            code: item.codigo || '',
            name: name,
            precio: item.precioUnidad || 0,
            stock: item.stock || 0
          };
        }
        if (name && item.stock > (seen[name]?.stock || 0)) {
          seen[name].stock = item.stock;
        }
      }
    }
    const productos = Object.values(seen)
      .filter(p => p.stock > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ productos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Las asignaciones de un mes.
 *
 * El mes viene de fuera, y si no viene se usa el actual. Antes estaba escrito a mano
 * (`startsWith('2026-09')`): en octubre la pantalla se habría quedado vacía y nadie habría
 * sabido por qué.
 */
function mesActual() {
  return mesEnCuba();
}

function getAsignaciones(mes) {
  return listarAsignaciones(mes || mesActual());
}

// GET /api/asignaciones — acepta ?mes=AAAA-MM; sin él, el mes en curso
app.get('/api/asignaciones', async (req, res, next) => {
  try {
    res.json({ asignaciones: await getAsignaciones(req.query.mes) });
  } catch (e) { next(e); }
});

/**
 * Lo que tiene que traer una asignación para poder guardarse.
 *
 * Antes no se miraba nada: el cuerpo entraba tal cual en Mongo. Una cantidad negativa,
 * un texto donde va un número o un vendedor vacío se guardaban sin protestar y luego
 * salían sumados en el resumen, donde ya no hay forma de saber de dónde vino el número
 * raro. Es más barato no dejarlos entrar.
 *
 * Devuelve el motivo, o `null` si está bien.
 */
function loQueFaltaEnLaAsignacion({ vendedor, producto_id, producto_nombre, cantidad, fecha }) {
  if (!String(vendedor || '').trim()) return 'Falta el vendedor.';
  if (!String(producto_id || '').trim() && !String(producto_nombre || '').trim()) {
    return 'Falta el producto.';
  }

  const n = Number(cantidad);
  if (!Number.isFinite(n) || n <= 0) return 'La cantidad tiene que ser un número mayor que cero.';

  // Sin tope habría que fiarse de que nadie se deje pulsado un cero. Con 10 sucursales
  // de Procovar, nada real pasa de esto.
  if (n > 1000000) return 'La cantidad es demasiado grande.';

  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
    return 'La fecha tiene que venir como AAAA-MM-DD.';
  }

  return null;
}

/**
 * GET /api/asignaciones/meses — los meses que tienen algo.
 *
 * La lista de asignaciones enseña un mes cada vez, y por defecto el que corre. Sin esto
 * no habría forma de llegar a los de antes: el 1 de octubre las de septiembre siguen en
 * la base pero desaparecen de la pantalla para siempre.
 */
app.get('/api/asignaciones/meses', async (req, res, next) => {
  try {
    const meses = await mesesConAsignaciones();
    const actual = mesActual();

    // El mes en curso sale siempre, aunque todavía no tenga ninguna: si no, el
    // selector no ofrecería el mes que estás mirando.
    if (!meses.some((m) => m.mes === actual)) meses.unshift({ mes: actual, cuantas: 0 });

    res.json({ meses, actual });
  } catch (e) { next(e); }
});

// POST /api/asignaciones
app.post('/api/asignaciones', async (req, res, next) => {
  try {
    const { vendedor, producto_id, producto_nombre, cantidad, fecha } = req.body;

    const falta = loQueFaltaEnLaAsignacion(req.body || {});
    if (falta) return res.status(400).json({ success: false, error: falta });

    const nueva = await crearAsignacion({
      vendedor: String(vendedor).trim(),
      producto_id,
      producto_nombre,
      cantidad: Number(cantidad),
      fecha,
    });

    /*
     * Se avisa si el producto no casa con nada de Ventra.
     *
     * El resumen empareja cada asignación con un GoodID y, si no lo encuentra, se la
     * salta en silencio (`if (!goodId) continue`). O sea: la asignación se guarda, sale
     * en la lista, y en el resumen no aparece nunca. Aquí no se impide guardarla —puede
     * ser un producto que todavía no ha llegado al almacén— pero se dice, que es lo que
     * no pasaba.
     */
    let aviso = null;
    try {
      const goodsIndex = await loadGoodsIndex();
      if (!findGoodIDForAsign({ producto_id, producto_nombre }, goodsIndex)) {
        aviso = 'Guardada, pero este producto no coincide con ninguno de Ventra: no va a aparecer en el resumen hasta que coincida.';
      }
    } catch {
      // Si Ventra no contesta no se bloquea el guardado: la asignación ya está escrita.
    }

    res.json({ success: true, id: nueva.id, asignacion: nueva, aviso });
  } catch (e) { next(e); }
});

// DELETE /api/asignaciones/:id
app.delete('/api/asignaciones/:id', async (req, res, next) => {
  try {
    const borrada = await borrarAsignacion(req.params.id);

    if (!borrada) return res.status(404).json({ success: false, error: 'Asignación no encontrada' });

    res.json({ success: true });
  } catch (e) { next(e); }
});

// GET /api/ventas — desde MariaDB (operaciones despachadas Sign=-1)
async function computeVentas() {
  return cached('ventas', 60 * 1000, async () => {
    // El mes en curso, en hora de Cuba. Antes eran dos fechas escritas a mano
    // ('2026-09-01'..'2026-10-01') y después `toISOString()`, que va en UTC.
    const [primero] = rangoDelMes();
    const rows = await ventra.ventas(primero, hoyEnCuba());

    const ventas = [];
    for (const row of rows) {
      const vendedor = normalizeVendedorName(row.Note);
      if (!vendedor) continue;
      const fechaStr = row.Date instanceof Date
        ? `${row.Date.getFullYear()}-${String(row.Date.getMonth() + 1).padStart(2, '0')}-${String(row.Date.getDate()).padStart(2, '0')}`
        : String(row.Date).split('T')[0];
      ventas.push({
        vendedor,
        producto_id: row.GoodID,
        producto_nombre: row.Name,
        precio: row.PriceOut1 || 0,
        cantidad: row.TotalVendido || 0,
        total: (row.PriceOut1 || 0) * (row.TotalVendido || 0),
        fecha: fechaStr,
        cliente: row.PartnerID || 0
      });
    }
    return ventas;
  });
}

app.get('/api/ventas', async (req, res) => {
  try {
    res.json({ ventas: await computeVentas() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Lo DESPACHADO del mes: las FACTURAS DE VENTRA.
 *
 * Ventra manda, y punto. Lo que salió del almacén es lo que Ventra facturó: es el
 * hecho físico y no depende de que nadie haya tomado bien un pedido. Así estaba antes
 * y así se queda.
 *
 * PEDIDO entra como EXTRA, no como fuente. Sirve para dos cosas que Ventra sola no
 * puede decir, y las dos se calculan cruzando por el folio de la nota (`P-...`):
 *
 *   - `pedidoMap`   lo que PIDIÓ el cliente, que sale del campo `pedido` de cada línea
 *                   de `lineasFactura`. Es el otro lado de la comparación: se pidieron
 *                   692, se facturaron 852.
 *   - `cambiadoMap` de lo facturado, cuánto salió de un pedido marcado `cambiado`.
 *   - `sinPedidoMap` lo que Ventra facturó y PEDIDO no tiene: folio desconocido, o
 *                   factura sin `P-` en la nota. Este mes, 147 packs de ALEXANDER, 40
 *                   de DEYANIRA y 464 de vodka de IRADIEL.
 *
 * Los tres son subconjuntos o comparaciones de lo de Ventra; ninguno lo sustituye.
 */
function folioDeLaNota(nota) {
  const m = String(nota || '').match(/(?:^|;)\s*P-([A-Z0-9\-]+);/i);

  return m ? m[1].toUpperCase() : null;
}

function lineasDeLaFactura(pedido) {
  try {
    const l = JSON.parse(pedido.lineasFactura || '[]');

    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

async function loadDespachos() {
  return cached('despachos', 60 * 1000, async () => {
    const [primero, ultimo] = rangoDelMes();
    const [rows, orders] = await Promise.all([
      ventra.ventas(primero, hoyEnCuba() < ultimo ? hoyEnCuba() : ultimo),
      fetchAllOrders(primero, ultimo),
    ]);

    const pedidoPorFolio = new Map();
    for (const o of orders) {
      if (o.folio) pedidoPorFolio.set(o.folio.toUpperCase(), o);
    }

    const despachosMap = {};    // vendedor|GoodID -> packs facturados por Ventra
    const cambiadoMap = {};     // de eso, lo salido de un pedido que cambió
    const sinPedidoMap = {};    // de eso, lo que no tiene pedido detrás
    const pedidoMap = {};       // lo que se PIDIÓ, para comparar. No entra en la barra.
    const foliosDespachados = new Set();
    const yaSumadoElPedido = new Set();

    const sumar = (mapa, clave, cuanto) => {
      mapa[clave] = (mapa[clave] || 0) + (Number(cuanto) || 0);
    };

    for (const row of rows) {
      const vendedor = normalizeVendedorName(row.Note);
      if (!vendedor) continue;

      const clave = `${vendedor}|${row.GoodID}`;
      const folio = folioDeLaNota(row.Note);

      if (folio) foliosDespachados.add(folio);

      // LA FUENTE: lo que Ventra facturó.
      sumar(despachosMap, clave, row.TotalVendido);

      const pedido = folio ? pedidoPorFolio.get(folio) : null;
      const conFactura = pedido
        && (pedido.facturaEstado === 'igual' || pedido.facturaEstado === 'cambiado');

      if (!conFactura) {
        sumar(sinPedidoMap, clave, row.TotalVendido);
        continue;
      }

      if (pedido.facturaEstado === 'cambiado') sumar(cambiadoMap, clave, row.TotalVendido);

      /*
       * Lo pedido se suma UNA vez por folio: sus líneas traen todos los productos de esa
       * factura, y el folio aparece en tantas filas de Ventra como productos tenga.
       *
       * Las líneas viejas sin el campo `pedido` no suman por este lado. Contarlas como
       * cero inventaría una diferencia que no existe.
       */
      if (yaSumadoElPedido.has(folio)) continue;
      yaSumadoElPedido.add(folio);

      for (const linea of lineasDeLaFactura(pedido)) {
        if (!linea.codigo || linea.pedido == null) continue;

        sumar(pedidoMap, `${vendedor}|${linea.codigo}`, linea.pedido);
      }
    }

    return { despachosMap, pedidoMap, cambiadoMap, sinPedidoMap, foliosDespachados };
  });
}

async function computeResumen() {
  // El mes en curso, no uno escrito a mano: ver `getAsignaciones`.
  const asignSep = await listarAsignaciones(mesActual());

  // Group assignments by vendedor + producto (mapear a GoodID real)
  const goodsIndex = await loadGoodsIndex();
  const asignMap = {};
  const asignInfo = {};
  for (const a of asignSep) {
    const vendedorNorm = normalizeVendedorName('V-' + a.vendedor) || a.vendedor;
    const goodId = findGoodIDForAsign(a, goodsIndex);
    if (!goodId) continue;
    const g = goodsIndex.byId.get(goodId);
    const key = `${vendedorNorm}|${goodId}`;
    if (!asignMap[key]) {
      asignMap[key] = 0;
      asignInfo[key] = {
        vendedor: vendedorNorm,
        goodId,
        producto_id: g ? canonCode(g) : String(a.producto_id || a.producto_nombre || goodId),
        producto_nombre: g ? g.Name : a.producto_nombre
      };
    }
    asignMap[key] += a.cantidad;
  }

  // Despachos REALES desde MariaDB (Sign=-1) en el mes, por vendedor + GoodID
  const { despachosMap, pedidoMap, cambiadoMap, sinPedidoMap, foliosDespachados } = await loadDespachos();

  /**
   * Lo que todavía no ha salido del almacén, y de dónde sale lo que sí salió.
   *
   * PEDIDO marca cada pedido con `facturaEstado`: `igual` si se facturó lo que se
   * pidió, `cambiado` si se facturó otra cosa, `sin_factura` si aún no la tiene. Este
   * mes: 280 iguales, 83 cambiados y 307 sin factura de 670.
   *
   * Aquí se usa para DOS cosas:
   *
   *  1. Lo que no ha salido es «en proceso», sin más. Antes se partía en «facturado» y
   *     «en proceso», y «facturado» era CERO por construcción: tener factura en Ventra
   *     es ser una venta de Ventra, así que el folio aparece en las notas y el pedido
   *     cuenta como despachado. De los 363 pedidos con factura del mes, cero tenían el
   *     folio sin ver. La columna prometía un dato que no podía dar.
   *
   *  2. Lo que sí se ve ahora es, de lo que SALIÓ, cuánto salió con una factura
   *     distinta de lo que se pidió y cuánto salió sin pedido ninguno. Eso lo arma
   *     `loadDespachos`, que es quien cruza las notas de Ventra con los pedidos.
   *
   * Fuera se quedan los expirados, que caducaron y no son trabajo pendiente, y la
   * marca a mano de esta aplicación, que mide lo que los vendedores declaran cobrado
   * —otra cosa— y se ve pedido por pedido en el detalle.
   */
  const orders = await fetchAllOrders(...rangoDelMes());
  const procesoMap = {};
  const cerradoSinFacturaMap = {};

  for (const o of orders) {
    if (o.estado === 'expirada') continue;
    if (!o.folio) continue;
    if (foliosDespachados.has(o.folio.toUpperCase())) continue;

    const vendedor = normalizeVendedorName('V-' + (o.vendedor?.nombre || ''));
    if (!vendedor) continue;

    /*
     * CERRADO SIN FACTURA no es EN PROCESO.
     *
     * Un pedido que PEDIDO dio por `completada` y que Ventra nunca facturó está
     * cerrado: no va a salir solo, nadie lo está preparando. Contarlo como "en proceso"
     * dice que hay trabajo en marcha donde lo que hay es un agujero.
     *
     * ALEXANDER tenía 242 "en proceso" de PARRANDA y 122 de esos eran cuatro pedidos
     * del 9 de septiembre ya cerrados, comprobados el día 10 y sin factura. Este mes son
     * 30 pedidos y 627 packs de los dos productos asignados.
     */
    const cerradoSinFactura = o.estado === 'completada';

    for (const it of (o.items || [])) {
      const goodId = goodIdFromItem(it, goodsIndex);
      if (!goodId) continue;

      const key = `${vendedor}|${goodId}`;
      if (!asignInfo[key]) continue;

      const donde = cerradoSinFactura ? cerradoSinFacturaMap : procesoMap;

      donde[key] = (donde[key] || 0) + (it.packs || 0);
    }
  }

  /*
   * `completada` YA NO SE TOPA al asignado.
   *
   * Estaba escrito `Math.min(despachado, asignado)`, así que despachar de más era
   * invisible: MAYLEN REMON DIAZ sacó 202 de VODKA REGIO contra 180 asignados y la
   * pantalla ponía 180, sin rastro de los 22 de diferencia. Y no era un caso suelto:
   * pasaba en 4 de las 14 filas del mes y escondía 127 unidades —GEORLIS 982 contra
   * 912, ANDY 933, ERNESTO 926—.
   *
   * Pasarse de lo asignado es justo lo que hay que ver, no lo que hay que recortar.
   * Ahora va el número real y aparte `exceso`, que es cuánto se pasó.
   *
   * `pendiente` sí sigue mirando lo que cabe dentro de lo asignado: lo que falta por
   * despachar no puede ser negativo porque alguien haya sacado de más.
   */
  const resumen = [];
  for (const key in asignMap) {
    const info = asignInfo[key];
    const asignado = asignMap[key];
    const clave = `${info.vendedor}|${info.goodId}`;
    const despachado = despachosMap[clave] || 0;
    const completada = despachado;
    // Lo que cabe DENTRO de lo asignado: `pendiente` no puede volverse negativo porque
    // alguien haya sacado de más.
    const dentroDeLoAsignado = Math.min(despachado, asignado);

    /*
     * De lo que ya salió, cuánto se facturó DISTINTO de lo que se pidió, y cuánto salió
     * sin ningún pedido detrás. Los dos los arma `loadDespachos` al cruzar las notas de
     * Ventra con los pedidos.
     */
    const cambiado = cambiadoMap[clave] || 0;
    const sinPedido = sinPedidoMap[clave] || 0;
    const pedidoOriginal = pedidoMap[clave] || 0;

    const enProceso = procesoMap[key] || 0;
    const cerradoSinFactura = cerradoSinFacturaMap[key] || 0;
    resumen.push({
      vendedor: info.vendedor,
      producto_id: info.producto_id,
      good_id: info.goodId,
      producto_nombre: info.producto_nombre,
      asignado,
      en_proceso: enProceso,
      /** Pedidos que PEDIDO cerró y Ventra nunca facturó. Ni salieron ni van a salir. */
      cerrado_sin_factura: cerradoSinFactura,
      /** Lo que PIDIERON los clientes de esto, para comparar contra lo facturado. */
      pedido: pedidoOriginal,
      /** De lo despachado, cuánto salió con una factura distinta de lo pedido. */
      cambiado,
      /** De lo despachado, cuánto salió sin ningún pedido detrás. */
      sin_pedido: sinPedido,
      /** Cuánto se pasó de lo asignado. 0 cuando no se pasó. */
      exceso: Math.max(0, despachado - asignado),
      completada,
      pendiente: Math.max(0, asignado - dentroDeLoAsignado)
    });
  }
  return resumen;
}

// GET /api/resumen — asignaciones vs despachos reales (MariaDB) + pedidos en proceso (API)
app.get('/api/resumen', async (req, res) => {
  try {
    res.json({ resumen: await computeResumen() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/almacen — desde MariaDB (store, inventario real)
async function computeAlmacen() {
  return cached('almacen', 60 * 1000, async () => {
    const rows = await ventra.almacen();

    const almacenes = {};
    for (const r of rows) {
      if (!r.Name || !r.ID) continue;
      const nombre = r.almacen || ('Almacen ' + r.object_id);
      if (!almacenes[nombre]) almacenes[nombre] = { almacen: nombre, productos: [] };
      almacenes[nombre].productos.push({
        producto_id: r.Code || r.ID,
        nombre: r.Name,
        precio: r.PriceOut1 || 0,
        // De cuándo es ese precio. Ventra no guarda precio en la ficha del producto:
        // sale de la última venta, y puede ser de hace dos años. Ver `preciosRecientes`.
        precio_fecha: r.precioFecha || null,
        precio_viejo: !!r.precioViejo,
        stock: r.stock
      });
    }
    Object.values(almacenes).forEach(a => {
      a.productos.sort((x, y) => x.nombre.localeCompare(y.nombre));
      a.total_unidades = a.productos.reduce((s, p) => s + p.stock, 0);
      a.total_valor = a.productos.reduce((s, p) => s + (p.precio || 0) * p.stock, 0);
    });
    const lista = Object.values(almacenes).sort((a, b) => a.almacen.localeCompare(b.almacen));
    const totales = {
      productos: lista.reduce((s, a) => s + a.productos.length, 0),
      unidades: lista.reduce((s, a) => s + a.total_unidades, 0),
      valor: lista.reduce((s, a) => s + a.total_valor, 0)
    };
    return { productos: lista, totales };
  });
}

app.get('/api/almacen', async (req, res) => {
  try {
    res.json(await computeAlmacen());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clientes-por-vendedor — desde Procovar API
app.get('/api/clientes-por-vendedor', async (req, res) => {
  try {
    const data = await apiGet('/clientes/por-vendedor');
    res.json({ vendedores: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/detalle-proceso — detalle de pedidos en_proceso por vendedor+producto
async function computeDetalleProceso() {
  const orders = await fetchAllOrders(...rangoDelMes());
  const goodsIndex = await loadGoodsIndex();

  // Despachos reales para saber qué folios ya se despacharon
  const { foliosDespachados } = await loadDespachos();

  const result = {};
  const cobrosManuales = await cobrosManualesSet();
  // La MISMA regla que el resumen, a propósito: si aquí se filtrara distinto, el número
  // de la tabla y la lista que sale al abrirlo no cuadrarían, y no habría forma de saber
  // cuál de los dos miente. Ver `computeResumen`.
  for (const o of orders) {
    if (o.estado === 'expirada') continue;
    if (!o.folio) continue;
    if (foliosDespachados.has(o.folio.toUpperCase())) continue;
    const vendedor = normalizeVendedorName('V-' + (o.vendedor?.nombre || ''));
    if (!vendedor) continue;
    // Tres cosas distintas, cada una con su nombre. Juntarlas fue el error de antes.
    const facturado = o.facturaEstado === 'igual' || o.facturaEstado === 'cambiado';
    const cobradoPorVendedor = o.pedido_cobrado === 'completo';
    const cobradoAMano = cobrosManuales.has(o.folio.toUpperCase());
    for (const it of (o.items || [])) {
      const goodId = goodIdFromItem(it, goodsIndex);
      if (!goodId) continue;
      const g = goodsIndex.byId.get(goodId);
      const producto_id = g ? canonCode(g) : String(it.codigo || it.producto || goodId);
      const key = `${vendedor}|${producto_id}`;
      if (!result[key]) {
        result[key] = { vendedor, producto_id, pedidos: [] };
      }
      result[key].pedidos.push({
        folio: o.folio,
        producto_codigo: it.codigo,
        packs: it.packs || 0,
        fecha: o.fecha || null,
        cliente_nombre: o.cliente?.nombre || null,
        // Cerrado en PEDIDO y sin factura en Ventra: ni salió ni va a salir solo.
        cerrado_sin_factura: o.estado === 'completada',
        facturado,
        // `igual` o `cambiado`, para poder distinguir en pantalla el pedido que se
        // facturó tal cual del que se facturó con cambios.
        factura_estado: o.facturaEstado || null,
        factura: o.facturaNumero || null,
        // Lo que declaran los vendedores y lo que se marcó a mano aquí: se enseñan,
        // no se suman al facturado.
        cobrado_vendedor: cobradoPorVendedor,
        cobrado_manual: cobradoAMano,
        /** Mismo valor que `facturado`, por lo de siempre: hay quien lee este nombre. */
        cobrado: facturado
      });
    }
  }
  return Object.values(result);
}

app.get('/api/detalle-proceso', async (req, res) => {
  try {
    res.json({ detalle: await computeDetalleProceso() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard — resumen + ventas + asignaciones en UNA sola request
app.get('/api/dashboard', async (req, res) => {
  try {
    const [resumen, ventas, asignaciones] = await Promise.all([
      computeResumen(),
      computeVentas(),
      Promise.resolve(getAsignaciones())
    ]);
    res.json({ resumen, ventas, asignaciones });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/init-db
app.get('/api/init-db', (req, res) => {
  res.json({ success: true, message: 'OK' });
});

// POST /api/cobros — marca un pedido como cobrado manualmente
app.post('/api/cobros', async (req, res, next) => {
  try {
    const { folio } = req.body;

    if (!folio) return res.status(400).json({ success: false, error: 'folio requerido' });

    // Idempotente: marcarlo dos veces deja una sola marca. Ver `almacen.marcarCobro`.
    await marcarCobro(folio);
    res.json({ success: true });
  } catch (e) { next(e); }
});

// DELETE /api/cobros/:folio — desmarca un pedido manualmente marcado
app.delete('/api/cobros/:folio', async (req, res, next) => {
  try {
    const quitado = await desmarcarCobro(req.params.folio || '');

    if (!quitado) return res.status(404).json({ success: false, error: 'No encontrado' });

    res.json({ success: true });
  } catch (e) { next(e); }
});

/**
 * El último recurso: cualquier fallo no atrapado contesta 500 con su motivo.
 *
 * Sin esto, un error dentro de un `async` deja la petición colgada hasta que vence el
 * tiempo del navegador, y en la pantalla se ve un spinner eterno en vez de un error.
 */
app.use((err, _req, res, _next) => {
  console.error('[asignaciones]', err);
  res.status(500).json({ success: false, error: err?.message || 'error interno' });
});

/**
 * Comprobación al arrancar: que la sucursal configurada devuelva pedidos.
 *
 * PEDIDO acepta el ID de la sucursal, no su código. Si se le manda `CAM` en vez del
 * identificador **contesta 200 con cero pedidos**, sin error ninguno: las pantallas salen
 * vacías y parece que no hay ventas ese mes. Costó encontrarlo una vez; que avise solo.
 *
 * No impide arrancar —una caída de PEDIDO no puede tumbar esto— pero lo deja escrito en
 * el log, que es donde se mira cuando algo sale en blanco.
 */
async function avisarSiLaSucursalNoDevuelveNada() {
  try {
    const [desde, hasta] = rangoDelMes();
    const r = await apiGet(`/orders?page=1&limit=1&fechaDesde=${desde}&fechaHasta=${hasta}`);
    const total = r?.pagination?.total ?? (Array.isArray(r) ? r.length : 0);

    if (total > 0) {
      console.log(`[pedido] sucursal ${SUCURSAL_ID}: ${total} pedidos este mes`);
    } else {
      console.warn(
        `[pedido] AVISO: la sucursal '${SUCURSAL_ID}' no devuelve ningún pedido este mes. ` +
        `Comprueba PROCOVAR_SUCURSAL_ID: tiene que ser el ID de la sucursal, no su código ` +
        `(no vale 'CAM').`,
      );
    }
  } catch (e) {
    console.warn('[pedido] no se pudo comprobar la sucursal al arrancar:', e.message);
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  void avisarSiLaSucursalNoDevuelveNada();
});
