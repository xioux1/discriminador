# MVP V0 Scope — Evaluación teórica escrita

## 1) Objetivo del MVP V0
Entregar una **pantalla única** que permita realizar una evaluación teórica escrita de punta a punta: cargar consigna, respuesta del usuario y respuesta esperada (back), ejecutar evaluación asistida y cerrar con firma manual.

## 2) In scope
- Carga manual de:
  - Consigna
  - Respuesta del usuario
  - Respuesta esperada (back)
- Ejecución de evaluación (sugerencia de calificación + justificación breve).
- Visualización del resultado en la misma pantalla.
- Firma manual de decisión final (aceptar/corregir/duda).
- Persistencia mínima por evaluación (inputs, resultado, decisión final y timestamp).

## 3) Out of scope
- Integración con Anki.
- Audio / STT.
- Scheduler.
- Multiusuario.
- Aplicación mobile.

## 4) Criterios de aceptación medibles
1. **Flujo punta a punta**
   - Dado un ítem completo (consigna + respuesta + back), el usuario puede evaluar y firmar sin salir de la pantalla.
   - Se puede completar el flujo en al menos 10 casos consecutivos sin bloqueos críticos.

2. **Latencia percibida**
   - Tiempo desde clic en `Evaluar` hasta resultado visible: **<= 2 segundos p50** y **<= 4 segundos p95** en entorno objetivo.

3. **Guardado correcto**
   - En el 100% de los casos exitosos se persisten:
     - consigna,
     - respuesta del usuario,
     - respuesta esperada,
     - resultado de evaluación,
     - decisión final firmada,
     - timestamp.
   - Los datos guardados se pueden recuperar y coinciden con lo mostrado en UI.

## 5) Definition of Done (DoD)
- [ ] Existe pantalla única funcional con inputs, botón `Evaluar` y bloque de resultado.
- [ ] La evaluación devuelve calificación sugerida y justificación breve.
- [ ] El usuario puede firmar decisión final (aceptar/corregir/duda).
- [ ] Se persisten inputs + resultado + firma + timestamp.
- [ ] Se verifica flujo punta a punta con casos de prueba básicos.
- [ ] Se mide y registra latencia p50/p95.
- [ ] Se valida recuperación de datos persistidos.
- [ ] Quedan explícitamente excluidos Anki, audio/STT, scheduler, multiusuario y mobile.
