// Variation A — refinada con la estructura completa de tu home
// Decisiones:
// - Headline grande arriba
// - Meta diaria + Para hoy (las 2 cards principales, lado a lado)
// - Materias = navegación principal (lista densa con badges de examen integrados,
//   reemplaza la zona de "Próximos exámenes" + "Materias" originales)
// - Próximos exámenes <30d: tira compacta arriba como alerta
// - Agenda: colapsada por defecto con contador

const A_TOK = {
  bg:      '#ffffff',
  ink:     '#1a1a1a',
  ink2:    '#3d3d3d',
  ink3:    '#777777',
  ink4:    '#a8a39a',
  hair:    '#e8e4da',
  hairLt:  '#f0ede5',
  accent:  '#5b5be8',
  accentSoft: '#eeeefb',
  amber:   '#c98428',
  amberSoft:'#fdf3e0',
  good:    '#4a8a3f',
  goodSoft:'#eaf3e6',
  bad:     '#b3402a',
  badSoft: '#fbeae5',
};

const aMono = '"JetBrains Mono", ui-monospace, monospace';

function VarA_Top() {
  const tabs = ['Inicio', 'Estudiar', 'Tarjetas', 'Planificar', 'Progreso', 'Configuración', 'Documentos'];
  const active = 'Inicio';
  return (
    <div style={{ padding: '28px 56px 0', background: A_TOK.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <span style={{
          fontFamily: aMono, fontSize: 22, fontWeight: 500, color: A_TOK.ink, letterSpacing: '-0.01em',
        }}>
          discriminador<span style={{ color: A_TOK.ink4 }}>.com</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: A_TOK.ink4 }} />
          ))}
        </div>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${A_TOK.hair}`,
      }}>
        <div style={{ display: 'flex' }}>
          {tabs.map(t => {
            const a = t === active;
            return (
              <div key={t} style={{
                fontFamily: aMono, fontSize: 14, padding: '14px 18px',
                color: a ? A_TOK.ink : A_TOK.ink3,
                borderBottom: a ? `2px solid ${A_TOK.ink}` : '2px solid transparent',
                marginBottom: -1,
                fontWeight: a ? 500 : 400,
              }}>{t}</div>
            );
          })}
          <div style={{ fontFamily: aMono, fontSize: 14, padding: '14px 18px', color: A_TOK.ink4 }}>↻</div>
        </div>
        <button style={{
          fontFamily: aMono, fontSize: 14, color: A_TOK.ink2,
          padding: '8px 22px', background: 'transparent',
          border: `1px solid ${A_TOK.hair}`, borderRadius: 6, cursor: 'pointer', marginBottom: 8,
        }}>Salir</button>
      </div>
    </div>
  );
}

function VarA_Headline() {
  return (
    <div style={{ padding: '40px 56px 24px' }}>
      <h1 style={{
        margin: 0, fontFamily: aMono, fontSize: 28, fontWeight: 400,
        color: A_TOK.ink, lineHeight: 1.4, letterSpacing: '-0.01em',
      }}>
        46 pendientes hoy <span style={{ color: A_TOK.ink3 }}>(46 tarjetas principales + 0 microconsignas).</span>
      </h1>
    </div>
  );
}

// Tira de próximos exámenes (solo futuros)
function VarA_ExamStrip() {
  const exams = [
    { name: 'AM3 · 2do parcial',                       days: 38, date: 'jue 4 jun',  readiness: 0.42 },
    { name: 'ERP · 2do parcial',                       days: 44, date: 'mié 10 jun', readiness: 0.31 },
    { name: 'AMJ · recuperatorio dentro',              days: 45, date: 'jue 11 jun', readiness: 0.50 },
    { name: 'AMJ · recuperatorio fuera',               days: 58, date: 'mié 24 jun', readiness: 0.50 },
    { name: 'historia arte · final tentativo',         days: 69, date: 'dom 5 jul',  readiness: 0.12 },
  ];
  if (!exams.length) return null;
  return (
    <div style={{
      margin: '0 56px 24px',
      border: `1px solid ${A_TOK.hair}`,
      borderRadius: 10, overflow: 'hidden',
      background: A_TOK.bg,
    }}>
      <div style={{
        padding: '14px 18px',
        borderBottom: `1px solid ${A_TOK.hair}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: aMono, fontSize: 13,
      }}>
        <span style={{ color: A_TOK.ink2, fontWeight: 500 }}>
          Próximos exámenes
          <span style={{ color: A_TOK.ink3, fontWeight: 400, marginLeft: 8 }}>
            · siguiente en {exams[0].days} días
          </span>
        </span>
        <span style={{ color: A_TOK.ink3, fontSize: 12 }}>ver todos →</span>
      </div>
      <div>
        {exams.map((e, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '70px 1fr 110px 200px',
            alignItems: 'center', gap: 18,
            padding: '12px 18px',
            fontFamily: aMono, fontSize: 13,
            borderTop: i > 0 ? `1px solid ${A_TOK.hairLt}` : 'none',
          }}>
            <span style={{
              fontFamily: aMono, fontWeight: 600, color: A_TOK.ink2,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {e.days}d
            </span>
            <span style={{ color: A_TOK.ink2 }}>{e.name}</span>
            <span style={{ color: A_TOK.ink3, fontSize: 12 }}>{e.date}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, height: 4, background: '#f0ede5', borderRadius: 2, position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, width: `${e.readiness * 100}%`,
                  background: e.readiness >= 0.4 ? A_TOK.good : e.readiness >= 0.2 ? A_TOK.amber : A_TOK.bad,
                  borderRadius: 2 }} />
              </div>
              <span style={{ color: A_TOK.ink3, fontSize: 11, fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>
                {Math.round(e.readiness * 100)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VarA_MetaCard() {
  const reviewed = 28, goal = 50;
  const pct = reviewed / goal;
  return (
    <div style={cardA()}>
      <div style={cardHeaderA()}>
        <span>
          <span style={{ color: A_TOK.ink2 }}>Meta diaria:</span>
          <span style={{ color: A_TOK.ink, fontWeight: 500 }}> {reviewed} / {goal}</span>
          <span style={{ color: A_TOK.ink3 }}> revisiones</span>
        </span>
        <span style={{ color: A_TOK.ink4, fontSize: 13 }}>⌃</span>
      </div>
      <div style={{ padding: '0 22px 22px' }}>
        <div style={{ height: 6, background: '#f0ede5', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, width: `${pct * 100}%`, background: A_TOK.accent, borderRadius: 3 }} />
        </div>
        <div style={{ marginTop: 12, fontFamily: aMono, fontSize: 13, color: A_TOK.ink3, display: 'flex', justifyContent: 'space-between' }}>
          <span>33min estudiados hoy</span>
          <span>{Math.round(pct * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

function VarA_TodayCard() {
  const items = [
    { name: 'AM3',                       ev: '2do parcial',     days: 38, est: 16 },
    { name: 'ERP',                       ev: '2do parcial',     days: 44, est: 13 },
    { name: 'historia arte',             ev: 'tentativa final', days: 69, est: 14 },
    { name: 'laboratorio 4 (base de datos)', ev: 'tentativa final', days: 79, est: 13 },
  ];
  return (
    <div style={cardA()}>
      <div style={cardHeaderA()}>
        <span>
          <span style={{ color: A_TOK.ink2 }}>Para hoy</span>
          <span style={{ color: A_TOK.ink3 }}> (120min disponibles):</span>
        </span>
        <span style={{ color: A_TOK.ink4, fontSize: 13 }}>⌃</span>
      </div>
      <div style={{ padding: '4px 22px 18px' }}>
        {items.map((it, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '14px 1fr auto auto',
            alignItems: 'center', gap: 14, padding: '10px 0',
            fontFamily: aMono, fontSize: 14, color: A_TOK.ink2,
            borderTop: i > 0 ? `1px solid ${A_TOK.hairLt}` : 'none',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: A_TOK.good }} />
            <span style={{ color: A_TOK.ink, fontWeight: 400 }}>{it.name}</span>
            <span style={{ color: A_TOK.ink3, fontSize: 13 }}>{it.ev} en {it.days} días</span>
            <span style={{ color: A_TOK.accent, fontWeight: 600, minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
              {it.est}min
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// MATERIAS — la zona protagonista (navegación principal)
// Integra los % de readiness/exámenes que antes estaban en "Próximos exámenes"
function VarA_MateriasCard() {
  const materias = [
    { name: '(sin materia)',           pend: 1,  exam: null,                     readiness: null },
    { name: 'AM3',                     pend: 16, exam: { type: '2do parcial',   days: 38 }, readiness: 0.42 },
    { name: 'chino',                   pend: 0,  exam: null,                     readiness: null },
    { name: 'Computación cuántica',    pend: 8,  exam: null,                     readiness: null },
    { name: 'ERP',                     pend: 4,  exam: { type: '2do parcial',   days: 44 }, readiness: 0.31 },
    { name: 'física',                  pend: 0,  exam: null,                     readiness: null },
    { name: 'historia arte',           pend: 6,  exam: { type: 'final tentat.', days: 69 }, readiness: 0.12 },
    { name: 'laboratorio 4 (base de datos)', pend: 1, exam: { type: 'final tentat.', days: 79 }, readiness: 0.08 },
    { name: 'NPL',                     pend: 0,  exam: null,                     readiness: null },
    { name: 'RN',                      pend: 4,  exam: null,                     readiness: null },
  ];
  return (
    <div style={cardA()}>
      <div style={cardHeaderA()}>
        <span>
          <span style={{ color: A_TOK.ink2 }}>Materias</span>
          <span style={{ color: A_TOK.ink3 }}> (10 · 39 pendientes)</span>
        </span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, color: A_TOK.ink3 }}>
          <span>orden: pendientes ↓</span>
          <span style={{ color: A_TOK.ink4 }}>+ nueva</span>
        </div>
      </div>
      <div style={{
        padding: '8px 22px 6px',
        display: 'grid',
        gridTemplateColumns: '40px 1fr 180px 130px 140px',
        gap: 16,
        fontFamily: aMono, fontSize: 10, letterSpacing: '0.14em',
        color: A_TOK.ink4, textTransform: 'uppercase',
        borderBottom: `1px solid ${A_TOK.hairLt}`,
      }}>
        <span style={{ textAlign: 'right' }}>pend.</span>
        <span>materia</span>
        <span>próximo evento</span>
        <span>preparación</span>
        <span style={{ textAlign: 'right' }}>acciones</span>
      </div>
      <div>
        {materias.map((m, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '40px 1fr 180px 130px 140px',
            alignItems: 'center', gap: 16,
            padding: '12px 22px',
            fontFamily: aMono, fontSize: 13,
            borderTop: i > 0 ? `1px solid ${A_TOK.hairLt}` : 'none',

          }}>
            <span style={{
              textAlign: 'right',
              color: m.pend > 0 ? A_TOK.ink : A_TOK.ink4,
              fontWeight: m.pend > 0 ? 600 : 400,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {m.pend > 0 ? m.pend : '·'}
            </span>
            <span style={{ color: m.pend > 0 ? A_TOK.ink : A_TOK.ink3, fontWeight: m.pend > 0 ? 500 : 400 }}>
              {m.name}
            </span>
            <span style={{ color: A_TOK.ink3, fontSize: 12 }}>
              {m.exam ? (
                <>
                  {m.exam.type}
                  <span style={{ color: A_TOK.ink4, marginLeft: 8 }}>
                    en {m.exam.days}d
                  </span>
                </>
              ) : <span style={{ color: A_TOK.ink4 }}>—</span>}
            </span>
            {m.readiness !== null ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 3, background: '#f0ede5', borderRadius: 2, position: 'relative' }}>
                  <div style={{
                    position: 'absolute', inset: 0, width: `${m.readiness * 100}%`,
                    background: m.readiness >= 0.4 ? A_TOK.good : m.readiness >= 0.2 ? A_TOK.amber : A_TOK.bad,
                    borderRadius: 2,
                  }} />
                </div>
                <span style={{ color: A_TOK.ink3, fontSize: 11, fontVariantNumeric: 'tabular-nums', minWidth: 28 }}>
                  {Math.round(m.readiness * 100)}%
                </span>
              </div>
            ) : <span style={{ color: A_TOK.ink4, fontSize: 11 }}>—</span>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button style={miniBtnA(m.pend > 0)}>Estudiar</button>
              <button style={miniBtnIconA()}>⚙</button>
              <button style={miniBtnIconA()}>✎</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// AGENDA — colapsada por defecto
function VarA_AgendaCollapsed() {
  const [open, setOpen] = React.useState(false);
  const cards = [
    { mat: 'NPL',          ago: '18 días', q: 'En un corpus periodístico, usted quiere detectar qué palabras tienen significado o uso parecido a "n…' },
    { mat: 'NPL',          ago: '13 días', q: 'Explique por qué el escalado de variables puede ser importante en redes neuronales y relacione esto …' },
    { mat: 'historia arte',ago: '12 días', q: 'Barroco (c. 1608+): ¿por qué surge y cuáles son sus recursos visuales/espaciales clave?' },
    { mat: 'historia arte',ago: '12 días', q: '¿Por qué el arte egipcio se ve "siempre igual"?' },
    { mat: 'NPL',          ago: '12 días', q: '¿Por qué las capas de max pooling son útiles en redes convolucionales? ¿Qué efecto tienen sobre la c…' },
  ];
  return (
    <div style={cardA()}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          ...cardHeaderA(),
          cursor: 'pointer',
          padding: '16px 22px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ color: A_TOK.ink2 }}>Agenda</span>
          <span style={{ ...badge(A_TOK.bad, A_TOK.badSoft) }}>46 vencidas</span>
          <span style={{ ...badge(A_TOK.amber, A_TOK.amberSoft) }}>71 mañana</span>
          <span style={{ ...badge(A_TOK.ink3, '#f3f0ea') }}>170 total</span>
        </div>
        <span style={{ color: A_TOK.ink4, fontSize: 13 }}>{open ? '⌃' : '⌄'}</span>
      </div>
      {open && (
        <div style={{ padding: '4px 22px 18px' }}>
          {cards.map((c, i) => (
            <div key={i} style={{
              padding: '14px 0',
              borderTop: `1px solid ${A_TOK.hairLt}`,
              fontFamily: aMono, fontSize: 13,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 11 }}>
                <span>
                  <span style={{
                    color: A_TOK.ink2, background: '#f3f0ea',
                    padding: '2px 8px', borderRadius: 3, fontWeight: 500,
                  }}>{c.mat}</span>
                  <span style={{ color: A_TOK.ink3, marginLeft: 10 }}>hace {c.ago}</span>
                </span>
                <span style={{ color: A_TOK.ink4 }}>2 revis. · 2 ok</span>
              </div>
              <div style={{ color: A_TOK.ink2, lineHeight: 1.5 }}>
                {c.q}
              </div>
            </div>
          ))}
          <div style={{ marginTop: 14, fontFamily: aMono, fontSize: 12, color: A_TOK.ink3, textAlign: 'center', padding: '10px 0' }}>
            ver las 165 restantes →
          </div>
        </div>
      )}
    </div>
  );
}

function badge(fg, bg) {
  return {
    fontFamily: aMono, fontSize: 11, fontWeight: 500,
    color: fg, background: bg,
    padding: '3px 10px', borderRadius: 12,
  };
}

function miniBtnA(primary) {
  return {
    fontFamily: aMono, fontSize: 11,
    padding: '5px 12px',
    border: `1px solid ${primary ? A_TOK.ink : A_TOK.hair}`,
    background: primary ? A_TOK.ink : '#fff',
    color: primary ? '#fff' : A_TOK.ink2,
    borderRadius: 5, cursor: 'pointer',
  };
}

function miniBtnIconA() {
  return {
    fontFamily: aMono, fontSize: 11,
    width: 26, height: 24,
    border: `1px solid ${A_TOK.hair}`,
    background: '#fff', color: A_TOK.ink3,
    borderRadius: 5, cursor: 'pointer', padding: 0,
  };
}

function cardA() {
  return {
    background: A_TOK.bg,
    border: `1px solid ${A_TOK.hair}`,
    borderRadius: 10, overflow: 'hidden',
  };
}

function cardHeaderA() {
  return {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 22px 12px',
    fontFamily: aMono, fontSize: 14, color: A_TOK.ink2,
  };
}

function VariationA() {
  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden',
      background: A_TOK.bg, color: A_TOK.ink, fontFamily: aMono,
    }}>
      <VarA_Top />
      <VarA_Headline />
      <VarA_ExamStrip />
      <div style={{ padding: '0 56px 16px' }}>
        <VarA_MateriasCard />
      </div>
      <div style={{ padding: '0 56px 56px' }}>
        <VarA_AgendaCollapsed />
      </div>
    </div>
  );
}

window.VariationA = VariationA;
