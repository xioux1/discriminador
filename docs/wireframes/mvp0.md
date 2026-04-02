# Wireframe MVP0 — Flujo de evaluación asistida

## 1) Bloque de entrada

### Campos
- **Consigna** *(obligatorio)*
  - Tipo: textarea multilínea.
  - Propósito: enunciado o pregunta que el estudiante debía responder.
- **Respuesta del usuario** *(obligatorio)*
  - Tipo: textarea multilínea.
  - Propósito: texto del estudiante a evaluar.
- **Respuesta esperada** *(obligatorio)*
  - Tipo: textarea multilínea.
  - Propósito: pauta o respuesta de referencia.
- **Materia / Tags** *(opcional)*
  - Tipo: input simple o selector múltiple.
  - Propósito: contexto temático (por ejemplo: Matemática, Biología, argumentación, ortografía).

### Comportamiento esperado
- Botón principal: **"Evaluar"**.
- El botón se habilita solo cuando los tres campos obligatorios son válidos.

---

## 2) Bloque de resultado

Se muestra una tarjeta de resultado al finalizar la evaluación.

### Componentes
- **Calificación sugerida**
  - Valor categórico: `PASS` o `FAIL`.
- **Score general**
  - Valor numérico (0–100) y/o porcentaje.
- **Dimensiones**
  - Sub-scores por criterio (ejemplo: exactitud, completitud, claridad, uso de conceptos clave).
- **Justificación breve**
  - Resumen de 2–4 líneas con motivos de la sugerencia.
- **Confianza**
  - Nivel en escala visible (ejemplo: Baja / Media / Alta o 0–1).

---

## 3) Acciones de firma

Acciones disponibles para el evaluador humano una vez visto el resultado:

- **Aceptar sugerencia**
  - Confirma la recomendación propuesta (`PASS` o `FAIL`).
- **Corregir a PASS**
  - Fuerza resultado final `PASS`.
- **Corregir a FAIL**
  - Fuerza resultado final `FAIL`.
- **Marcar duda**
  - Marca el caso para revisión posterior / segunda opinión.

### Metadatos de firma (recomendado)
- Usuario evaluador.
- Timestamp.
- Acción seleccionada.
- Motivo breve (opcional, obligatorio si se corrige o marca duda).

---

## 4) Estados de UI

### Estado inicial
- Formulario vacío.
- Bloque de resultado oculto.
- Botón **"Evaluar"** deshabilitado hasta cumplir validaciones mínimas.

### Estado cargando
- Al presionar **"Evaluar"**, mostrar spinner/skeleton en bloque de resultado.
- Deshabilitar inputs y acciones de firma temporalmente para evitar doble envío.

### Estado error de validación
- No se dispara evaluación.
- Se resaltan campos inválidos con mensaje puntual debajo de cada campo.
- Se mantiene visible el contenido ingresado para corrección.

### Estado resultado listo
- Se renderiza bloque de resultado completo.
- Se habilitan acciones de firma.
- Se muestra confirmación visual tras aplicar una acción (toast o badge de estado final).

---

## 5) Reglas de validación mínima y mensajes de error

### Consigna
- Regla mínima: obligatorio, al menos 10 caracteres no vacíos.
- Error sugerido:
  - **"La consigna es obligatoria (mínimo 10 caracteres)."**

### Respuesta del usuario
- Regla mínima: obligatoria, al menos 5 caracteres no vacíos.
- Error sugerido:
  - **"La respuesta del usuario es obligatoria (mínimo 5 caracteres)."**

### Respuesta esperada
- Regla mínima: obligatoria, al menos 10 caracteres no vacíos.
- Error sugerido:
  - **"La respuesta esperada es obligatoria (mínimo 10 caracteres)."**

### Materia / Tags
- Regla mínima: opcional.
- Si se completa, validar longitud razonable por tag (1–30 caracteres) y sin duplicados exactos.
- Error sugerido:
  - **"Cada tag debe tener entre 1 y 30 caracteres y no repetirse."**

### Reglas transversales
- Normalizar espacios al inicio/fin antes de validar.
- Mostrar solo errores relevantes por campo, en lenguaje claro y accionable.
- Evitar mensajes genéricos como "Error inválido".
