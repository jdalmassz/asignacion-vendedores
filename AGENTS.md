# AGENTS.md — Reglas para agentes de IA

Este archivo es para cualquier IA (opencode, Claude, Cursor, etc.) que trabaje en este repositorio.

## REGLA CRÍTICA: La fuente de información es SOLO LECTURA

Toda la información de este proyecto sale de una base de datos de producción y de archivos de datos reales. **No hay que tocar ni modificar NADA de esa fuente.**

### Fuentes de información (SOLO LECTURA)

- **Base de datos MariaDB `camaguey`** (config en `backend/.env`: `DB_HOST=192.168.1.217`)
  - Tablas: `operations`, `goods`, `partners` y demás tablas del esquema.
  - Es la base de producción del negocio.
- **Archivos de datos**:
  - `backend/asignaciones.json`
  - `backend/cobros.json`
  - `ventas_maylen_vodka.xlsx`

### Prohibido (NO hacer jamás)

- NO ejecutar `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `TRUNCATE`, ni ningún DDL/DML que escriba en la BD.
- NO borrar, renombrar, sobrescribir ni traspapelear los archivos de datos.
- NO insertar, ni modificar filas en `operations` (ahí aparecen las ventas/despachos).
- NO "corregir", "completar" ni "arreglar" datos; los datos son la verdad y NO se tocan.
- NO exportar ni copiar los datos fuera del proyecto sin pedir permiso.

### Permitido (SÍ hacer)

- Leer y consultar la BD con `SELECT` (solo lectura) para entender o validar.
- Leer los archivos de datos.
- Modificar el código de la aplicación (`backend/server.js`, `frontend/app/**`, `frontend/components/**`, `frontend/lib/**`, etc.).
- Crear scripts temporales de consulta SOLO con `SELECT`, y borrarlos después.

### Antes de actuar

Si una tarea podría implicar escribir en la BD o en los archivos de datos, **detente y pregunta primero**. Nunca asumas que está permitido.