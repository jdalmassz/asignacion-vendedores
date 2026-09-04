<script setup>
import { ref, onMounted, computed } from 'vue'
import axios from 'axios'

const API_URL = 'http://localhost:4000/api'

// Estado de los datos
const vendedores = ref([])
const productos = ref([])
const resumen = ref([])
const ventas = ref([])
const asignaciones = ref([])
const almacen = ref([])
const loading = ref(false)
const error = ref(null)

// Vendedor seleccionado para filtrar
const vendedorSeleccionado = ref('')

// Filtro de fecha para ventas
const filtroModo = ref('mes') // 'hoy', 'mes', 'personalizado'
const seccionActiva = ref('resumen') // 'resumen', 'asignaciones'
const filtroFechaDesde = ref('')
const filtroFechaHasta = ref('')

const fechaHoy = new Date().toISOString().split('T')[0]

// Formulario de nueva asignación
const nuevaAsignacion = ref({
  vendedor: '',
  producto: '',
  cantidad: 0,
  fecha: new Date().toISOString().split('T')[0]
})
const showForm = ref(false)

// Mes actual para filtrar
const mesActual = 'Septiembre 2026'

onMounted(async () => {
  await cargarDatos()
})

async function cargarDatos() {
  loading.value = true
  error.value = null
  try {
    await axios.get(`${API_URL}/init-db`)

    const resVendedores = await axios.get(`${API_URL}/vendedores`)
    vendedores.value = resVendedores.data.vendedores

    const resProductos = await axios.get(`${API_URL}/productos`)
    productos.value = resProductos.data.productos

    await cargarVentas()
    // Seleccionar primer vendedor por defecto en ventas
    const uniqueVendedores = [...new Set(ventas.value.map(v => v.vendedor))]
    if (uniqueVendedores.length > 0) {
      vendedorSeleccionado.value = uniqueVendedores[0]
    }
    await cargarResumen()
    await cargarAsignaciones()
    await cargarAlmacen()
  } catch (e) {
    error.value = 'Error al cargar datos: ' + (e.message || e)
    console.error(e)
  } finally {
    loading.value = false
  }
}

async function cargarAsignaciones() {
  try {
    const res = await axios.get(`${API_URL}/asignaciones`)
    asignaciones.value = res.data.asignaciones
  } catch (e) {
    console.error('Error al cargar asignaciones:', e)
  }
}

async function cargarAlmacen() {
  try {
    const res = await axios.get(`${API_URL}/almacen`)
    almacen.value = res.data.productos
  } catch (e) {
    console.error('Error al cargar almacén:', e)
  }
}

async function cargarVentas() {
  try {
    const resVentas = await axios.get(`${API_URL}/ventas`)
    ventas.value = resVentas.data.ventas
  } catch (e) {
    console.error('Error al cargar ventas:', e)
  }
}

async function cargarResumen() {
  try {
    const resResumen = await axios.get(`${API_URL}/resumen`)
    resumen.value = resResumen.data.resumen
  } catch (e) {
    console.error('Error al cargar resumen:', e)
  }
}

async function crearAsignacion() {
  if (!nuevaAsignacion.value.vendedor || !nuevaAsignacion.value.producto || !nuevaAsignacion.value.cantidad) {
    alert('Por favor complete todos los campos')
    return
  }

  const producto = productos.value.find(p => p.id == nuevaAsignacion.value.producto)
  if (!producto) return

  try {
    await axios.post(`${API_URL}/asignaciones`, {
      vendedor: nuevaAsignacion.value.vendedor,
      producto_id: parseInt(nuevaAsignacion.value.producto),
      producto_nombre: producto.name,
      cantidad: parseFloat(nuevaAsignacion.value.cantidad),
      fecha: nuevaAsignacion.value.fecha
    })

    nuevaAsignacion.value = { vendedor: '', producto: '', cantidad: 0, fecha: new Date().toISOString().split('T')[0] }
    showForm.value = false

    await cargarResumen()
    await cargarAsignaciones()
  } catch (e) {
    alert('Error al crear asignación: ' + (e.response?.data?.error || e.message))
  }
}

async function eliminarAsignacion(id) {
  if (!confirm('¿Estás seguro de eliminar esta asignación?')) return

  try {
    await axios.delete(`${API_URL}/asignaciones/${id}`)
    await cargarResumen()
    await cargarAsignaciones()
  } catch (e) {
    alert('Error al eliminar asignación: ' + (e.response?.data?.error || e.message))
  }
}

// Agrupar resumen por vendedor
const resumenPorVendedor = computed(() => {
  const grouped = {}
  for (const item of resumen.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {}
      }
    }
    grouped[item.vendedor].productos[item.producto_id] = {
      producto_nombre: item.producto_nombre,
      asignado: item.asignado,
      vendido: item.vendido,
      pendiente: item.pendiente
    }
  }
  return Object.values(grouped)
})

// Agrupar ventas por vendedor
const ventasPorVendedor = computed(() => {
  const grouped = {}
  for (const item of ventas.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {}
      }
    }
    if (!grouped[item.vendedor].productos[item.producto_id]) {
      grouped[item.vendedor].productos[item.producto_id] = {
        producto_nombre: item.producto_nombre,
        medida: item.medida || 'U',
        precio: item.precio || 0,
        vendido: 0,
        total: 0
      }
    }
    grouped[item.vendedor].productos[item.producto_id].vendido += item.cantidad || item.total_vendido
    grouped[item.vendedor].productos[item.producto_id].total += item.total
  }
  return Object.values(grouped)
})

// Totales generales
const totalesGenerales = computed(() => {
  let totalAsignado = 0
  let totalVendido = 0
  for (const item of resumen.value) {
    totalAsignado += item.asignado
    totalVendido += item.vendido
  }
  return {
    asignado: totalAsignado,
    vendido: totalVendido,
    pendiente: totalAsignado - totalVendido
  }
})

// Total de ventas
const totalVentas = computed(() => {
  let total = 0
  for (const item of ventas.value) {
    total += item.total || 0
  }
  return total
})

// Ventas filtradas por vendedor seleccionado
const ventasFiltradas = computed(() => {
  if (!vendedorSeleccionado.value) {
    return ventasPorVendedorFiltrado.value
  }
  return ventasPorVendedorFiltrado.value.filter(v => v.vendedor === vendedorSeleccionado.value)
})

// Ventas filtradas por fecha
const ventasFiltradasPorFecha = computed(() => {
  if (filtroModo.value === 'hoy') {
    return ventas.value.filter(v => v.fecha === fechaHoy)
  }
  if (filtroModo.value === 'mes') {
    return ventas.value.filter(v => v.fecha && v.fecha.startsWith('2026-09'))
  }
  if (filtroModo.value === 'personalizado') {
    if (!filtroFechaDesde.value && !filtroFechaHasta.value) return ventas.value
    return ventas.value.filter(v => {
      if (!v.fecha) return false
      const f = v.fecha
      const desde = filtroFechaDesde.value
      const hasta = filtroFechaHasta.value
      if (desde && hasta) return f >= desde && f <= hasta
      if (desde) return f >= desde
      if (hasta) return f <= hasta
      return true
    })
  }
  return ventas.value
})

// Agrupar ventas por vendedor filtradas por fecha
const ventasPorVendedorFiltrado = computed(() => {
  const grouped = {}
  for (const item of ventasFiltradasPorFecha.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {}
      }
    }
    if (!grouped[item.vendedor].productos[item.producto_id]) {
      grouped[item.vendedor].productos[item.producto_id] = {
        producto_nombre: item.producto_nombre,
        medida: item.medida || 'U',
        precio: item.precio || 0,
        vendido: 0,
        total: 0
      }
    }
    grouped[item.vendedor].productos[item.producto_id].vendido += item.cantidad || item.total_vendido
    grouped[item.vendedor].productos[item.producto_id].total += item.total
  }
  return Object.values(grouped)
})

// Total de ventas filtradas
const totalVentasFiltrado = computed(() => {
  let total = 0
  for (const item of ventasFiltradasPorFecha.value) {
    total += item.total || 0
  }
  return total
})

// Total general almacén
const totalAlmacen = computed(() => {
  let total = 0
  for (const item of almacen.value) {
    total += (item.precio || 0) * (item.stock || 0)
  }
  return total
})

// Unidad del producto seleccionado en el formulario
const unidadProducto = computed(() => {
  if (!nuevaAsignacion.value.producto) return ''
  const prod = productos.value.find(p => p.id == nuevaAsignacion.value.producto)
  return prod ? prod.medida : ''
})

// Filtrar solo cerveza y malta (asignables a vendedores)
const productosFiltrados = computed(() => {
  const term = (p.nombre || '').toUpperCase()
  return productos.value.filter(p =>
    term.includes('CERVEZA') || term.includes('MALTA')
  )
})
</script>

<template>
  <div class="app">
    <!-- Header -->
    <header class="app-header">
      <div class="header-content">
        <div class="header-title">
          <span class="logo">📦</span>
          <div>
            <h1>Asignación de Productos a Vendedores</h1>
            <p class="subtitle">{{ mesActual }}</p>
          </div>
        </div>
        <div class="header-actions">
          <button @click="showForm = !showForm" class="btn btn-primary btn-lg">
            <span v-if="!showForm">➕ Nueva Asignación</span>
            <span v-else>✖ Cancelar</span>
          </button>
          <button @click="cargarDatos" class="btn btn-ghost">🔄</button>
        </div>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="loading-overlay">
      <div class="spinner"></div>
      <p>Cargando datos...</p>
    </div>

    <!-- Error -->
    <div v-if="error" class="error-banner">
      <span>⚠️ {{ error }}</span>
      <button @click="error = null">✕</button>
    </div>

    <main class="main-content">
      <!-- Formulario de nueva asignación -->
      <transition name="slide">
        <div v-if="showForm" class="form-card">
          <h2>📋 Nueva Asignación</h2>
          <form @submit.prevent="crearAsignacion">
            <div class="form-row">
              <div class="form-group">
                <label>Vendedor</label>
                <select v-model="nuevaAsignacion.vendedor" required>
                  <option value="">-- Seleccionar --</option>
                  <option v-for="v in vendedores" :key="v" :value="v">{{ v }}</option>
                </select>
              </div>
              <div class="form-group">
                <label>Producto</label>
                <select v-model="nuevaAsignacion.producto" required>
                  <option value="">-- Seleccionar --</option>
                  <option v-for="p in productosFiltrados" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </div>
              <div class="form-group">
                <label>Cantidad</label>
                <input type="number" v-model="nuevaAsignacion.cantidad" min="1" placeholder="0" required />
              </div>
              <div class="form-group">
                <label>Fecha</label>
                <input type="date" v-model="nuevaAsignacion.fecha" required />
              </div>
            </div>
            <button type="submit" class="btn btn-success btn-block">💾 Guardar Asignación</button>
          </form>
        </div>
      </transition>

      <!-- Totales Generales -->
      <div v-if="resumen.length > 0" class="stats-grid">
        <div class="stat-card stat-primary">
          <div class="stat-icon">📦</div>
          <div class="stat-info">
            <span class="stat-label">Total Asignado</span>
            <span class="stat-value">{{ totalesGenerales.asignado }}</span>
          </div>
        </div>
        <div class="stat-card stat-success">
          <div class="stat-icon">✅</div>
          <div class="stat-info">
            <span class="stat-label">Total Vendido</span>
            <span class="stat-value">{{ totalesGenerales.vendido }}</span>
          </div>
        </div>
        <div class="stat-card stat-warning">
          <div class="stat-icon">⏳</div>
          <div class="stat-info">
            <span class="stat-label">Pendiente</span>
            <span class="stat-value">{{ totalesGenerales.pendiente }}</span>
          </div>
        </div>
        <div class="stat-card stat-purple">
          <div class="stat-icon">💰</div>
          <div class="stat-info">
            <span class="stat-label">Ventas Totales</span>
            <span class="stat-value">${{ totalVentas.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- Tabs Asignaciones / Resumen -->
      <section class="card">
        <div class="seccion-tabs">
          <button
            :class="{ active: seccionActiva === 'resumen' }"
            @click="seccionActiva = 'resumen'"
          >
            📋 Resumen por Vendedor
          </button>
          <button
            :class="{ active: seccionActiva === 'asignaciones' }"
            @click="seccionActiva = 'asignaciones'"
          >
            📝 Mis Asignaciones
            <span class="tab-badge">{{ asignaciones.length }}</span>
          </button>
        </div>

        <!-- Resumen por Vendedor -->
        <div v-if="seccionActiva === 'resumen'">
          <div v-if="resumenPorVendedor.length > 0" class="vendedor-grid">
            <div v-for="item in resumenPorVendedor" :key="item.vendedor" class="vendedor-card">
              <div class="vendedor-header">
                <span class="vendedor-avatar">{{ item.vendedor.charAt(0) }}</span>
                <h3>{{ item.vendedor }}</h3>
              </div>
              <table class="mini-table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th class="text-right">Asig.</th>
                    <th class="text-right">Vendido</th>
                    <th class="text-right">Pend.</th>
                    <th class="text-center">Und.</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(prod, prodId) in item.productos" :key="prodId">
                    <td>{{ prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '') }}</td>
                    <td class="text-right">{{ prod.asignado }}</td>
                    <td class="text-right success">{{ prod.vendido }}</td>
                    <td class="text-right" :class="{ danger: prod.pendiente < 0 }">{{ prod.pendiente }}</td>
                    <td class="text-center unidad-val">{{ productos.find(p => p.id === prodId)?.medida || 'B' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-else class="empty-state">
            <p>No hay resumen de asignaciones</p>
          </div>
        </div>

        <!-- Mis Asignaciones -->
        <div v-if="seccionActiva === 'asignaciones'">
          <div v-if="asignaciones && asignaciones.length > 0" class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Vendedor</th>
                  <th>Producto</th>
                  <th class="text-right">Cantidad</th>
                  <th class="text-center">Unidad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="asig in asignaciones" :key="asig.id">
                  <td>{{ asig.fecha }}</td>
                  <td>{{ asig.vendedor }}</td>
                  <td>{{ asig.producto_nombre }}</td>
                  <td class="text-right">{{ asig.cantidad }}</td>
                  <td class="text-center unidad-val">{{ productos.find(p => p.id === asig.producto_id)?.medida || 'B' }}</td>
                  <td class="text-center">
                    <button @click="eliminarAsignacion(asig.id)" class="btn-icon btn-danger" title="Eliminar">🗑️</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="empty-state">
            <p>No hay asignaciones</p>
          </div>
        </div>
      </section>

      <!-- Stock en Almacén -->
      <section v-if="almacen.length > 0" class="card">
        <div class="card-header">
          <h2>🏭 Stock en Almacén</h2>
          <span class="badge">{{ almacen.length }} productos</span>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th class="text-right">Precio</th>
                <th class="text-right">Stock</th>
                <th class="text-center">Unidad</th>
                <th class="text-right">Valor Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in almacen" :key="item.producto_id">
                <td>{{ item.nombre }}</td>
                <td class="text-right">${{ item.precio.toFixed(2) }}</td>
                <td class="text-right stock-val">{{ item.stock }}</td>
                <td class="text-center unidad-val">{{ item.medida }}</td>
                <td class="text-right total-val">${{ (item.precio * item.stock).toFixed(2) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="text-right"><strong>Valor Total:</strong></td>
                <td class="text-right total-val"><strong>${{ totalAlmacen.toFixed(2) }}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <!-- Ventas Registradas -->
      <section v-if="ventas.length > 0" class="card">
        <div class="card-header">
          <h2>🛒 Ventas Registradas</h2>
          <span class="badge success">${{ totalVentasFiltrado.toFixed(2) }}</span>
        </div>

        <!-- Filtro de fecha -->
        <div class="filtro-fecha">
          <span class="filtro-modo">
            <button :class="{ active: filtroModo === 'hoy' }" @click="filtroModo = 'hoy'">Hoy</button>
            <button :class="{ active: filtroModo === 'mes' }" @click="filtroModo = 'mes'">Mes</button>
            <button :class="{ active: filtroModo === 'personalizado' }" @click="filtroModo = 'personalizado'">Personalizado</button>
          </span>
          <div v-if="filtroModo === 'personalizado'" class="filtro-rango">
            <span class="cal-icon">📅</span>
            <input type="date" v-model="filtroFechaDesde" class="date-input" min="2026-09-01" max="2026-09-30" />
            <span>hasta</span>
            <span class="cal-icon">📅</span>
            <input type="date" v-model="filtroFechaHasta" class="date-input" min="2026-09-01" max="2026-09-30" />
          </div>
        </div>

        <!-- Tabs de vendedores -->
        <div class="vendedor-tabs">
          <button
            v-for="v in ventasPorVendedorFiltrado"
            :key="v.vendedor"
            :class="{ active: vendedorSeleccionado === v.vendedor }"
            @click="vendedorSeleccionado = v.vendedor"
          >
            {{ v.vendedor.split(' ')[0] }} {{ v.vendedor.split(' ').slice(-1)[0] }}
          </button>
        </div>

        <!-- Ventas del vendedor seleccionado -->
        <div v-for="item in ventasFiltradas" :key="item.vendedor" class="venta-card">
          <div class="venta-header">
            <span class="vendedor-avatar">{{ item.vendedor.charAt(0) }}</span>
            <h3>{{ item.vendedor }}</h3>
            <span class="venta-total">${{ Object.values(item.productos).reduce((s, p) => s + p.total, 0).toFixed(2) }}</span>
          </div>
          <table class="mini-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th class="text-right">Precio</th>
                <th class="text-right">Cantidad</th>
                <th class="text-center">Unidad</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(prod, prodId) in item.productos" :key="prodId">
                <td>{{ prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '') }}</td>
                <td class="text-right">${{ prod.precio.toFixed(2) }}</td>
                <td class="text-right">{{ prod.vendido }}</td>
                <td class="text-center unidad-val">{{ prod.medida }}</td>
                <td class="text-right total-val">${{ prod.total.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="ventasFiltradas.length === 0" class="empty-state">
          <span class="empty-icon">📭</span>
          <p>No hay ventas para este vendedor</p>
        </div>
      </section>

      <!-- Estado vacío -->
      <div v-if="!loading && resumen.length === 0" class="empty-state-large">
        <span class="empty-icon">📦</span>
        <h3>Sin asignaciones</h3>
        <p>No hay asignaciones para este mes. Usa el botón "Nueva Asignación" para comenzar.</p>
      </div>
    </main>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --bg: #f0f2f5;
  --surface: #ffffff;
  --primary: #4f46e5;
  --primary-light: #818cf8;
  --success: #10b981;
  --success-light: #34d399;
  --warning: #f59e0b;
  --danger: #ef4444;
  --purple: #8b5cf6;
  --text: #1e293b;
  --text-light: #64748b;
  --border: #e2e8f0;
  --shadow: 0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06);
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
  --radius: 12px;
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}

.app {
  min-height: 100vh;
}

/* Header */
.app-header {
  background: linear-gradient(135deg, var(--primary) 0%, #7c3aed 100%);
  color: white;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: var(--shadow-lg);
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 16px;
}

.logo {
  font-size: 32px;
  background: rgba(255,255,255,0.2);
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}

.header-title h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}

.subtitle {
  font-size: 13px;
  opacity: 0.85;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-lg {
  padding: 12px 24px;
  font-size: 15px;
}

.btn-primary {
  background: white;
  color: var(--primary);
}

.btn-primary:hover {
  background: #f8fafc;
  transform: translateY(-1px);
}

.btn-ghost {
  background: rgba(255,255,255,0.15);
  color: white;
  padding: 10px;
}

.btn-ghost:hover {
  background: rgba(255,255,255,0.25);
}

.btn-success {
  background: var(--success);
  color: white;
}

.btn-success:hover {
  background: #059669;
}

.btn-block {
  width: 100%;
}

.btn-icon {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.2s;
}

.btn-icon:hover {
  background: var(--bg);
}

.btn-danger:hover {
  background: #fee2e2;
}

/* Main Content */
.main-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* Loading */
.loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(255,255,255,0.9);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  gap: 16px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Error */
.error-banner {
  background: var(--danger);
  color: white;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: var(--radius);
}

.error-banner button {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  font-size: 18px;
  opacity: 0.8;
}

/* Form Card */
.form-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 24px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border);
}

.form-card h2 {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-light);
}

.form-group select,
.form-group input {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
  background: var(--surface);
  color: var(--text);
}

.form-group select:focus,
.form-group input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.form-group input[type="date"] {
  color: var(--text);
}

/* Slide transition */
.slide-enter-active,
.slide-leave-active {
  transition: all 0.3s ease;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* Stats Grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.stat-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  transition: transform 0.2s, box-shadow 0.2s;
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.stat-icon {
  font-size: 28px;
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}

.stat-primary .stat-icon { background: #eef2ff; }
.stat-success .stat-icon { background: #d1fae5; }
.stat-warning .stat-icon { background: #fef3c7; }
.stat-purple .stat-icon { background: #ede9fe; }

.stat-info {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 12px;
  color: var(--text-light);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
}

.stat-primary .stat-value { color: var(--primary); }
.stat-success .stat-value { color: var(--success); }
.stat-warning .stat-value { color: var(--warning); }
.stat-purple .stat-value { color: var(--purple); }

/* Card */
.card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  overflow: hidden;
}

.card-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-header h2 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  background: var(--bg);
  color: var(--text-light);
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 20px;
}

.badge.success {
  background: #d1fae5;
  color: var(--success);
}

/* Tables */
.table-wrapper {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th,
.data-table td {
  padding: 14px 20px;
  text-align: left;
  font-size: 13px;
}

.data-table th {
  background: var(--bg);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text);
}

.data-table tbody tr {
  border-bottom: 1px solid var(--border);
}

.data-table tbody tr:last-child {
  border-bottom: none;
}

.data-table tbody tr:hover {
  background: #fafbfc;
}

.data-table tfoot {
  background: var(--bg);
  border-top: 2px solid var(--border);
}

.data-table tfoot td {
  font-size: 14px;
}

.text-right {
  text-align: right;
}

.text-center {
  text-align: center;
}

.stock-val {
  color: var(--primary);
  font-weight: 600;
}

.unidad-val {
  color: var(--text-light);
  font-weight: 600;
  font-size: 13px;
}

.total-val {
  color: var(--success);
  font-weight: 600;
}

.success {
  color: var(--success);
}

.danger {
  color: var(--danger);
  font-weight: 600;
}

/* Mini Table */
.mini-table {
  width: 100%;
  border-collapse: collapse;
}

.mini-table th,
.mini-table td {
  padding: 10px 16px;
  text-align: left;
  font-size: 13px;
}

.mini-table th {
  background: var(--bg);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text);
}

.mini-table tbody tr {
  border-bottom: 1px solid var(--border);
}

.mini-table tbody tr:last-child {
  border-bottom: none;
}

/* Vendedor Grid */
.vendedor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  padding: 20px 24px;
}

.vendedor-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.vendedor-header {
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border);
}

.vendedor-avatar {
  width: 36px;
  height: 36px;
  background: var(--primary);
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
}

.vendedor-header h3 {
  font-size: 14px;
  font-weight: 600;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Filtro Fecha */
.filtro-fecha {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.filtro-modo {
  display: flex;
  gap: 4px;
}

.filtro-modo button {
  padding: 6px 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-light);
  transition: all 0.2s;
}

.filtro-modo button:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.filtro-modo button.active {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}

.filtro-rango {
  display: flex;
  align-items: center;
  gap: 12px;
}

.filtro-rango label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.filtro-rango input[type="date"] {
  padding: 8px 12px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  cursor: pointer;
  min-width: 140px;
}

.filtro-rango input[type="date"]:hover {
  border-color: var(--primary);
}

.filtro-rango input[type="date"]:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

.cal-icon {
  font-size: 16px;
}

.date-input {
  padding: 8px 12px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  cursor: pointer;
  min-width: 140px;
}

.date-input:hover {
  border-color: var(--primary);
}

.date-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}

/* Seccion Tabs */
.seccion-tabs {
  display: flex;
  gap: 0;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
}

.seccion-tabs button {
  padding: 14px 20px;
  border: none;
  background: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-light);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s;
}

.seccion-tabs button:hover {
  color: var(--primary);
}

.seccion-tabs button.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.tab-badge {
  background: var(--primary);
  color: white;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 10px;
}

/* Vendedor Tabs */
.vendedor-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
}

.vendedor-tabs button {
  padding: 8px 16px;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  color: var(--text);
}

.vendedor-tabs button:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.vendedor-tabs button.active {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}

/* Venta Card */
.venta-card {
  border-bottom: 1px solid var(--border);
}

.venta-card:last-child {
  border-bottom: none;
}

.venta-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  background: #fafbfc;
}

.venta-header h3 {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}

.venta-total {
  background: var(--success);
  color: white;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
}

/* Empty State */
.empty-state {
  text-align: center;
  padding: 32px;
  color: var(--text-light);
}

.empty-state-large {
  text-align: center;
  padding: 64px 32px;
  background: var(--surface);
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.empty-icon {
  font-size: 48px;
  display: block;
  margin-bottom: 16px;
}

.empty-state-large h3 {
  font-size: 18px;
  margin-bottom: 8px;
  color: var(--text);
}

.empty-state-large p {
  color: var(--text-light);
}
</style>
