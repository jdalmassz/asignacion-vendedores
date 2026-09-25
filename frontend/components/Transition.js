'use client'

import { cloneElement, useEffect, useRef, useState } from 'react'

/**
 * Las transiciones de Vue, con sus mismas clases.
 *
 * `<Transition name="x">` de Vue pone sobre el elemento hijo `x-enter-from`,
 * `x-enter-active`, `x-enter-to` —y al salir `x-leave-*`— y lo desmonta cuando la
 * animación termina. React no sabe hacer eso, y las clases están escritas en el CSS
 * tal cual: aquí se aplican al hijo con `cloneElement`, sin meter ningún `div` en
 * medio (un envoltorio cambiaría la rejilla de `.seccion-contenido` y el `.hoja` de
 * los cajones).
 *
 * Los tiempos van aquí porque el CSS no los deja leer: son los mismos que los de las
 * reglas `*-enter-active` / `*-leave-active`.
 */
const TIEMPOS = {
  ventana: { entra: 200, sale: 160 },
  seccion: { entra: 200, sale: 0 },
  cambio: { entra: 180, sale: 180 },
}

const duracion = (name, tipo) => (TIEMPOS[name] || { entra: 200, sale: 200 })[tipo]

/** A la siguiente pintura, para que el navegador vea el estado de INICIO. */
function alPintar(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn))
}

/**
 * @param {string} name   nombre de la transición, como en Vue
 * @param {string} [mode] `out-in` sale primero y entra después; por defecto, a la vez
 * @param {*} nodeKey     clave del contenido: `null` = no hay nada que enseñar
 */
export default function Transition({ name, mode, nodeKey, children }) {
  const [estado, setEstado] = useState(() => ({ key: nodeKey ?? null, clases: '' }))
  const refNodo = useRef(children)
  const temporizadores = useRef([])
  const primera = useRef(true)

  const limpiar = () => {
    temporizadores.current.forEach(clearTimeout)
    temporizadores.current = []
  }
  const despues = (ms, fn) => {
    temporizadores.current.push(setTimeout(fn, ms))
  }

  // El último nodo montado, para poder enseñarlo mientras sale.
  useEffect(() => {
    if (estado.key === nodeKey) refNodo.current = children
  })

  useEffect(() => {
    // La primera pasada es el render inicial: en Vue las transiciones tampoco
    // aparecen hasta que alguien cambia algo.
    if (primera.current) {
      primera.current = false
      return undefined
    }

    limpiar()

    const montado = estado.key

    const salir = () => {
      setEstado((s) => ({ ...s, clases: `${name}-leave-from ${name}-leave-active` }))
      alPintar(() => setEstado((s) => ({ ...s, clases: `${name}-leave-active ${name}-leave-to` })))
      return duracion(name, 'sale')
    }

    const entrar = (clave, nodo) => {
      refNodo.current = nodo
      setEstado({ key: clave, clases: `${name}-enter-from ${name}-enter-active` })
      alPintar(() => setEstado((s) => ({ ...s, clases: `${name}-enter-active ${name}-enter-to` })))
      despues(duracion(name, 'entra'), () => setEstado((s) => ({ ...s, clases: '' })))
    }

    // Se va lo que había.
    if (nodeKey === null || nodeKey === undefined) {
      if (montado === null) return undefined
      const ms = salir()
      despues(ms, () => setEstado((s) => ({ ...s, key: null, clases: '' })))
      return undefined
    }

    // No hay nada montado: entra.
    if (montado === null) {
      entrar(nodeKey, children)
      return undefined
    }

    // Es el mismo contenido con otro datos: se pinta sin animar, que es lo que
    // hace Vue cuando la clave no cambia.
    if (nodeKey === montado) return undefined

    if (mode === 'out-in') {
      const ms = salir()
      despues(ms, () => entrar(nodeKey, children))
      return undefined
    }

    // A la vez: lo viejo se va y lo nuevo entra en el mismo fotograma.
    entrar(nodeKey, children)
    return undefined
    // `estado.key` no va en las dependencias a propósito: sólo interesa quién pidió
    // el cambio, que es la clave.
  }, [nodeKey])

  useEffect(() => limpiar, [])

  if (estado.key === null) return null

  const nodo = estado.key === nodeKey ? children : refNodo.current
  if (!nodo) return null

  if (!estado.clases) return nodo

  const propia = nodo.props?.className
  return cloneElement(nodo, { className: propia ? `${propia} ${estado.clases}` : estado.clases })
}
