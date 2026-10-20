/**
 * Tests de perfiles por rol en @jobforce/docs: el bloque de énfasis se
 * antepone al contexto de hechos; sin rol, la generación no cambia.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  applyRoleProfileEmphasis,
  buildRoleProfileContext,
} from "../src/index.js";
import type { RoleProfileEmphasis } from "../src/index.js";
import type { CvAdaptation, LetterAdaptation } from "../src/index.js";

const ROLE: RoleProfileEmphasis = {
  name: "Finance Manager / CFO",
  headline: "Finance Manager / CFO · 15+ años · IFRS",
  summary: "Profesional de finanzas con más de 15 años de experiencia.",
  skills: ["IFRS", "SAP", "Power BI"],
};

const CV: CvAdaptation = {
  headline: "Finance Manager",
  summary: ["Resumen construido desde los hechos."],
};

const CARTA: LetterAdaptation = {
  body: ["I am writing to apply for the position of Finance Manager."],
  closing: "Thank you for your time and consideration.",
};

describe("perfiles por rol — contexto y énfasis", () => {
  it("buildRoleProfileContext ordena: titular, resumen y línea de skills", () => {
    assert.deepEqual(buildRoleProfileContext(ROLE), [
      "Finance Manager / CFO · 15+ años · IFRS",
      "Profesional de finanzas con más de 15 años de experiencia.",
      "Role focus skills: IFRS, SAP, Power BI.",
    ]);
  });

  it("buildRoleProfileContext omite campos vacíos y skills en blanco", () => {
    assert.deepEqual(
      buildRoleProfileContext({ name: "X", headline: "  ", summary: "Solo resumen.", skills: [" ", ""] }),
      ["Solo resumen."],
    );
    assert.deepEqual(
      buildRoleProfileContext({ name: "X", headline: "", summary: "", skills: [] }),
      [],
    );
  });

  it("applyRoleProfileEmphasis antepone el bloque al resumen del CV y al cuerpo de la carta", () => {
    const { cv, carta } = applyRoleProfileEmphasis(CV, CARTA, ROLE);
    assert.deepEqual(cv.summary, [
      "Finance Manager / CFO · 15+ años · IFRS",
      "Profesional de finanzas con más de 15 años de experiencia.",
      "Role focus skills: IFRS, SAP, Power BI.",
      "Resumen construido desde los hechos.",
    ]);
    assert.deepEqual(carta.body, [
      "Finance Manager / CFO · 15+ años · IFRS",
      "Profesional de finanzas con más de 15 años de experiencia.",
      "Role focus skills: IFRS, SAP, Power BI.",
      "I am writing to apply for the position of Finance Manager.",
    ]);
    // El titular del CV y el cierre de la carta no se tocan, y no hay mutación.
    assert.equal(cv.headline, "Finance Manager");
    assert.equal(carta.closing, CARTA.closing);
    assert.deepEqual(CV.summary, ["Resumen construido desde los hechos."]);
    assert.deepEqual(CARTA.body, ["I am writing to apply for the position of Finance Manager."]);
  });

  it("sin rol (null/undefined) devuelve las adaptaciones intactas", () => {
    const conNull = applyRoleProfileEmphasis(CV, CARTA, null);
    assert.equal(conNull.cv, CV);
    assert.equal(conNull.carta, CARTA);
    const conUndefined = applyRoleProfileEmphasis(CV, CARTA, undefined);
    assert.equal(conUndefined.cv, CV);
    assert.equal(conUndefined.carta, CARTA);
  });

  it("un rol sin contenido útil no altera las adaptaciones", () => {
    const vacio: RoleProfileEmphasis = { name: "Vacío", headline: "", summary: " ", skills: [] };
    const { cv, carta } = applyRoleProfileEmphasis(CV, CARTA, vacio);
    assert.equal(cv, CV);
    assert.equal(carta, CARTA);
  });
});
