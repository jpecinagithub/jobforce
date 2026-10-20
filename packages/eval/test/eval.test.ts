/**
 * Tests unitarios de @jobforce/eval (sin red, fixtures).
 * Patrón: node --test sobre la salida de tsconfig.test.json.
 *
 * Los hechos de perfil usados son FICTICIOS: nunca se reproducen datos
 * sensibles reales en los tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultCriteria } from '@jobforce/domain';
import { evaluateOffer, norm, type ProfileFactInput } from '../src/index.js';

/** Hechos de perfil ficticios para los tests. */
const FACTS: ProfileFactInput[] = [
  { category: 'skills', key: 'erp_systems', value: ['SAP', 'Oracle', 'NetSuite'] },
  { category: 'languages', key: 'english_level', value: 'advanced' },
  { category: 'experience', key: 'finance_director', value: 'CFO 2023-2026' },
];

const DIMENSIONS = ['funciones', 'competencias', 'seniority', 'ubicacion', 'condiciones', 'empresa'];

describe('norm()', () => {
  it('minúsculas y sin tildes', () => {
    assert.equal(norm('Contabilidad y Tesorería'), 'contabilidad y tesoreria');
    assert.equal(norm('ESPAÑA'), 'espana');
    assert.equal(norm('CFO'), 'cfo');
  });
});

describe('evaluateOffer', () => {
  it('(a) oferta que cumple todo: verdict cumple, score > 0, 6 dimensiones', () => {
    const res = evaluateOffer(
      {
        title: 'CFO — Multinational Group (Remote)',
        url: 'https://example.com/jobs/cfo-1',
        highlights: [
          'We are hiring a CFO to lead the finance function of our multinational group. English is the working language.',
          'This is a remote position based in Spain. Responsibilities: IFRS reporting, consolidation, treasury and budgeting. Requirements: SAP, Power BI, Excel; senior leadership experience. We offer a competitive salary and a permanent contract.',
        ],
      },
      defaultCriteria(),
      FACTS,
    );

    assert.equal(res.mandatory_verdict, 'cumple');
    assert.equal(res.mandatory_details.length, 3);
    for (const d of res.mandatory_details) {
      assert.equal(d.estado, 'cumple');
      assert.ok(d.evidencia.length > 0, `${d.requisito_id} sin evidencia`);
      assert.ok(d.evidencia.length <= 200, `${d.requisito_id} evidencia >200`);
    }
    assert.ok(res.score !== null && res.score > 0, `score=${res.score}`);
    assert.equal(res.breakdown.length, 6);
    assert.deepEqual(
      res.breakdown.map((b) => b.dimension),
      DIMENSIONS,
    );
    for (const b of res.breakdown) {
      assert.ok(b.puntos >= 0 && b.puntos <= 100);
      assert.ok(b.explicacion.length > 0);
    }
    // funciones: 5+ keywords distintas (accounting? no; ifrs, reporting,
    // consolidation, treasury, budget) → 100
    const funciones = res.breakdown.find((b) => b.dimension === 'funciones');
    assert.equal(funciones?.puntos, 100);
    // competencias referencia el hecho ficticio skills.erp_systems (token "erp")
    const competencias = res.breakdown.find((b) => b.dimension === 'competencias');
    assert.ok(competencias?.hechos.includes('skills.erp_systems'));
  });

  it('(b) rol incompatible (Junior Accountant) → incumple, score null', () => {
    const res = evaluateOffer(
      {
        title: 'Junior Accountant',
        url: 'https://example.com/jobs/junior-2',
        highlights: ['Entry-level accounting position with training and growth.'],
      },
      defaultCriteria(),
      FACTS,
    );

    assert.equal(res.mandatory_verdict, 'incumple');
    assert.equal(res.score, null);
    const rol = res.mandatory_details.find((d) => d.requisito_id === 'rol');
    assert.equal(rol?.estado, 'incumple');
    assert.ok(rol && rol.evidencia.length > 0 && rol.evidencia.length <= 200);
    // sin veredicto favorable el desglose queda a 0
    for (const b of res.breakdown) assert.equal(b.puntos, 0);
  });

  it('(c) sin datos de idioma → sin_evidencia en ese requisito, score null', () => {
    const res = evaluateOffer(
      {
        title: 'Finance Manager',
        url: 'https://example.com/jobs/fm-3',
        highlights: ['Finance Manager role with a growing industrial company. Senior position, office in Madrid.'],
      },
      defaultCriteria(),
      FACTS,
    );

    const rol = res.mandatory_details.find((d) => d.requisito_id === 'rol');
    assert.equal(rol?.estado, 'cumple');
    const ingles = res.mandatory_details.find((d) => d.requisito_id === 'ingles');
    assert.equal(ingles?.estado, 'sin_evidencia');
    assert.equal(ingles?.evidencia, '');
    assert.equal(res.mandatory_verdict, 'sin_evidencia');
    assert.equal(res.score, null);
  });

  it('(d) el scoring pondera por densidad de keywords', () => {
    const base = {
      title: 'Finance Manager',
      highlights: [
        'English required. Remote role in Spain.',
      ],
    };
    const rich = evaluateOffer(
      {
        ...base,
        url: 'https://example.com/jobs/rich',
        highlights: [
          ...base.highlights,
          'Accounting, contabilidad, IFRS reporting, consolidation, consolidación, treasury, tesorería, controlling, forecast and budget responsibilities.',
        ],
      },
      defaultCriteria(),
      FACTS,
    );
    const poor = evaluateOffer(
      {
        ...base,
        url: 'https://example.com/jobs/poor',
        highlights: [...base.highlights, 'Finance role focused on monthly reporting.'],
      },
      defaultCriteria(),
      FACTS,
    );

    assert.equal(rich.mandatory_verdict, 'cumple');
    assert.equal(poor.mandatory_verdict, 'cumple');
    const richFunc = rich.breakdown.find((b) => b.dimension === 'funciones')?.puntos ?? -1;
    const poorFunc = poor.breakdown.find((b) => b.dimension === 'funciones')?.puntos ?? -1;
    assert.ok(richFunc > poorFunc, `funciones rich=${richFunc} poor=${poorFunc}`);
    assert.ok(
      rich.score !== null && poor.score !== null && rich.score > poor.score,
      `score rich=${rich.score} poor=${poor.score}`,
    );
  });

  it('política conservadora: rol desconocido sin evidencia positiva → sin_evidencia', () => {
    const res = evaluateOffer(
      {
        title: 'Operations Analyst',
        url: 'https://example.com/jobs/ops',
        highlights: ['Operations Analyst for process improvement projects.'],
      },
      defaultCriteria(),
      FACTS,
    );
    const rol = res.mandatory_details.find((d) => d.requisito_id === 'rol');
    assert.equal(rol?.estado, 'sin_evidencia');
    assert.equal(rol?.evidencia, '');
    assert.equal(res.mandatory_verdict, 'sin_evidencia');
  });

  it('keyword: none_of tiene prioridad y produce incumple', () => {
    const criteria = defaultCriteria();
    criteria.mandatory.push({
      id: 'kw',
      kind: 'keyword',
      description: 'Sin becarios',
      params: { any_of: ['finance'], none_of: ['internship'] },
    });
    const res = evaluateOffer(
      {
        title: 'Finance Internship',
        url: 'https://example.com/jobs/kw',
        highlights: ['Finance internship for students.'],
      },
      criteria,
      FACTS,
    );
    const kw = res.mandatory_details.find((d) => d.requisito_id === 'kw');
    assert.equal(kw?.estado, 'incumple');
    assert.ok(kw && kw.evidencia.length > 0);
    assert.equal(res.mandatory_verdict, 'incumple');
    assert.equal(res.score, null);
  });

  it('keyword de exclusión pura: cumple por ausencia de lo prohibido', () => {
    const criteria = defaultCriteria();
    criteria.mandatory.push({
      id: 'sin_tercer_idioma',
      kind: 'keyword',
      description: 'Sin requisito de un tercer idioma',
      params: { any_of: [], none_of: ['german required', 'fluent german'] },
    });
    const limpia = evaluateOffer(
      {
        title: 'Finance Manager',
        url: 'https://example.com/jobs/ok',
        highlights: ['Finance Manager. English required. Lead the finance team.'],
      },
      criteria,
      FACTS,
    );
    const ok = limpia.mandatory_details.find((d) => d.requisito_id === 'sin_tercer_idioma');
    assert.equal(ok?.estado, 'cumple');

    const conAleman = evaluateOffer(
      {
        title: 'Finance Manager',
        url: 'https://example.com/jobs/de',
        highlights: ['Finance Manager. English required. Fluent German required.'],
      },
      criteria,
      FACTS,
    );
    const mal = conAleman.mandatory_details.find((d) => d.requisito_id === 'sin_tercer_idioma');
    assert.equal(mal?.estado, 'incumple');
    assert.equal(conAleman.mandatory_verdict, 'incumple');
  });

  it('location exclude: España descarta y cualquier otro sitio cumple', () => {
    const criteria = defaultCriteria();
    const idx = criteria.mandatory.findIndex((m) => m.kind === 'location');
    criteria.mandatory[idx] = {
      id: 'ubicacion',
      kind: 'location',
      description: 'Cualquier parte del mundo excepto España',
      params: { mode: 'exclude', countries: ['spain', 'españa', 'espana'] },
    };
    const enEspana = evaluateOffer(
      {
        title: 'Finance Manager',
        url: 'https://example.com/jobs/es',
        highlights: ['Finance Manager in Madrid, Spain. English required.'],
      },
      criteria,
      FACTS,
    );
    const locEs = enEspana.mandatory_details.find((d) => d.requisito_id === 'ubicacion');
    assert.equal(locEs?.estado, 'incumple');

    const enBerlin = evaluateOffer(
      {
        title: 'Finance Manager',
        url: 'https://example.com/jobs/de',
        highlights: ['Finance Manager in Berlin. English required.'],
      },
      criteria,
      FACTS,
    );
    const locDe = enBerlin.mandatory_details.find((d) => d.requisito_id === 'ubicacion');
    assert.equal(locDe?.estado, 'cumple');
  });

  it('idioma: oferta redactada en inglés cumple aunque no diga «English» (regla de Jon)', () => {
    const res = evaluateOffer(
      {
        title: 'Finance Manager',
        url: 'https://example.com/jobs/en',
        highlights: [
          'Finance Manager to lead our finance team in Berlin, Germany. You will be responsible for the monthly closing and reporting, working with our business partners across the group. We are looking for someone with strong experience in accounting who will support the team and drive improvements in our processes.',
        ],
      },
      defaultCriteria(),
      FACTS,
    );
    const ing = res.mandatory_details.find((d) => d.requisito_id === 'ingles');
    assert.equal(ing?.estado, 'cumple');
    assert.ok(ing && ing.evidencia.length > 0);
    assert.equal(res.mandatory_verdict, 'cumple');
  });

  it('idioma: oferta redactada en castellano cumple si el castellano está aceptado (campaña ONGs)', () => {
    const criteria = defaultCriteria();
    const langReq = criteria.mandatory.find((r) => r.id === 'ingles');
    assert.ok(langReq);
    langReq.params = { languages: ['english', 'inglés', 'spanish', 'español', 'castellano'] };
    const res = evaluateOffer(
      {
        title: 'Administrador de País — Cooperación Internacional',
        url: 'https://example.com/jobs/ong',
        highlights: [
          'Buscamos administrador de país para nuestra misión en Senegal. La persona seleccionada será responsable de la gestión financiera del proyecto, la elaboración de presupuestos y la justificación de subvenciones, trabajando con el equipo local y con la sede. Se requiere experiencia en administración de proyectos de cooperación y en el manejo de herramientas contables.',
        ],
      },
      criteria,
      FACTS,
    );
    const ing = res.mandatory_details.find((d) => d.requisito_id === 'ingles');
    assert.equal(ing?.estado, 'cumple');
    assert.ok(ing && ing.evidencia.length > 0);
  });

  it('idioma: inglés con señal moderada (6 funcionales, dominio claro) también cumple', () => {
    // Caso real (World Vision Honduras, 20-oct-2026): titular en español y
    // descripción en inglés con 7 palabras funcionales distintas — la
    // detección debe reconocerla sin bajar el listón del dominio.
    const res = evaluateOffer(
      {
        title: 'Senior Finance Manager — Tegucigalpa',
        url: 'https://example.com/jobs/wv',
        highlights: [
          'With years of experience, our focus is on helping the most vulnerable children. Come join our staff working in nearly 100 countries and share the joy of transforming lives with the team.',
        ],
      },
      defaultCriteria(),
      FACTS,
    );
    const ing = res.mandatory_details.find((d) => d.requisito_id === 'ingles');
    assert.equal(ing?.estado, 'cumple');
  });

  it('idioma: oferta redactada en castellano NO cumple si solo se pide inglés', () => {
    const res = evaluateOffer(
      {
        title: 'Administrador de País — Cooperación Internacional',
        url: 'https://example.com/jobs/ong2',
        highlights: [
          'Buscamos administrador de país para nuestra misión en Senegal. La persona seleccionada será responsable de la gestión financiera del proyecto, la elaboración de presupuestos y la justificación de subvenciones, trabajando con el equipo local y con la sede.',
        ],
      },
      defaultCriteria(),
      FACTS,
    );
    const ing = res.mandatory_details.find((d) => d.requisito_id === 'ingles');
    assert.equal(ing?.estado, 'sin_evidencia');
  });

  it('idioma: oferta redactada en español sin nombrar el inglés → sin_evidencia', () => {
    const res = evaluateOffer(
      {
        title: 'Responsable de Finanzas',
        url: 'https://example.com/jobs/es',
        highlights: [
          'Responsable de finanzas para liderar el equipo en Madrid. Serás responsable del cierre mensual y de la elaboración de informes, trabajando con todas las áreas de la empresa. Buscamos una persona con experiencia en contabilidad que quiera crecer con nosotros.',
        ],
      },
      defaultCriteria(),
      FACTS,
    );
    const ing = res.mandatory_details.find((d) => d.requisito_id === 'ingles');
    assert.equal(ing?.estado, 'sin_evidencia');
  });

  it('idioma: oferta redactada en alemán → sin_evidencia de inglés', () => {
    const res = evaluateOffer(
      {
        title: 'Finanzmanager',
        url: 'https://example.com/jobs/de',
        highlights: [
          'Finanzmanager für unser Team in München. Sie sind verantwortlich für den Monatsabschluss und die Berichterstattung und arbeiten mit allen Bereichen des Unternehmens zusammen. Wir suchen eine Persönlichkeit mit Erfahrung im Rechnungswesen.',
        ],
      },
      defaultCriteria(),
      FACTS,
    );
    const ing = res.mandatory_details.find((d) => d.requisito_id === 'ingles');
    assert.equal(ing?.estado, 'sin_evidencia');
  });

  it('la evidencia nunca supera los 200 caracteres', () => {
    const long = `CFO needed. ${'x'.repeat(500)} English required. ${'y'.repeat(500)}`;
    const res = evaluateOffer(
      {
        title: `Chief Financial Officer ${'z'.repeat(300)}`,
        url: 'https://example.com/jobs/long',
        highlights: [long],
      },
      defaultCriteria(),
      FACTS,
    );
    for (const d of res.mandatory_details) {
      assert.ok(d.evidencia.length <= 200, `${d.requisito_id}: ${d.evidencia.length}`);
    }
  });

  it('location: presencial en país excluido → incumple', () => {
    const res = evaluateOffer(
      {
        title: 'Finance Manager',
        url: 'https://example.com/jobs/mx',
        highlights: ['Finance Manager. English required. Presencial en México, oficina en Ciudad de México.'],
      },
      defaultCriteria(),
      FACTS,
    );
    const ubi = res.mandatory_details.find((d) => d.requisito_id === 'ubicacion');
    assert.equal(ubi?.estado, 'incumple');
    assert.ok(ubi && ubi.evidencia.length > 0);
    assert.equal(res.mandatory_verdict, 'incumple');
  });
});
