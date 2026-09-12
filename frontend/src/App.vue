<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import axios from 'axios'
import AppIcon from './components/AppIcon.vue'

/**
 * Dónde está la API.
 *
 * Estaba escrita a mano como `http://localhost:4000/api`, que funciona en el portátil de
 * quien la escribió y en ningún otro sitio: puesto en el servidor, el navegador del
 * usuario intentaría hablar con SU propio ordenador.
 *
 * Por defecto `/api`, que es una ruta relativa: el mismo nginx que sirve la página la
 * reenvía al backend por la red interna. `VITE_API_URL` permite apuntar a otro sitio en
 * desarrollo — Vite la sustituye al construir, no al arrancar.
 */
const API_URL = import.meta.env.VITE_API_URL || '/api'

// Estado de los datos
const vendedores = ref([])
const resumen = ref([])
const ventas = ref([])
const asignaciones = ref([])
const almacen = ref([])
const totalesAlmacen = ref({ productos: 0, unidades: 0, valor: 0 })
const loading = ref(false)
const error = ref(null)

// Vendedor seleccionado para filtrar
const vendedorSeleccionado = ref('')

// Filtro de fecha para ventas
const filtroPreset = ref('mes') // 'hoy', 'mes', 'rango'
const seccionActiva = ref('resumen') // 'resumen', 'asignaciones'
const filtroFechaDesde = ref('')
const filtroFechaHasta = ref('')

const fechaHoy = (() => {
  const f = new Date()
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`
})()

// Formulario de nueva asignación
const nuevaAsignacion = ref({
  producto: '',
  cantidad: 0,
  fecha: new Date().toISOString().split('T')[0]
})
const vendedoresSeleccionados = ref([])
const showForm = ref(false)
const showCalendar = ref(false)
const showCalRango = ref(false)
const calObjetivo = ref('desde')
const calMonth = ref(new Date().getMonth())
const calYear = ref(new Date().getFullYear())
const rangoTmpDesde = ref('')
const rangoTmpHasta = ref('')

function toggleTodosVendedores() {
  if (vendedoresSeleccionados.value.length === vendedores.value.length) {
    vendedoresSeleccionados.value = []
  } else {
    vendedoresSeleccionados.value = [...vendedores.value]
  }
}

const calMonthName = computed(() => {
  const names = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  return names[calMonth.value]
})

const calDays = computed(() => {
  const first = new Date(calYear.value, calMonth.value, 1).getDay()
  const last = new Date(calYear.value, calMonth.value + 1, 0).getDate()
  const days = []
  for (let i = 0; i < first; i++) days.push(null)
  for (let i = 1; i <= last; i++) days.push(i)
  return days
})

function selectCalendarDay(day) {
  if (!day) return
  const m = String(calMonth.value + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  nuevaAsignacion.value.fecha = `${calYear.value}-${m}-${d}`
  showCalendar.value = false
}

function abrirCalAsignacion() {
  const f = nuevaAsignacion.value.fecha
  if (f) {
    const d = new Date(f + 'T00:00:00')
    calMonth.value = d.getMonth()
    calYear.value = d.getFullYear()
  }
  showCalendar.value = !showCalendar.value
}

function abrirCalRango() {
  if (!showCalRango.value) {
    if (filtroFechaDesde.value) {
      rangoTmpDesde.value = filtroFechaDesde.value
      const f = new Date(filtroFechaDesde.value)
      calYear.value = f.getFullYear()
      calMonth.value = f.getMonth()
      calObjetivo.value = filtroFechaHasta.value ? 'desde' : 'hasta'
    } else {
      rangoTmpDesde.value = ''
      calObjetivo.value = 'desde'
      const hoy = new Date()
      calYear.value = hoy.getFullYear()
      calMonth.value = hoy.getMonth()
    }
    rangoTmpHasta.value = filtroFechaHasta.value
    if (!rangoTmpDesde.value && !rangoTmpHasta.value) calObjetivo.value = 'desde'
  }
  showCalRango.value = !showCalRango.value
}

function seleccionarDiaRango(day) {
  if (!day) return
  const m = String(calMonth.value + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  const fecha = `${calYear.value}-${m}-${d}`
  if (calObjetivo.value === 'desde') {
    rangoTmpDesde.value = fecha
    calObjetivo.value = 'hasta'
  } else {
    let desde = rangoTmpDesde.value
    let hasta = fecha
    if (desde > fecha) {
      desde = fecha
      hasta = rangoTmpDesde.value
    }
    filtroFechaDesde.value = desde
    filtroFechaHasta.value = hasta
    showCalRango.value = false
  }
}

function esDiaEnRango(fecha) {
  if (!rangoTmpDesde.value && !rangoTmpHasta.value) return false
  if (!rangoTmpHasta.value) return fecha === rangoTmpDesde.value
  return fecha >= rangoTmpDesde.value && fecha <= rangoTmpHasta.value
}

function prevMonth() {
  if (calMonth.value === 0) { calMonth.value = 11; calYear.value-- }
  else calMonth.value--
}

function nextMonth() {
  if (calMonth.value === 11) { calMonth.value = 0; calYear.value++ }
  else calMonth.value++
}

// Mes actual para filtrar
const mesActual = 'Septiembre 2026'

onMounted(async () => {
  document.addEventListener('click', (e) => {
    if ((showCalendar.value || showCalRango.value) && !e.target.closest('.calendar-group')) {
      showCalendar.value = false
      showCalRango.value = false
    }
  })
  await cargarDatos()
  autoRefresh = setInterval(refreshLigero, 30000)
})

onUnmounted(() => {
  limpiarAutoRefresh()
})

let autoRefresh = null

let snapshotResumen = ''
let snapshotVentas = ''
let snapshotAsignaciones = ''
const hayCambios = ref(false)
const hayCambiosAsig = ref(false)

function snapshotDe(arr) {
  return JSON.stringify(arr || [])
}

function limpiarAutoRefresh() {
  if (autoRefresh) {
    clearInterval(autoRefresh)
    autoRefresh = null
  }
}

async function refreshLigero() {
  if (loading.value) return
  try {
    const r = await axios.get(`${API_URL}/dashboard`)
    const nuevoSnapResumen = snapshotDe(r.data.resumen)
    const nuevoSnapVentas = snapshotDe(r.data.ventas)
    const nuevoSnapAsignaciones = snapshotDe(r.data.asignaciones)
    if (nuevoSnapResumen !== snapshotResumen || nuevoSnapVentas !== snapshotVentas) {
      hayCambios.value = true
    }
    if (nuevoSnapAsignaciones !== snapshotAsignaciones) {
      hayCambiosAsig.value = true
    }
  } catch (e) {
    console.error('Error comprobando cambios:', e)
  }
}

async function cargarDatos() {
  loading.value = true
  error.value = null
  try {
    await axios.get(`${API_URL}/init-db`)

    const [rDashboard, resVendedores, rAlmacen] = await Promise.all([
      axios.get(`${API_URL}/dashboard`),
      axios.get(`${API_URL}/vendedores`),
      axios.get(`${API_URL}/almacen`)
    ])
    resumen.value = rDashboard.data.resumen
    ventas.value = rDashboard.data.ventas
    asignaciones.value = rDashboard.data.asignaciones
    vendedores.value = resVendedores.data.vendedores
    almacen.value = rAlmacen.data.productos || []
    totalesAlmacen.value = rAlmacen.data.totales || { productos: 0, unidades: 0, valor: 0 }

    // Seleccionar primer vendedor por defecto en ventas
    const uniqueVendedores = [...new Set(ventas.value.map(v => v.vendedor))]
    if (uniqueVendedores.length > 0) {
      vendedorSeleccionado.value = uniqueVendedores[0]
    }
    snapshotResumen = snapshotDe(resumen.value)
    snapshotVentas = snapshotDe(ventas.value)
    snapshotAsignaciones = snapshotDe(asignaciones.value)
    hayCambios.value = false
    hayCambiosAsig.value = false
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
    almacen.value = res.data.productos || []
    totalesAlmacen.value = res.data.totales || { productos: 0, unidades: 0, valor: 0 }
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
  if (vendedoresSeleccionados.value.length === 0 || !nuevaAsignacion.value.producto || !nuevaAsignacion.value.cantidad) {
    alert('Por favor seleccione al menos un vendedor, un producto y una cantidad')
    return
  }

  const producto = productosFiltrados.value.find(p => p.id == nuevaAsignacion.value.producto)
  if (!producto) return

  try {
    for (const vendedor of vendedoresSeleccionados.value) {
      await axios.post(`${API_URL}/asignaciones`, {
        vendedor,
        producto_id: nuevaAsignacion.value.producto,
        producto_nombre: producto.name,
        cantidad: parseFloat(nuevaAsignacion.value.cantidad),
        fecha: nuevaAsignacion.value.fecha
      })
    }

    vendedoresSeleccionados.value = []
    nuevaAsignacion.value = { producto: '', cantidad: 0, fecha: new Date().toISOString().split('T')[0] }
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
  const vendidoMap = {}
  for (const v of ventas.value) {
    const key = `${v.vendedor}|${v.producto_id}`
    vendidoMap[key] = (vendidoMap[key] || 0) + (v.cantidad || 0)
  }
  for (const item of resumen.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {}
      }
    }
    grouped[item.vendedor].productos[item.producto_id] = {
      producto_id: item.producto_id,
      producto_nombre: item.producto_nombre,
      asignado: item.asignado,
      en_proceso: item.en_proceso,
      cobrado: item.cobrado,
      completada: item.completada,
      pendiente: item.pendiente,
      vendido: vendidoMap[`${item.vendedor}|${item.good_id}`] || 0
    }
  }
  return Object.values(grouped)
    .sort((a, b) => a.vendedor.localeCompare(b.vendedor))
    .map(g => ({
      ...g,
      productos: Object.values(g.productos).sort((a, b) => (a.producto_nombre || '').localeCompare(b.producto_nombre || ''))
    }))
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
    const key = item.producto_nombre
    if (!grouped[item.vendedor].productos[key]) {
      grouped[item.vendedor].productos[key] = {
        producto_nombre: item.producto_nombre,
        precio: item.precio || 0,
        vendido: 0,
        total: 0
      }
    }
    grouped[item.vendedor].productos[key].vendido += item.cantidad
    grouped[item.vendedor].productos[key].total += item.total
  }
  return Object.values(grouped)
})

// Totales generales
const totalesGenerales = computed(() => {
  let totalAsignado = 0
  let totalEnProceso = 0
  let totalCobrado = 0
  let totalCompletada = 0
  let totalPendiente = 0
  for (const item of resumen.value) {
    totalAsignado += item.asignado
    totalEnProceso += item.en_proceso
    totalCobrado += item.cobrado || 0
    totalCompletada += item.completada
    totalPendiente += item.pendiente || 0
  }
  return {
    asignado: totalAsignado,
    en_proceso: totalEnProceso,
    cobrado: totalCobrado,
    completada: totalCompletada,
    pendiente: totalPendiente
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
  if (filtroPreset.value === 'hoy') {
    return ventas.value.filter(v => v.fecha === fechaHoy)
  }
  if (filtroPreset.value === 'rango') {
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
  return ventas.value.filter(v => v.fecha && v.fecha.startsWith('2026-09'))
})

// Agrupar ventas por vendedor filtradas por fecha
const ventasPorVendedorFiltrado = computed(() => {
  const grouped = {}
  for (const item of ventasFiltradasPorFecha.value) {
    if (!grouped[item.vendedor]) {
      grouped[item.vendedor] = {
        vendedor: item.vendedor,
        productos: {},
        clientes: new Set()
      }
    }
    if (item.cliente) grouped[item.vendedor].clientes.add(item.cliente)
    const key = item.producto_nombre
    if (!grouped[item.vendedor].productos[key]) {
      grouped[item.vendedor].productos[key] = {
        producto_nombre: item.producto_nombre,
        precio: item.precio || 0,
        vendido: 0,
        total: 0,
        clientes: new Set()
      }
    }
    grouped[item.vendedor].productos[key].vendido += item.cantidad
    grouped[item.vendedor].productos[key].total += item.total
    if (item.cliente) grouped[item.vendedor].productos[key].clientes.add(item.cliente)
  }
  return Object.values(grouped)
    .sort((a, b) => a.vendedor.localeCompare(b.vendedor))
    .map(g => ({
      ...g,
      clientes: g.clientes.size,
      productos: Object.values(g.productos)
        .map(p => ({ ...p, clientes: p.clientes.size }))
        .sort((a, b) => a.producto_nombre.localeCompare(b.producto_nombre))
    }))
})

// Matriz ventas "Todos": productos por fila, vendedores por columna
const matrizVentasTodos = computed(() => {
  const vendedores = ventasPorVendedorFiltrado.value
  const productosMap = {}
  const clientesGlobales = {}
  for (const item of ventasFiltradasPorFecha.value) {
    const key = item.producto_nombre
    if (!clientesGlobales[key]) clientesGlobales[key] = new Set()
    if (item.cliente) clientesGlobales[key].add(item.cliente)
  }
  for (const [key, setClientes] of Object.entries(clientesGlobales)) {
    if (!productosMap[key]) {
      productosMap[key] = {
        producto_nombre: key,
        porVendedor: {},
        cantidadTotal: 0,
        totalTotal: 0,
        clientes: setClientes.size
      }
    }
  }
  for (const v of vendedores) {
    for (const p of v.productos) {
      productosMap[p.producto_nombre].porVendedor[v.vendedor] = { vendido: p.vendido, total: p.total, clientes: p.clientes }
      productosMap[p.producto_nombre].cantidadTotal += p.vendido
      productosMap[p.producto_nombre].totalTotal += p.total
    }
  }
  return {
    vendedores: vendedores.map(v => v.vendedor),
    filas: Object.values(productosMap).sort((a, b) => a.producto_nombre.localeCompare(b.producto_nombre))
  }
})

// Total de ventas filtradas
const totalVentasFiltrado = computed(() => {
  let total = 0
  for (const item of ventasPorVendedorFiltrado.value) {
    if (vendedorSeleccionado.value && item.vendedor !== vendedorSeleccionado.value) continue
    total += Object.values(item.productos).reduce((s, p) => s + p.total, 0)
  }
  return total
})

const totalVentasUnidades = computed(() => {
  let total = 0
  for (const item of ventasPorVendedorFiltrado.value) {
    if (vendedorSeleccionado.value && item.vendedor !== vendedorSeleccionado.value) continue
    total += Object.values(item.productos).reduce((s, p) => s + p.vendido, 0)
  }
  return total
})

function totalPorVendedorEnMatriz(vendedor) {
  const v = ventasPorVendedorFiltrado.value.find(x => x.vendedor === vendedor)
  if (!v) return 0
  return Object.values(v.productos).reduce((s, p) => s + p.vendido, 0)
}

const totalClientesMatriz = computed(() => {
  const set = new Set()
  for (const item of ventasFiltradasPorFecha.value) {
    if (item.cliente) set.add(item.cliente)
  }
  return set.size
})

// Matriz de stock por producto y almacén
const matrizAlmacen = computed(() => {
  const productos = {}
  for (const alm of almacen.value) {
    for (const p of alm.productos) {
      if (!productos[p.producto_id]) {
        productos[p.producto_id] = { producto_id: p.producto_id, nombre: p.nombre, precio: p.precio, stock: 0, porAlmacen: {} }
      }
      productos[p.producto_id].porAlmacen[alm.almacen] = p.stock
      productos[p.producto_id].stock += p.stock
    }
  }
  return {
    productos: Object.values(productos).sort((a, b) => a.nombre.localeCompare(b.nombre))
  }
})

// Filtrar solo los productos disponibles en camaguey (sin contar FLORIDA, es otra sucursal)
const productosFiltrados = computed(() => {
  return matrizAlmacen.value.productos
    .map(p => ({
      id: p.producto_id,
      name: p.nombre,
      stock: Object.entries(p.porAlmacen).reduce((s, [k, v]) => k === 'FLORIDA' ? s : s + v, 0)
    }))
    .filter(p => p.stock > 0)
})

// Detalle de pedidos en proceso
const detalleProceso = ref([])
const filaExpandida = ref(null)
const loadingDetalle = ref(false)

async function toggleDetalle(vendedor, producto_id) {
  const key = `${vendedor}|${producto_id}`
  if (filaExpandida.value === key) {
    filaExpandida.value = null
    return
  }
  filaExpandida.value = key
  if (detalleProceso.value.length === 0) {
    loadingDetalle.value = true
    try {
      const res = await axios.get(`${API_URL}/detalle-proceso`)
      detalleProceso.value = res.data.detalle
    } catch (e) {
      console.error('Error cargando detalle:', e)
    } finally {
      loadingDetalle.value = false
    }
  }
}

function pedidosParaFila(vendedor, producto_id) {
  const entry = detalleProceso.value.find(d => d.vendedor === vendedor && d.producto_id === producto_id)
  return entry ? entry.pedidos : []
}

function esFilaExpandida(vendedor, producto_id) {
  return filaExpandida.value === `${vendedor}|${producto_id}`
}
</script>

<template>
  <div class="app">
    <!-- Header -->
    <header class="app-header">
      <div class="header-content">
        <div class="header-title">
          <span class="logo"><AppIcon name="box" :size="28" /></span>
          <div>
            <h1>Asignación de Productos a Vendedores</h1>
            <p class="subtitle">{{ mesActual }}</p>
          </div>
        </div>
        <div class="header-actions">
          <button @click="showForm = !showForm" class="btn btn-primary btn-lg">
            <span v-if="!showForm"><AppIcon name="plus" :size="16" /> Nueva Asignación</span>
            <span v-else><AppIcon name="x" :size="16" /> Cancelar</span>
          </button>
          <button class="btn btn-ghost ref-btn" @click="cargarDatos" :title="hayCambios ? 'Hay cambios disponibles — clic para actualizar' : 'Actualizar datos'">
            <AppIcon name="refresh" :size="16" /><span v-if="hayCambios" class="ref-badge"></span>
          </button>
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
      <span class="error-icon"><AppIcon name="alert" :size="16" /></span> {{ error }}
      <button @click="error = null"><AppIcon name="x" :size="16" /></button>
    </div>

    <main class="main-content">
      <!-- Formulario de nueva asignación -->
      <transition name="slide">
        <div v-if="showForm" class="form-card">
          <h2><AppIcon name="clipboard" :size="18" /> Nueva Asignación</h2>
          <form @submit.prevent="crearAsignacion">
            <div class="form-row">
              <div class="form-group">
                <label>Producto</label>
                <select v-model="nuevaAsignacion.producto" required>
                  <option value="">-- Seleccionar --</option>
                  <option v-for="p in productosFiltrados" :key="p.id" :value="p.id">{{ p.name }} (stock: {{ p.stock }})</option>
                </select>
              </div>
              <div class="form-group">
                <label>Cantidad</label>
                <input type="number" v-model="nuevaAsignacion.cantidad" min="1" placeholder="0" required />
              </div>
              <div class="form-group calendar-group">
                <label>Fecha</label>
                <div class="calendar-input-wrapper" @click="abrirCalAsignacion">
                  <span class="cal-display"><AppIcon name="calendar" :size="16" /> {{ nuevaAsignacion.fecha }}</span>
                </div>
                <div v-if="showCalendar" class="calendar-popup" @click.stop>
                  <div class="cal-header">
                    <button type="button" @click="prevMonth" class="cal-nav">&lt;</button>
                    <span class="cal-title">{{ calMonthName }} {{ calYear }}</span>
                    <button type="button" @click="nextMonth" class="cal-nav">&gt;</button>
                  </div>
                  <div class="cal-weekdays">
                    <span>Lu</span><span>Ma</span><span>Mi</span><span>Ju</span><span>Vi</span><span>Sa</span><span>Do</span>
                  </div>
                  <div class="cal-grid">
                    <button
                      v-for="(day, idx) in calDays"
                      :key="idx"
                      type="button"
                      class="cal-day"
                      :class="{ empty: !day, selected: day && nuevaAsignacion.fecha === `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}` }"
                      @click="selectCalendarDay(day)"
                      :disabled="!day"
                    >{{ day }}</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label>Vendedores ({{ vendedoresSeleccionados.length }}/{{ vendedores.length }})</label>
              <button type="button" class="btn btn-ghost btn-sm" @click="toggleTodosVendedores">
                {{ vendedoresSeleccionados.length === vendedores.length ? 'Desmarcar Todos' : 'Seleccionar Todos' }}
              </button>
              <div class="vendedores-checklist">
                <label v-for="v in vendedores" :key="v.id" class="vendedor-check">
                  <input type="checkbox" :value="v.nombre" v-model="vendedoresSeleccionados" />
                  <span>{{ v.nombre }}</span>
                </label>
              </div>
            </div>
            <button type="submit" class="btn btn-success btn-block" :disabled="vendedoresSeleccionados.length === 0">
              <AppIcon name="save" :size="16" /> Guardar Asignación ({{ vendedoresSeleccionados.length }} vendedor{{ vendedoresSeleccionados.length !== 1 ? 'es' : '' }})
            </button>
          </form>
        </div>
      </transition>

      <!-- Totales Generales -->
      <div v-if="resumen.length > 0" class="stats-grid">
        <div class="stat-card stat-primary">
          <div class="stat-icon"><AppIcon name="box" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">Total Asignado</span>
            <span class="stat-value">{{ totalesGenerales.asignado }}</span>
          </div>
        </div>
        <div class="stat-card stat-success">
          <div class="stat-icon"><AppIcon name="hourglass" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">En Proceso</span>
            <span class="stat-value">{{ totalesGenerales.en_proceso }}</span>
          </div>
        </div>
        <div class="stat-card stat-warning">
          <div class="stat-icon"><AppIcon name="check" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">Completado</span>
            <span class="stat-value">{{ totalesGenerales.completada }}</span>
          </div>
        </div>
        <div class="stat-card stat-purple">
          <div class="stat-icon"><AppIcon name="inbox" :size="26" /></div>
          <div class="stat-info">
            <span class="stat-label">Pendiente</span>
            <span class="stat-value">{{ totalesGenerales.pendiente }}</span>
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
            <AppIcon name="clipboard" :size="14" /> Resumen por Vendedor
          </button>
          <button
            :class="{ active: seccionActiva === 'asignaciones' }"
            @click="seccionActiva = 'asignaciones'"
          >
            <AppIcon name="edit" :size="14" /> Mis Asignaciones
            <span class="tab-badge">{{ asignaciones.length }}</span>
            <span v-if="hayCambiosAsig" class="tab-badge-dot" title="Hay cambios en las asignaciones — clic para actualizar"></span>
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
                    <th class="text-right" title="Tiene pedido pero no ha pagado">En Proc.</th>
                    <th class="text-right" title="Ya pagó, falta despacharlo">Cobr.</th>
                    <th class="text-right">Compl.</th>
                    <th class="text-right" title="Asignado menos lo vendido: esta cantidad podría no pagarse">Pend.</th>
                    <th class="text-right">Vend.</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="(prod, prodId) in item.productos" :key="prodId">
                    <tr
                      class="fila-clickeable"
                      :class="{ 'fila-expandida': esFilaExpandida(item.vendedor, prod.producto_id) }"
                      @click="toggleDetalle(item.vendedor, prod.producto_id)"
                    >
                      <td>{{ prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '') }}</td>
                      <td class="text-right">{{ prod.asignado }}</td>
                      <td class="text-right warning">{{ prod.en_proceso }}</td>
                      <td class="text-right cobrado-val">{{ prod.cobrado }}</td>
                      <td class="text-right success">{{ prod.completada }}</td>
                      <td class="text-right" :class="{ danger: prod.pendiente < 0 }">{{ prod.pendiente }}</td>
                      <td class="text-right">{{ prod.vendido }}</td>
                    </tr>
                    <tr v-if="esFilaExpandida(item.vendedor, prod.producto_id)">
                      <td colspan="7" class="detalle-container">
                        <div v-if="loadingDetalle" class="detalle-loading">Cargando...</div>
                        <div v-else-if="pedidosParaFila(item.vendedor, prod.producto_id).length === 0" class="detalle-empty">
                          No hay pedidos en proceso
                        </div>
                        <div v-else class="detalle-pedidos">
                          <div class="detalle-titulo">Pedidos en proceso ({{ pedidosParaFila(item.vendedor, prod.producto_id).length }})</div>
                          <table class="detalle-table">
                            <thead>
                              <tr>
                                <th>Folio</th>
                                <th>Fecha</th>
                                <th>Cliente</th>
                                <th class="text-right">Packs</th>
                                <th>Estado</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr v-for="(ped, idx) in pedidosParaFila(item.vendedor, prod.producto_id)" :key="idx">
                                <td class="folio">{{ ped.folio }}</td>
                                <td>{{ ped.fecha ? ped.fecha.split('T')[0] : '-' }}</td>
                                <td>{{ ped.cliente_nombre || '-' }}</td>
                                <td class="text-right packs-val">{{ ped.packs }}</td>
                                <td>
                                  <AppIcon v-if="ped.cobrado" name="check" :size="18" class="estado-ico estado-ico-cobrado" />
                                  <AppIcon v-else name="hourglass" :size="18" class="estado-ico estado-ico-proceso" />
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  </template>
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="asig in asignaciones" :key="asig.id">
                  <td>{{ asig.fecha }}</td>
                  <td>{{ asig.vendedor }}</td>
                  <td>{{ asig.producto_nombre }}</td>
                  <td class="text-right">{{ asig.cantidad }}</td>
                  <td class="text-center">
                    <button @click="eliminarAsignacion(asig.id)" class="btn-icon btn-danger" title="Eliminar"><AppIcon name="trash" :size="16" /></button>
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
          <h2><AppIcon name="warehouse" :size="18" /> Stock en Almacén</h2>
          <span class="badge">{{ totalesAlmacen.productos }} productos</span>
        </div>
        <div class="table-wrapper table-almacen">
          <table class="data-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th class="text-right">Precio</th>
                <th v-for="a in almacen" :key="a.almacen" class="text-right">{{ a.almacen }}</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in matrizAlmacen.productos" :key="item.producto_id">
                <td>{{ item.nombre }}</td>
                <td class="text-right">${{ item.precio.toFixed(2) }}</td>
                <td v-for="a in almacen" :key="a.almacen" class="text-right stock-val">{{ item.porAlmacen[a.almacen] || 0 }}</td>
                <td class="text-right stock-val">{{ item.stock }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Ventas Registradas -->
      <section v-if="ventas.length > 0" class="card">
        <div class="card-header">
          <h2><AppIcon name="cart" :size="18" /> Ventas Registradas</h2>
          <span class="badge success">${{ totalVentasFiltrado.toFixed(2) }}</span>
        </div>

        <!-- Filtro de fecha -->
        <div class="filtro-fecha">
          <span class="filtro-modo">
            <button :class="{ active: filtroPreset === 'hoy' }" @click="filtroPreset = 'hoy'">Hoy</button>
            <button :class="{ active: filtroPreset === 'mes' }" @click="filtroPreset = 'mes'">Mes</button>
            <button :class="{ active: filtroPreset === 'rango' }" @click="filtroPreset = 'rango'">Rango</button>
          </span>
          <div v-if="filtroPreset === 'rango'" class="filtro-rango">
            <div class="calendar-group">
              <div class="calendar-input-wrapper" @click="abrirCalRango">
                <span class="cal-display"><AppIcon name="calendar" :size="16" /> {{ filtroFechaDesde ? `${filtroFechaDesde} → ${filtroFechaHasta || filtroFechaDesde}` : 'Elegir fechas' }}</span>
              </div>
              <div v-if="showCalRango" class="calendar-popup" @click.stop>
                <div class="cal-header">
                  <button type="button" @click="prevMonth" class="cal-nav">&lt;</button>
                  <span class="cal-title">{{ calMonthName }} {{ calYear }}</span>
                  <button type="button" @click="nextMonth" class="cal-nav">&gt;</button>
                </div>
                <p class="cal-hint">{{ calObjetivo === 'desde' ? 'Elige el día inicial' : 'Elige el día final' }}</p>
                <div class="cal-weekdays">
                  <span>Lu</span><span>Ma</span><span>Mi</span><span>Ju</span><span>Vi</span><span>Sa</span><span>Do</span>
                </div>
                <div class="cal-grid">
                  <button
                    v-for="(day, idx) in calDays"
                    :key="idx"
                    type="button"
                    class="cal-day"
                    :class="{ empty: !day, selected: day && esDiaEnRango(`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`) }"
                    @click="seleccionarDiaRango(day)"
                    :disabled="!day"
                  >{{ day }}</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tabs de vendedores -->
        <div class="vendedor-tabs">
          <button
            :class="{ active: !vendedorSeleccionado }"
            @click="vendedorSeleccionado = ''"
          >
            🧑‍🤝‍🧑 Todos
          </button>
          <button
            v-for="v in ventasPorVendedorFiltrado"
            :key="v.vendedor"
            :class="{ active: vendedorSeleccionado === v.vendedor }"
            @click="vendedorSeleccionado = v.vendedor"
          >
            {{ v.vendedor.split(' ')[0] }} {{ v.vendedor.split(' ').slice(-1)[0] }}
          </button>
        </div>

        <!-- Matriz cuando está "Todos" -->
        <div v-if="!vendedorSeleccionado" class="matriz-ventas">
          <table class="mini-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th v-for="v in matrizVentasTodos.vendedores" :key="v" class="text-right">{{ v.split(' ')[0] }} {{ v.split(' ').slice(-1)[0] }}</th>
                <th class="text-right">Total</th>
                <th class="text-right">Clientes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="prod in matrizVentasTodos.filas" :key="prod.producto_nombre">
                <td>{{ prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '') }}</td>
                <td v-for="v in matrizVentasTodos.vendedores" :key="v" class="text-right">
                  {{ prod.porVendedor[v] ? prod.porVendedor[v].vendido : 0 }}
                  <span v-if="prod.porVendedor[v] && prod.porVendedor[v].clientes" class="clientes-mini"><AppIcon name="users" :size="12" /> {{ prod.porVendedor[v].clientes }}</span>
                </td>
                <td class="text-right total-val">{{ prod.cantidadTotal }}</td>
                <td class="text-right clientes-total"><AppIcon name="users" :size="13" /> {{ prod.clientes }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td v-for="v in matrizVentasTodos.vendedores" :key="v" class="text-right">
                  <strong>{{ totalPorVendedorEnMatriz(v) }}</strong>
                </td>
                <td class="text-right total-val"><strong>{{ totalVentasUnidades }}</strong></td>
                <td class="text-right clientes-total"><strong><AppIcon name="users" :size="13" /> {{ totalClientesMatriz }}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Ventas del vendedor seleccionado -->
        <div v-if="vendedorSeleccionado">
          <div v-for="item in ventasFiltradas" :key="item.vendedor" class="venta-card">
          <div class="venta-header">
            <span class="vendedor-avatar">{{ item.vendedor.charAt(0) }}</span>
            <h3>{{ item.vendedor }}</h3>
            <span class="venta-clientes"><AppIcon name="users" :size="14" /> {{ item.clientes }} {{ item.clientes === 1 ? 'cliente' : 'clientes' }}</span>
            <span class="venta-total">${{ Object.values(item.productos).reduce((s, p) => s + p.total, 0).toFixed(2) }}</span>
          </div>
          <table class="mini-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th class="text-right">Precio</th>
                <th class="text-right">Cantidad</th>
                <th class="text-right">Clientes</th>
                <th class="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(prod, prodId) in item.productos" :key="prodId">
                <td>{{ prod.producto_nombre.replace('CERVEZA ', '').replace('MALTA ', '') }}</td>
                <td class="text-right">${{ prod.precio.toFixed(2) }}</td>
                <td class="text-right">{{ prod.vendido }}</td>
                <td class="text-right"><AppIcon name="users" :size="13" /> {{ prod.clientes }}</td>
                <td class="text-right total-val">${{ prod.total.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        <div v-if="vendedorSeleccionado && ventasFiltradas.length === 0" class="empty-state">
          <span class="empty-icon"><AppIcon name="inbox" :size="40" /></span>
          <p>No hay ventas para este vendedor</p>
        </div>
      </section>

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

.ref-btn {
  position: relative;
}

.ref-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 12px;
  height: 12px;
  background: var(--danger);
  border: 2px solid #fff;
  border-radius: 50%;
  animation: refPulse 1.2s ease-in-out infinite;
}

@keyframes refPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.7; }
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

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
  margin-bottom: 8px;
}

.vendedores-checklist {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  margin-top: 4px;
}

.vendedor-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}

.vendedor-check:hover {
  background: var(--bg);
}

.vendedor-check input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
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
  gap: 8px;
  border-radius: var(--radius);
}

.error-banner .error-icon,
.error-banner svg {
  flex-shrink: 0;
  display: flex;
  align-items: center;
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

.table-almacen {
  max-height: 480px;
  overflow: auto;
}

.table-almacen thead th {
  position: sticky;
  top: 0;
  z-index: 3;
  background: #eef2f6;
  box-shadow: 0 1px 0 var(--border, #d1d5db);
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

.warning {
  color: var(--warning);
}

.cobrado-val {
  color: #0891b2;
  font-weight: 600;
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

/* Matriz de ventas "Todos" */
.matriz-ventas {
  overflow: auto;
  max-height: 480px;
  border-top: 1px solid var(--border);
}

.matriz-ventas table {
  min-width: 900px;
}

.matriz-ventas th:first-child,
.matriz-ventas td:first-child {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--bg);
  font-weight: 600;
  min-width: 130px;
}

.matriz-ventas thead th {
  position: sticky;
  top: 0;
  z-index: 3;
  background: #eef2f6;
  box-shadow: 0 1px 0 var(--border);
}

.matriz-ventas thead th:first-child {
  z-index: 4;
}

/* Vendedor Grid */
.vendedor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  padding: 20px 24px;
  align-items: start;
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

.filtro-rango .calendar-input-wrapper {
  padding: 8px 12px;
  font-size: 13px;
  min-width: 140px;
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

.date-field {
  width: 100%;
  min-width: 180px;
  cursor: pointer;
}

.date-field::-webkit-calendar-picker-indicator {
  cursor: pointer;
  opacity: 0.6;
  font-size: 18px;
}

.date-field::-webkit-calendar-picker-indicator:hover {
  opacity: 1;
}

.calendar-group {
  position: relative;
}

.calendar-input-wrapper {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.calendar-input-wrapper:hover {
  border-color: var(--primary);
}

.cal-display {
  user-select: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.calendar-popup {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 200;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 12px;
  width: 280px;
  margin-top: 4px;
}

.cal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.cal-nav {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  width: 32px;
  height: 32px;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  transition: background 0.15s;
}

.cal-nav:hover {
  background: var(--bg);
}

.cal-title {
  font-weight: 700;
  font-size: 14px;
  color: var(--text);
}

.cal-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  margin-bottom: 4px;
}

.cal-weekdays span {
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-light);
  padding: 4px 0;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.cal-day {
  border: none;
  background: none;
  padding: 8px 0;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
  transition: background 0.15s;
  text-align: center;
}

.cal-day:hover:not(.empty):not(:disabled) {
  background: var(--bg);
}

.cal-day.selected {
  background: var(--primary);
  color: white;
  font-weight: 700;
}

.cal-day.empty {
  cursor: default;
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
  margin-left: 6px;
  font-weight: 600;
}

.tab-badge-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  margin-left: 6px;
  vertical-align: middle;
  animation: pulse-dot 1.5s infinite ease-in-out;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
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

.venta-clientes {
  background: #eef2ff;
  color: var(--primary);
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 600;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.clientes-mini {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--primary);
  font-weight: 600;
}

.clientes-total {
  color: var(--primary);
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

/* Detalle de pedidos en proceso */
.fila-clickeable {
  cursor: pointer;
  transition: background 0.15s;
}

.fila-clickeable:hover {
  background: #f0f4ff;
}

.fila-clickeable.fila-expandida {
  background: #eef2ff;
}

.detalle-container {
  padding: 0 !important;
  background: #f8fafc;
  border-top: 1px dashed var(--border) !important;
}

.detalle-loading,
.detalle-empty {
  padding: 12px 20px;
  font-size: 12px;
  color: var(--text-light);
  font-style: italic;
}

.detalle-pedidos {
  padding: 8px 0;
  max-height: 220px;
  overflow-y: auto;
}

.detalle-titulo {
  padding: 4px 20px 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--primary);
}

.detalle-table {
  width: 100%;
  border-collapse: collapse;
  margin: 0;
}

.detalle-table th {
  padding: 6px 20px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-light);
  background: transparent;
  border-bottom: 1px solid var(--border);
}

.detalle-table td {
  padding: 6px 20px;
  font-size: 12px;
  border-bottom: 1px solid #f1f5f9;
}

.detalle-table tbody tr:hover {
  background: #eef2ff;
}

.detalle-table .folio {
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--primary);
}

.detalle-table .packs-val {
  font-weight: 700;
  color: var(--warning);
}

.estado-ico {
  display: inline-flex;
  vertical-align: middle;
}

.estado-ico-cobrado {
  color: #0891b2;
}

.estado-ico-proceso {
  color: #d97706;
}
</style>
