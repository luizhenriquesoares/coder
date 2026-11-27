import type { Localized, ReviewerId, Round } from "./model.js";

/**
 * A council member's identity. Personas are archetypes inspired by published
 * work and public engineering style; they never claim to be those people.
 */
export interface Persona {
  readonly id: ReviewerId;
  readonly name: Localized;
  readonly school: Localized;
  readonly lens: Localized;
  /** The published work or public style the archetype is inspired by. */
  readonly inspiredBy: string | null;
  readonly initials: string;
  readonly color: string;
  readonly rounds: readonly Round[];
}

export const PERSONAS: Readonly<Record<ReviewerId, Persona>> = {
  architect: {
    id: "architect",
    name: { en: "Solutions Architect", pt: "Arquiteto de Soluções" },
    school: { en: "Architecture & DDD", pt: "Arquitetura & DDD" },
    lens: {
      en: "Boundaries, coupling, dependency direction, domain fit, scalability and operability.",
      pt: "Fronteiras, acoplamento, direção das dependências, aderência ao domínio, escala e operação.",
    },
    inspiredBy: null,
    initials: "SA",
    color: "#4FC1FF",
    rounds: ["opening", "debate"],
  },
  staff: {
    id: "staff",
    name: { en: "Staff Engineer", pt: "Staff Engineer" },
    school: { en: "Correctness & Security", pt: "Corretude & Segurança" },
    lens: {
      en: "Bugs, edge cases, concurrency, security, performance and test coverage.",
      pt: "Bugs, casos de borda, concorrência, segurança, performance e cobertura de testes.",
    },
    inspiredBy: null,
    initials: "SE",
    color: "#F2A65A",
    rounds: ["opening", "debate"],
  },
  refactoring: {
    id: "refactoring",
    name: { en: "Refactoring School", pt: "Escola da Refatoração" },
    school: { en: "Evolutionary design", pt: "Design evolutivo" },
    lens: {
      en: "Code smells, named refactorings in small safe steps, evolutionary design, YAGNI.",
      pt: "Code smells, refatorações nomeadas em passos pequenos e seguros, design evolutivo, YAGNI.",
    },
    inspiredBy: "Martin Fowler — Refactoring",
    initials: "RF",
    color: "#B48EF5",
    rounds: ["opening", "debate"],
  },
  cleancode: {
    id: "cleancode",
    name: { en: "Clean Code School", pt: "Escola do Clean Code" },
    school: { en: "Craftsmanship & SOLID", pt: "Artesanato & SOLID" },
    lens: {
      en: "SOLID, naming, small functions, the Dependency Rule, TDD and the boy-scout rule.",
      pt: "SOLID, nomes, funções pequenas, a Regra da Dependência, TDD e a regra do escoteiro.",
    },
    inspiredBy: "Robert C. Martin — Clean Code",
    initials: "CC",
    color: "#4EC9B0",
    rounds: ["opening", "debate"],
  },
  implementer: {
    id: "implementer",
    name: { en: "Pragmatic Implementer", pt: "Implementador Pragmático" },
    school: { en: "Show me the code", pt: "Mostre o código" },
    lens: {
      en: "Turns agreed findings into minimal patches. Simple data structures, no special cases, no bikeshedding.",
      pt: "Transforma achados acordados em patches mínimos. Estruturas simples, sem casos especiais, sem bikeshedding.",
    },
    inspiredBy: "Linus Torvalds — engineering style",
    initials: "PI",
    color: "#F14C4C",
    rounds: ["implementation"],
  },
  moderator: {
    id: "moderator",
    name: { en: "Moderator (CTO)", pt: "Moderador (CTO)" },
    school: { en: "Decision", pt: "Decisão" },
    lens: {
      en: "Weighs consensus and dissent, issues the verdict and tells the human where to look.",
      pt: "Pesa consenso e dissidência, emite o veredito e aponta onde o humano deve olhar.",
    },
    inspiredBy: null,
    initials: "CTO",
    color: "#DCDCAA",
    rounds: ["verdict"],
  },
};

export const COUNCIL_ORDER: readonly ReviewerId[] = [
  "architect",
  "staff",
  "refactoring",
  "cleancode",
  "implementer",
  "moderator",
];

/** Who speaks in a round, in council order: the seating plan the protocol follows and the aggregate enforces. */
export function speakersIn(round: Round): ReviewerId[] {
  return COUNCIL_ORDER.filter((reviewer) => PERSONAS[reviewer].rounds.includes(round));
}
