import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const ASIGNACIONES_FILE = 'asignaciones.json';

// Procovar API config
const API_BASE = 'https://pedidos.procovar.cloud/api';
const API_KEY = 'PROCOVAR_API_KEY_ENV';
const SUCURSAL_ID = 'PROCOVAR_SUCURSAL_ID_ENV';

// MySQL config (productos y almacen)
const dbConfig = {
  host: 'DB_HOST_ENV',
  user: 'root',
  password: 'root',
  database: 'camaguey',
  charset: 'utf8mb4'
};

function getConnection() {
  return mysql.createConnection(dbConfig);
}

function loadAsignaciones() {
  if (fs.existsSync(ASIGNACIONES_FILE)) {
    const data = fs.readFileSync(ASIGNACIONES_FILE, 'utf-8');
    return JSON.parse(data);
  }
  return [];
}

function saveAsignaciones(data) {
  fs.writeFileSync(ASIGNACIONES_FILE, JSON.stringify(data, null, 2), 'utf-8');
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

async function loadGoods() {
  const conn = await getConnection();
  const [rows] = await conn.query(`SELECT ID, Code, Name FROM goods WHERE Deleted = 0`);
  await conn.end();
  return rows;
}

function findGoodIDForAsign(a, goods) {
  const pid = String(a.producto_id || '').trim();
  const byCode = goods.find(g => String(g.Code || '').trim() === pid);
  if (byCode) return byCode.ID;

  const aTokens = normProdTokens(a.producto_nombre + ' ' + a.producto_id);
  let best = null, bestScore = 0;
  for (const g of goods) {
    const gTokens = new Set(normProdTokens(g.Name));
    let score = 0;
    for (const t of aTokens) if (gTokens.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = g.ID; }
  }
  return bestScore >= 2 ? best : null;
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
  const allOrders = [];
  let page = 1;
  const limit = 1000;
  let totalPages = 1;

  while (page <= totalPages) {
    let path = `/orders?page=${page}&limit=${limit}`;
    if (desde) path += `&desde=${desde}`;
    if (hasta) path += `&hasta=${hasta}`;

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
    const orders = await fetchAllOrders('2026-09-01', '2026-09-30');
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

// GET /api/asignaciones
app.get('/api/asignaciones', (req, res) => {
  const asignaciones = loadAsignaciones();
  const filtered = asignaciones.filter(a => a.fecha && a.fecha.startsWith('2026-09'));
  filtered.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  res.json({ asignaciones: filtered });
});

// POST /api/asignaciones
app.post('/api/asignaciones', (req, res) => {
  const { vendedor, producto_id, producto_nombre, cantidad, fecha } = req.body;
  const asignaciones = loadAsignaciones();
  const nueva = {
    id: asignaciones.length + 1,
    vendedor,
    producto_id,
    producto_nombre,
    cantidad,
    fecha: fecha || new Date().toISOString().split('T')[0]
  };
  asignaciones.push(nueva);
  saveAsignaciones(asignaciones);
  res.json({ success: true, id: nueva.id });
});

// DELETE /api/asignaciones/:id
app.delete('/api/asignaciones/:id', (req, res) => {
  const id = parseInt(req.params.id);
  let asignaciones = loadAsignaciones();
  const originalLen = asignaciones.length;
  asignaciones = asignaciones.filter(a => a.id !== id);
  if (asignaciones.length === originalLen) {
    return res.status(404).json({ success: false, error: 'Asignación no encontrada' });
  }
  saveAsignaciones(asignaciones);
  res.json({ success: true });
});

// GET /api/ventas — desde MariaDB (operaciones despachadas Sign=-1)
app.get('/api/ventas', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT o.Note, o.GoodID, o.Date, o.PartnerID, g.Name, g.PriceOut1, g.Measure1, g.Measure2, SUM(o.Qtty) as TotalVendido
      FROM operations o
      LEFT JOIN goods g ON o.GoodID = g.ID
      WHERE o.Date >= '2026-09-01' AND o.Date < '2026-10-01'
      AND o.Sign = -1 AND Note LIKE '%V-%'
      GROUP BY o.Note, o.GoodID, o.Date, o.PartnerID, g.Name, g.PriceOut1, g.Measure1, g.Measure2
    `);
    await conn.end();

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
    res.json({ ventas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resumen — asignaciones vs despachos reales (MariaDB) + pedidos en proceso (API)
app.get('/api/resumen', async (req, res) => {
  try {
    const asignaciones = loadAsignaciones();
    const asignSep = asignaciones.filter(a => a.fecha && a.fecha.startsWith('2026-09'));

    // Group assignments by vendedor + producto (mapear a GoodID real)
    const goods = await loadGoods();
    const asignMap = {};
    const asignInfo = {};
    for (const a of asignSep) {
      const vendedorNorm = normalizeVendedorName('V-' + a.vendedor) || a.vendedor;
      const goodId = findGoodIDForAsign(a, goods);
      if (!goodId) continue;
      const key = `${vendedorNorm}|${a.producto_id}`;
      if (!asignMap[key]) {
        asignMap[key] = 0;
        asignInfo[key] = { ...a, vendedor: vendedorNorm, goodId };
      }
      asignMap[key] += a.cantidad;
    }

    // Despachos REALES desde MariaDB (Sign=-1) en el mes, por vendedor + GoodID
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT o.Note, o.GoodID, o.Qtty
      FROM operations o
      WHERE o.Date >= '2026-09-01' AND o.Date < '2026-10-01'
      AND o.Sign = -1 AND Note LIKE '%V-%'
    `);
    await conn.end();

    const despachosMap = {};   // vendedor|GoodID -> packs despachados
    const foliosDespachados = new Set();
    for (const row of rows) {
      const vendedor = normalizeVendedorName(row.Note);
      if (!vendedor) continue;
      const m = row.Note.match(/(?:^|;)P-([A-Z0-9\-]+);/i);
      if (m) foliosDespachados.add(m[1].toUpperCase());
      despachosMap[`${vendedor}|${row.GoodID}`] = (despachosMap[`${vendedor}|${row.GoodID}`] || 0) + (row.Qtty || 0);
    }

    // Pedidos del API: solo en_proceso que aún NO se despacharon (evitar doble conteo)
    const orders = await fetchAllOrders('2026-09-01', '2026-09-30');
    const procesoMap = {};
    for (const o of orders) {
      if (o.estado !== 'en_proceso') continue;
      if (!o.folio) continue;
      if (foliosDespachados.has(o.folio.toUpperCase())) continue;
      const vendedor = normalizeVendedorName('V-' + (o.vendedor?.nombre || ''));
      if (!vendedor) continue;
      for (const it of (o.items || [])) {
        const key = `${vendedor}|${it.codigo}`;
        if (!asignInfo[key]) continue;
        procesoMap[key] = (procesoMap[key] || 0) + (it.packs || 0);
      }
    }

    // Build resumen: completada = despachos reales (topeado al asignado), en_proceso del API
    const resumen = [];
    for (const key in asignMap) {
      const info = asignInfo[key];
      const completada = Math.min(despachosMap[`${info.vendedor}|${info.goodId}`] || 0, asignMap[key]);
      const enProceso = procesoMap[key] || 0;
      resumen.push({
        vendedor: info.vendedor,
        producto_id: info.producto_id,
        good_id: info.goodId,
        producto_nombre: info.producto_nombre,
        asignado: asignMap[key],
        en_proceso: enProceso,
        completada,
        pendiente: Math.max(0, asignMap[key] - completada)
      });
    }
    res.json({ resumen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/almacen — desde MariaDB (store, inventario real)
app.get('/api/almacen', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT o.ID AS object_id, o.Name AS almacen, g.ID, g.Code, g.Name, g.PriceOut1, SUM(s.Qtty) AS stock
      FROM store s
      LEFT JOIN goods g ON s.GoodID = g.ID
      LEFT JOIN objects o ON s.ObjectID = o.ID
      WHERE s.Qtty > 0
        AND g.Name <> 'ENTREGA A DOMICILIO'
      GROUP BY o.ID, o.Name, g.ID, g.Code, g.Name, g.PriceOut1
      HAVING stock > 0
    `);
    await conn.end();
    const almacenes = {};
    for (const r of rows) {
      if (!r.Name || !r.ID) continue;
      const nombre = r.almacen || ('Almacen ' + r.object_id);
      if (!almacenes[nombre]) almacenes[nombre] = { almacen: nombre, productos: [] };
      almacenes[nombre].productos.push({
        producto_id: r.Code || r.ID,
        nombre: r.Name,
        precio: r.PriceOut1 || 0,
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
    res.json({ productos: lista, totales });
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
app.get('/api/detalle-proceso', async (req, res) => {
  try {
    const orders = await fetchAllOrders('2026-09-01', '2026-09-30');

    // Despachos reales para saber qué folios ya se despacharon
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT o.Note FROM operations o
      WHERE o.Date >= '2026-09-01' AND o.Date < '2026-10-01'
      AND o.Sign = -1 AND Note LIKE '%V-%'
    `);
    await conn.end();
    const foliosDespachados = new Set();
    for (const row of rows) {
      const m = row.Note.match(/(?:^|;)P-([A-Z0-9\-]+);/i);
      if (m) foliosDespachados.add(m[1].toUpperCase());
    }

    const result = {};
    for (const o of orders) {
      if (o.estado !== 'en_proceso') continue;
      if (!o.folio) continue;
      if (foliosDespachados.has(o.folio.toUpperCase())) continue;
      const vendedor = normalizeVendedorName('V-' + (o.vendedor?.nombre || ''));
      if (!vendedor) continue;
      for (const it of (o.items || [])) {
        const key = `${vendedor}|${it.codigo}`;
        if (!result[key]) {
          result[key] = { vendedor, producto_id: it.codigo, pedidos: [] };
        }
        result[key].pedidos.push({
          folio: o.folio,
          producto_codigo: it.codigo,
          packs: it.packs || 0,
          fecha: o.fecha || null,
          cliente_nombre: o.cliente?.nombre || null
        });
      }
    }
    res.json({ detalle: Object.values(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/init-db
app.get('/api/init-db', (req, res) => {
  res.json({ success: true, message: 'OK' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
