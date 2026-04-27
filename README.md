# Handoff: Rediseño pantalla de Inicio · discriminador

## Overview
Rediseño de la pantalla de **Inicio** de discriminador (sistema de spaced repetition / flashcards).
El diseño consolida 6 secciones que estaban solapadas en la versión actual en 3 zonas claras:
**(1)** Headline + tabs · **(2)** Próximos exámenes · **(3)** Materias (navegación principal) ·
**(4)** Agenda colapsada.

Se eliminaron de Inicio las secciones "Meta diaria" y "Para hoy" — el usuario las quitó porque
no eran relevantes para su flujo principal de Inicio.

## About the Design Files
Los archivos de este bundle son **referencias de diseño creadas en HTML/JSX** — prototipos que
muestran el look & feel y comportamiento deseado, **no código de producción para copiar directo**.
La tarea es **recrear estos diseños en el codebase actual de discriminador** usando sus patrones,
librerías y stack establecidos. Si no hay un stack establecido, elegir el más apropiado e implementar.

## Fidelity
**High-fidelity (hifi).** Mockup pixel-perfect con colores, tipografía, espaciado e interacciones
finales. El desarrollador debe recrear la UI fielmente usando las librerías y patrones existentes
del codebase. Datos reales del usuario (AM3, ERP, historia arte, laboratorio 4, etc.) — el dev
debe reemplazarlos por datos dinámicos del backend.

---

## Screens / Views

### Pantalla: Inicio
**Purpose:** Pantalla por defecto al abrir la app. Permite al usuario ver de un vistazo qué
materias tiene pendientes, qué exámenes vienen y lanzar a estudiar cualquier materia.

**Layout (top → bottom):**
1. **Header global** (padding `28px 56px 0`)
   - Logo "discriminador.com" (izq) + 4 dots placeholder (der)
   - Tabs: Inicio · Estudiar · Tarjetas · Planificar · Progreso · Configuración · Documentos · ↻
   - Botón "Salir" a la derecha de los tabs
2. **Headline** (padding `40px 56px 24px`)
   - "46 pendientes hoy (46 tarjetas principales + 0 microconsignas)."
3. **Card: Próximos exámenes** (margin `0 56px 24px`, lista de 5 más próximos)
4. **Card: Materias** (margin `0 56px 16px`, tabla densa con todas las materias)
5. **Card: Agenda** (margin `0 56px 56px`, **colapsada por defecto**)

Total ancho de contenido: viewport con padding lateral `56px`. Diseñado para ~1180px de ancho.

---

## Components

### 1. Header Global
- **Container:** `padding: 28px 56px 0; background: #ffffff;`
- **Brand row:**
  - Texto: "discriminador" en `#1a1a1a` + ".com" en `#a8a39a`
  - Font: JetBrains Mono, 22px, weight 500, letter-spacing -0.01em
  - 4 dots `6×6px circle, background #a8a39a, gap 4px` a la derecha
  - `margin-bottom: 28px`
- **Tabs row:** `border-bottom: 1px solid #e8e4da; display: flex; justify-content: space-between`
  - Cada tab: `padding 14px 18px`, font JetBrains Mono 14px
  - Tab activo (Inicio): color `#1a1a1a`, weight 500, `border-bottom: 2px solid #1a1a1a; margin-bottom: -1px`
  - Tab inactivo: color `#777`, weight 400, sin borde
  - Ítem `↻` después de los tabs en color `#a8a39a`
  - Botón "Salir": `padding 8px 22px, border 1px solid #e8e4da, border-radius 6px, color #3d3d3d, transparent bg, margin-bottom 8px`

### 2. Headline
- Container: `padding: 40px 56px 24px`
- `<h1>` JetBrains Mono, 28px, weight 400, line-height 1.4, letter-spacing -0.01em
- "46 pendientes hoy" en `#1a1a1a`
- "(46 tarjetas principales + 0 microconsignas)." en `#777`

### 3. Card: Próximos exámenes
- Container: `border 1px solid #e8e4da; border-radius 10px; overflow hidden; background #fff`
- **Header:**
  - `padding 14px 18px; border-bottom 1px solid #e8e4da; display flex justify-between align-center`
  - Izq: "Próximos exámenes" (color `#3d3d3d`, weight 500) · "siguiente en 38 días" (color `#777`, weight 400)
  - Der: "ver todos →" (color `#777`, fontSize 12)
- **Filas (5 filas):**
  - Grid: `grid-template-columns: 70px 1fr 110px 200px; gap 18px; padding 12px 18px; align items center`
  - Border-top entre filas: `1px solid #f0ede5`
  - Col 1 — días (e.g. "38d"): JetBrains Mono 13px weight 600, color `#3d3d3d`, tabular-nums
  - Col 2 — nombre (e.g. "AM3 · 2do parcial"): color `#3d3d3d`
  - Col 3 — fecha (e.g. "jue 4 jun"): color `#777`, fontSize 12
  - Col 4 — barra readiness:
    - Track: `height 4px; background #f0ede5; border-radius 2px`
    - Fill: width = readiness%, color según valor:
      - `>= 0.4` → green `#4a8a3f`
      - `>= 0.2` → amber `#c98428`
      - `< 0.2` → red `#b3402a`
    - Etiqueta a la der: "{n}%" color `#777`, 11px, tabular-nums, min-width 32px
- **Datos a mostrar:**
  | días | nombre | fecha | readiness |
  |---|---|---|---|
  | 38 | AM3 · 2do parcial | jue 4 jun | 0.42 |
  | 44 | ERP · 2do parcial | mié 10 jun | 0.31 |
  | 45 | AMJ · recuperatorio dentro | jue 11 jun | 0.50 |
  | 58 | AMJ · recuperatorio fuera | mié 24 jun | 0.50 |
  | 69 | historia arte · final tentativo | dom 5 jul | 0.12 |

  > **Importante:** solo exámenes futuros (días > 0). Los pasados ya se rindieron, NO se muestran
  > en Inicio. NO usar iconos de advertencia. Mantener tono neutral.

### 4. Card: Materias
- Container: `border 1px solid #e8e4da; border-radius 10px; overflow hidden; background #fff`
- **Header:** misma estructura que Próximos exámenes
  - Izq: "Materias" + "(10 · 39 pendientes)" en gris
  - Der: "orden: pendientes ↓" + "+ nueva"
- **Sub-header (column labels):**
  - `padding 8px 22px 6px; border-bottom 1px solid #f0ede5`
  - Grid: `40px 1fr 180px 130px 140px; gap 16px`
  - Texto: JetBrains Mono 10px, letter-spacing 0.14em, uppercase, color `#a8a39a`
  - Columnas: "pend." (right) · "materia" · "próximo evento" · "preparación" · "acciones" (right)
- **Filas (10 materias):**
  - Mismo grid, `padding 12px 22px; align items center`
  - Border-top entre filas: `1px solid #f0ede5`
  - Col 1 — pendientes:
    - Si pend > 0: número en `#1a1a1a`, weight 600, tabular-nums
    - Si pend = 0: punto medio "·" en `#a8a39a`
    - Alineado a la derecha
  - Col 2 — nombre materia:
    - Si pend > 0: color `#1a1a1a`, weight 500
    - Si pend = 0: color `#777`, weight 400
  - Col 3 — próximo evento:
    - Si tiene examen: "{tipo}" en `#777` 12px + " en {N}d" en `#a8a39a`
    - Si no tiene: "—" en `#a8a39a`
  - Col 4 — preparación:
    - Si tiene: barra `height 3px; background #f0ede5` + fill (mismo color scheme que exámenes) + "{n}%" en `#777` 11px tabular-nums
    - Si no: "—" en `#a8a39a`
  - Col 5 — acciones (3 botones, gap 6, justify end):
    - Botón "Estudiar": `padding 5px 12px; border-radius 5px; font 11px`
      - Si pend > 0: bg `#1a1a1a`, color `#fff`, border `1px solid #1a1a1a` (primary)
      - Si pend = 0: bg `#fff`, color `#3d3d3d`, border `1px solid #e8e4da` (secondary)
    - Botón "⚙" (configurar): `26×24px; border-radius 5px; bg #fff; color #777; border 1px solid #e8e4da`
    - Botón "✎" (renombrar): mismo estilo que ⚙
- **Datos:**
  | pend | materia | tipo evento | días | readiness |
  |---|---|---|---|---|
  | 1 | (sin materia) | — | — | — |
  | 16 | AM3 | 2do parcial | 38 | 0.42 |
  | 0 | chino | — | — | — |
  | 8 | Computación cuántica | — | — | — |
  | 4 | ERP | 2do parcial | 44 | 0.31 |
  | 0 | física | — | — | — |
  | 6 | historia arte | final tentat. | 69 | 0.12 |
  | 1 | laboratorio 4 (base de datos) | final tentat. | 79 | 0.08 |
  | 0 | NPL | — | — | — |
  | 4 | RN | — | — | — |

### 5. Card: Agenda (colapsada)
- Misma container shell que las otras cards
- **Header (clickeable, toggle):**
  - `padding 16px 22px; cursor pointer; display flex justify-between align-center`
  - Izq (gap 14): "Agenda" + 3 badges:
    - "46 vencidas": color `#b3402a`, bg `#fbeae5`, font 11px weight 500, padding `3px 10px`, border-radius 12
    - "71 mañana": color `#c98428`, bg `#fdf3e0`, mismo estilo
    - "170 total": color `#777`, bg `#f3f0ea`, mismo estilo
  - Der: chevron `⌄` (cerrado) o `⌃` (abierto), color `#a8a39a`, fontSize 13
- **Contenido expandido (cuando open):**
  - `padding 4px 22px 18px`
  - Cada tarjeta:
    - `padding 14px 0; border-top 1px solid #f0ede5; font JetBrains Mono 13px`
    - Línea 1 (flex space-between, fontSize 11):
      - Izq: badge materia (`color #3d3d3d, bg #f3f0ea, padding 2px 8px, border-radius 3px, weight 500`) + "hace N días" en `#777` con margin-left 10
      - Der: "2 revis. · 2 ok" en `#a8a39a`
    - Línea 2: pregunta completa, color `#3d3d3d`, line-height 1.5
  - Footer: "ver las 165 restantes →" centrado, color `#777`, 12px, padding 10px

---

## Interactions & Behavior

### Hover states (todos los botones e ítems clickeables)
- Tabs: cambio sutil de color al hover
- Filas de Materias: bg `rgba(0,0,0,0.02)` al hover (opcional)
- Botones secundarios: border más oscuro al hover
- Botón primary "Estudiar": leve oscurecimiento

### Click handlers
- Tab "Inicio" → ya activa (no-op)
- Otros tabs → navegar a su ruta correspondiente
- "Salir" → logout
- "ver todos →" en Próximos exámenes → ir a vista completa de exámenes
- Header de Agenda → toggle expandir/colapsar (animación suave, ~200ms)
- "+ nueva" → modal/route para crear materia
- Botón "Estudiar" en cada materia → lanza sesión de estudio para esa materia
- Botón "⚙" → modal de configuración de la materia
- Botón "✎" → modal/inline edit para renombrar materia
- "ver las 165 restantes →" en Agenda → ir a vista completa de Agenda
- Click en una tarjeta de Agenda → ir a esa tarjeta para revisar

### Animations
- Toggle Agenda: altura animada `transition: height 200ms ease`, chevron rotación 180°
- Filas: sin animaciones de entrada (carga estática)

### Estados especiales
- **Materia sin pendientes (pend = 0):** texto en gris, botón Estudiar como secundario (no primary)
- **Materia sin examen programado:** mostrar "—" en columnas de evento y preparación
- **Empty states:**
  - Si Próximos exámenes está vacío: ocultar la card completa
  - Si Agenda no tiene vencidas/mañana: ajustar badges (mostrar solo "X total")

---

## State Management

```ts
// Inicio screen state
{
  // Datos del backend
  pendingCardsTotal: number,         // 46
  pendingMain: number,               // 46
  pendingMicro: number,              // 0

  exams: Array<{
    id: string,
    subjectId: string,
    name: string,                    // "AM3 · 2do parcial"
    type: string,                    // "2do parcial"
    days: number,                    // días hasta el examen (futuro >0)
    date: string,                    // "jue 4 jun"
    readiness: number,               // 0..1
  }>,

  subjects: Array<{
    id: string,
    name: string,                    // "AM3"
    pending: number,                 // 16
    nextExam?: { type: string, days: number, readiness: number } | null,
  }>,

  agenda: {
    overdueCount: number,            // 46
    tomorrowCount: number,           // 71
    totalCount: number,              // 170
    cards: Array<{                   // se cargan al expandir
      id: string,
      subject: string,
      ago: string,                   // "18 días"
      question: string,
      reviews: number,
      ok: number,
    }>,
  },

  // UI state
  agendaExpanded: boolean,           // false por defecto
}
```

### Data fetching
- Carga inicial: traer pendingCards, exams (filtrar `days > 0`, ordenar asc, limit 5),
  subjects (todas, ordenadas por `pending desc`), agenda counts
- Lazy: cargar `agenda.cards` solo cuando `agendaExpanded === true`

---

## Design Tokens

```css
/* Colors */
--bg:        #ffffff;
--ink:       #1a1a1a;   /* títulos, primary */
--ink-2:     #3d3d3d;   /* texto principal */
--ink-3:     #777777;   /* texto secundario, metadata */
--ink-4:     #a8a39a;   /* placeholder, separadores tipográficos */
--hair:      #e8e4da;   /* bordes de cards, divisores fuertes */
--hair-lt:   #f0ede5;   /* divisores entre filas, track de barras */

/* Estados / readiness */
--good:      #4a8a3f;   /* readiness >= 40% */
--amber:     #c98428;   /* readiness 20–40% */
--bad:       #b3402a;   /* readiness < 20%, vencidas */
--good-soft: #eaf3e6;
--amber-soft:#fdf3e0;
--bad-soft:  #fbeae5;

/* Acento (no usado en versión final, reservado) */
--accent:    #5b5be8;

/* Spacing */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 22px;
--space-6: 28px;
--space-7: 40px;
--space-8: 56px;

/* Typography */
font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
/* Sizes: 10, 11, 12, 13, 14, 22, 28 px */
/* Weights: 400, 500, 600 */
/* Tabular nums donde haya números (días, %, contadores) */

/* Radius */
--radius-sm: 3px;        /* badges, fills */
--radius:    5px;        /* mini buttons */
--radius-md: 6px;        /* botón Salir */
--radius-lg: 10px;       /* cards principales */
--radius-pill: 12px;     /* badges Agenda */

/* Border */
--border-thin: 1px solid var(--hair);
--border-row:  1px solid var(--hair-lt);
```

---

## Assets
No hay assets binarios. Todo el diseño es tipo + CSS. Iconos usados (caracteres Unicode):
- `↻` reload
- `⌃` `⌄` chevrons
- `⚙` configurar
- `✎` renombrar
- Dots placeholder en header: `●` o div circular

Si querés sustituirlos por un set de iconos (Lucide / Phosphor / Heroicons), perfecto — usar
tamaño 14–16px en color `#777`.

---

## Files
- `Discriminador Home.html` — entrypoint, monta el design canvas con la opción A
- `variation-a.jsx` — **el código fuente del diseño aprobado**. Toda la opción A está acá:
  `VarA_Top`, `VarA_Headline`, `VarA_ExamStrip`, `VarA_MateriasCard`, `VarA_AgendaCollapsed`
- `design-canvas.jsx` — wrapper de presentación (no es parte del diseño, solo lo presenta).
  **Ignorar para la implementación.**

---

## Notas de implementación

1. **NO copiar `design-canvas.jsx`** — es solo el frame para mostrar el diseño en preview.
2. **El stack del codebase manda.** Si discriminador usa Tailwind, traducir los inline styles a
   clases Tailwind. Si usa CSS modules / styled-components, usar lo que ya esté.
3. **Mantener el espíritu monospace** — es parte de la identidad visual. JetBrains Mono o
   equivalente (Geist Mono, IBM Plex Mono) en TODO el sistema.
4. **Datos dinámicos.** Todos los números/strings del mockup vienen del backend. Reemplazar
   los hardcodeados por las props/queries reales.
5. **Pendientes globales (header):** la cifra "46" debería computarse como suma de
   `subjects.pending` o venir del backend directamente.
6. **Filtros importantes:**
   - Próximos exámenes: solo `days > 0`, ordenados ascendente, top 5
   - Materias: ordenadas por `pending desc`
7. **NO mostrar exámenes pasados en Inicio.** Decisión de producto: si ya se rindieron, no son
   relevantes en la pantalla de Inicio.
8. **NO usar íconos de advertencia (⚠) ni colorear con rojo "fechas pasadas".** Mantener tono
   neutral, sin urgencia visual artificial.

## Prompt sugerido para Claude Code

> "Acá tengo un handoff de diseño en `design_handoff_inicio_redesign/`. Leé el README.md
> y luego implementá el rediseño de la pantalla de Inicio en este codebase. Usá los patrones
> que ya existen (componentes, estilos, naming). Reemplazá los datos mockeados por los reales
> del backend. Mostrame los cambios antes de aplicarlos."
