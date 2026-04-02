# Especificación técnica: preprocesamiento de texto

## 1) Objetivo del preprocesamiento

Estandarizar respuestas de alumnos para **mejorar la robustez ante typos y variantes de escritura** sin modificar el contenido conceptual evaluado por el scoring.

Principios:
- Preservar intención semántica.
- Reducir ruido superficial (formato, espaciado, variación gráfica).
- Evitar transformaciones agresivas que alteren significado.

## 2) Entradas y salidas esperadas del pipeline

### Entrada
- `raw_text`: texto crudo del alumno (UTF-8), potencialmente con errores ortográficos, abreviaturas, emojis o puntuación inconsistente.

### Salida
Objeto lógico con tres capas, según consumo del scoring:
- `normalized_text`: texto normalizado (reglas de la sección 3).
- `tokens`: lista de tokens segmentados tras normalización.
- `lemmas` (opcional según motor de scoring): lema por token para comparación semántica y de variantes morfológicas.

Ejemplo de estructura:

```json
{
  "normalized_text": "la empresa mejora su clima laboral",
  "tokens": ["la", "empresa", "mejora", "su", "clima", "laboral"],
  "lemmas": ["el", "empresa", "mejorar", "su", "clima", "laboral"]
}
```

## 3) Reglas explícitas de normalización

Orden recomendado de aplicación:

1. **Unicode NFC + lowercase**
   - Convertir todo a minúsculas.
   - Normalizar representación unicode para evitar diferencias invisibles.

2. **Colapso de espacios**
   - Reemplazar secuencias de espacios, tabs y saltos de línea por un único espacio.
   - Aplicar `trim` inicial/final.

3. **Tildes: política definida**
   - **Se conservan tildes en `normalized_text`** (prioridad lingüística en español).
   - Para matching tolerante, se permite una vista secundaria *accent-folded* interna (sin tildes), sin reemplazar la salida principal.

4. **Puntuación: qué se elimina y qué se preserva**
   - Eliminar puntuación no informativa para scoring léxico: `.,;:!?"'()[]{}¿¡`.
   - Preservar temporalmente separadores útiles para tokenización de compuestos (`-`, `/`) y luego resolver por regla:
     - `bien-estar` → `bien estar`.
     - `p/` (abreviatura) → ver regla de abreviaturas.
   - Eliminar emojis y símbolos decorativos.

5. **Números**
   - Conservar números arábigos (`2024`, `50`, `3.5`) por posible valor semántico.
   - Normalizar separadores decimales frecuentes a formato consistente (por ejemplo, coma decimal a punto en etapa interna), preservando equivalencia.

6. **Abreviaturas y siglas**
   - Aplicar diccionario explícito de expansión cuando la ambigüedad sea baja.
   - Ejemplos recomendados:
     - `rrhh` → `recursos humanos`.
     - `p/` → `para`.
     - `xq`, `pq` → `porque`.
   - Si la expansión es ambigua, **no expandir**.

## 4) Política de corrección ortográfica

La corrección ortográfica es **conservadora**:
- Solo aplicar cuando la confianza sea alta (ej. distancia de edición baja + contexto coherente + término frecuente del dominio).
- No corregir si hay múltiples candidatos plausibles.
- Nunca corregir elementos en lista de “no tocar” (sección 6).
- Registrar trazabilidad (`original -> corregido`) para auditoría.

Ejemplos:
- `comunicacion` → `comunicación` (alta confianza).
- `caza` no cambiar a `casa` sin evidencia contextual fuerte.

## 5) Criterios de aceptación (20 pares input → output)

> Convención: se muestra `normalized_text` esperado.

1. `La Empresa TIENE buen CLIMA.` → `la empresa tiene buen clima`
2. `  Trabajo   en   equipo  ` → `trabajo en equipo`
3. `COMUNICACION efectiva` → `comunicación efectiva`
4. `Gestion del tiempo` → `gestión del tiempo`
5. `RRHH coordina capacitaciones` → `recursos humanos coordina capacitaciones`
6. `p/ mejorar desempeño` → `para mejorar desempeño`
7. `xq faltó feedback` → `porque faltó feedback`
8. `pq no hubo induccion` → `porque no hubo inducción`
9. `Evaluación 360°!!!` → `evaluación 360`
10. `Objetivos (SMART) claros` → `objetivos smart claros`
11. `Bien-estar laboral` → `bien estar laboral`
12. `Aumentó 3,5% la productividad` → `aumentó 3.5 la productividad`
13. `Plan 2026\ncon hitos` → `plan 2026 con hitos`
14. `Liderazgo y empatia` → `liderazgo y empatía`
15. `El área de Ventas / MKT colabora` → `el área de ventas mkt colabora`
16. `Capacitacón interna mensual` → `capacitación interna mensual`
17. `Se redujo el ausentísmo` → `se redujo el ausentismo`
18. `Buen uso de KPI's` → `buen uso de kpis`
19. `Cliente interno satisfecho 🙂` → `cliente interno satisfecho`
20. `No hay q cambiar todo` → `no hay q cambiar todo`

Criterios verificables:
- Se cumple lowercase y colapso de espacios en 100% de casos.
- No se pierden números relevantes.
- Expansión de abreviaturas solo en casos definidos.
- Correcciones ortográficas aplicadas únicamente en casos de alta confianza.

## 6) Lista de “no tocar”

No modificar automáticamente (ni corregir ni expandir) los siguientes tipos:
- **Nombres propios**: personas, instituciones, marcas, asignaturas nominales.
- **Siglas sensibles**: `ERP`, `CRM`, `BI`, `OKR`, `NPS`, `ISO`, `SAP`, etc.
- **Términos técnicos de negocio**: expresiones estandarizadas del dominio usadas tal cual por rúbricas o contenido curricular.

Recomendación operativa:
- Mantener una **allowlist/no-touch list versionada** y editable por producto/academia.
