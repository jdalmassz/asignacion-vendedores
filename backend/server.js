import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

const ASIGNACIONES_FILE = 'asignaciones.json';

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
  // Replace Ñ/ñ with N/n first
  name = name.replace(/Ñ/gi, 'N');
  name = name.replace(/ñ/gi, 'n');
  // Remove remaining accents via NFD decomposition
  name = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Fix common OCR typos / variations
  name = name.replace(/PADRAN/gi, 'PADRON');
  name = name.replace(/HECAVARRAA/gi, 'HECAVARRIA');
  // Keep only letters and spaces
  name = name.replace(/[^A-Za-z\s]/g, '').toUpperCase();
  return name.replace(/\s+/g, ' ').trim();
}

// GET /api/vendedores
app.get('/api/vendedores', async (req, res) => {
  try {
    const conn = await getConnection();
    // Fetch all Notes without DISTINCT, deduplicate in JS using normalized name
    const [rows] = await conn.query(`
      SELECT Note FROM operations
      WHERE Note LIKE '%V-%' AND Note IS NOT NULL AND Note != ''
    `);
    await conn.end();

    const seen = {};
    const unique = [];
    for (const row of rows) {
      const name = normalizeVendedorName(row.Note);
      console.error('Processing:', JSON.stringify(row.Note), '->', name, 'seen?', seen[name]);
      if (name && !seen[name]) {
        seen[name] = true;
        unique.push(name);
      }
    }
    console.error('Final unique:', unique);
    unique.sort();
    res.json({ vendedores: unique.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/productos
app.get('/api/productos', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT ID, Code, Name, Measure1, Measure2 FROM goods
      WHERE (Name LIKE '%cerveza%' OR Name LIKE '%malta%' OR Name LIKE '%CERVEZA%' OR Name LIKE '%MALTA%')
      AND Deleted = 0 ORDER BY Name
    `);
    await conn.end();

    const productos = rows.map(p => ({
      id: p.ID,
      code: p.Code,
      name: p.Name,
      medida: p.Measure1 || p.Measure2 || 'U'
    }));
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

// GET /api/ventas
app.get('/api/ventas', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT o.Note, o.GoodID, o.Date, g.Name, g.PriceOut1, g.Measure1, g.Measure2, SUM(o.Qtty) as TotalVendido
      FROM operations o
      LEFT JOIN goods g ON o.GoodID = g.ID
      WHERE o.Date >= '2026-09-01' AND o.Date < '2026-10-01'
      AND o.Sign = -1 AND Note LIKE '%V-%'
      AND (g.Name LIKE '%cerveza%' OR g.Name LIKE '%malta%' OR g.Name LIKE '%CERVEZA%' OR g.Name LIKE '%MALTA%')
      GROUP BY o.Note, o.GoodID, o.Date, g.Name, g.PriceOut1, g.Measure1, g.Measure2
    `);
    await conn.end();

    const ventas = [];
    for (const row of rows) {
      const vendedor = normalizeVendedorName(row.Note);
      if (!vendedor) continue;
      const fechaStr = row.Date instanceof Date
        ? row.Date.toISOString().split('T')[0]
        : String(row.Date).split('T')[0];
      ventas.push({
        vendedor,
        producto_id: row.GoodID,
        producto_nombre: row.Name,
        precio: row.PriceOut1 || 0,
        medida: row.Measure1 || row.Measure2 || 'U',
        cantidad: row.TotalVendido || 0,
        total: (row.PriceOut1 || 0) * (row.TotalVendido || 0),
        fecha: fechaStr
      });
    }
    res.json({ ventas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/resumen
app.get('/api/resumen', async (req, res) => {
  try {
    const asignaciones = loadAsignaciones();
    const asignSep = asignaciones.filter(a => a.fecha && a.fecha.startsWith('2026-09'));

    // Group by vendedor + producto_id (normalize vendedor name)
    const asignMap = {};
    const asignInfo = {};
    for (const a of asignSep) {
      // normalizeVendedorName expects full Note with "V-", so prepend it
      const vendedorNorm = normalizeVendedorName('V-' + a.vendedor) || a.vendedor;
      const key = `${vendedorNorm}|${a.producto_id}`;
      if (!asignMap[key]) {
        asignMap[key] = 0;
        asignInfo[key] = { ...a, vendedor: vendedorNorm };
      }
      asignMap[key] += a.cantidad;
    }

    // Get sales
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT o.Note, o.GoodID, g.Name, SUM(o.Qtty) as TotalVendido
      FROM operations o
      LEFT JOIN goods g ON o.GoodID = g.ID
      WHERE o.Date >= '2026-09-01' AND o.Date < '2026-10-01'
      AND o.Sign = -1 AND Note LIKE '%V-%'
      AND (g.Name LIKE '%cerveza%' OR g.Name LIKE '%malta%' OR g.Name LIKE '%CERVEZA%' OR g.Name LIKE '%MALTA%')
      GROUP BY o.Note, o.GoodID, g.Name
    `);
    await conn.end();

    const ventasMap = {};
    for (const row of rows) {
      const vendedor = normalizeVendedorName(row.Note);
      if (!vendedor) continue;
      const key = `${vendedor}|${row.GoodID}`;
      ventasMap[key] = (ventasMap[key] || 0) + (row.TotalVendido || 0);
    }

    // Build resumen
    const resumen = [];
    for (const key in asignMap) {
      const [vendedor, prodId] = key.split('|');
      const info = asignInfo[key];
      const vendido = ventasMap[key] || 0;
      resumen.push({
        vendedor,
        producto_id: parseInt(prodId),
        producto_nombre: info.producto_nombre,
        asignado: asignMap[key],
        vendido,
        pendiente: asignMap[key] - vendido
      });
    }
    res.json({ resumen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/almacen
app.get('/api/almacen', async (req, res) => {
  try {
    const conn = await getConnection();
    const [rows] = await conn.query(`
      SELECT s.GoodID, g.Name, g.PriceOut1, g.Measure1, g.Measure2, SUM(s.Qtty) as Stock
      FROM store s
      LEFT JOIN goods g ON s.GoodID = g.ID
      WHERE (g.Name LIKE '%cerveza%' OR g.Name LIKE '%malta%' OR g.Name LIKE '%CERVEZA%' OR g.Name LIKE '%MALTA%')
      GROUP BY s.GoodID, g.Name, g.PriceOut1, g.Measure1, g.Measure2
      HAVING Stock > 0 ORDER BY g.Name
    `);
    await conn.end();

    const productos = rows.map(r => ({
      producto_id: r.GoodID,
      nombre: r.Name,
      precio: r.PriceOut1 || 0,
      medida: r.Measure1 || r.Measure2 || 'U',
      stock: r.Stock
    }));
    res.json({ productos });
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
