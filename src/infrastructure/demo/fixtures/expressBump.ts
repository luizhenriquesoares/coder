import { L, type CouncilScript, type DemoFile } from "../types.js";

const PACKAGE = "package.json";

const packageJson = (expressVersion: string) => `{
  "name": "storefront",
  "version": "3.14.0",
  "private": true,
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/server.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "${expressVersion}",
    "pg": "^8.11.3",
    "pino": "^8.17.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "jest": "^29.7.0",
    "typescript": "^5.3.3"
  }
}
`;

export const expressBumpFiles: readonly DemoFile[] = [
  { path: PACKAGE, base: packageJson("^4.18.2"), head: packageJson("^4.21.2") },
];

export const expressBumpScript: CouncilScript = {
  opening: {
    architect: {
      statement: L(
        "A minor upgrade inside the same major version of the web framework. No boundary or contract of ours changes. No findings from an architecture point of view.",
        "Uma atualização menor dentro da mesma versão principal do framework web. Nenhuma fronteira ou contrato nosso muda. Sem achados do ponto de vista de arquitetura.",
      ),
      findings: [],
    },
    staff: {
      statement: L(
        "The version range changed, but the lockfile is not in the diff. That decides what actually gets installed, so this change does not do what its title says.",
        "A faixa de versão mudou, mas o lockfile não está no diff. É ele que decide o que de fato é instalado, então esta mudança não faz o que o título diz.",
      ),
      findings: [
        {
          key: "lockfile-missing",
          severity: "major",
          category: "correctness",
          path: PACKAGE,
          quote: `"express": "^4.21.2",`,
          title: L("package-lock.json was not updated", "package-lock.json não foi atualizado"),
          rationale: L(
            "package.json now asks for ^4.21.2 while the lockfile still pins 4.18.2. npm ci refuses to install when the two disagree, so the pipeline fails; a plain npm install on a developer machine would silently rewrite the lockfile instead.",
            "O package.json agora pede ^4.21.2 enquanto o lockfile ainda fixa 4.18.2. O npm ci se recusa a instalar quando os dois divergem, então o pipeline falha; um npm install na máquina de um desenvolvedor reescreveria o lockfile em silêncio.",
          ),
          recommendation: L("Run npm install and commit the updated package-lock.json in this pull request.", "Rode npm install e faça commit do package-lock.json atualizado neste pull request."),
          principle: L("Reproducible builds", "Builds reprodutíveis"),
        },
      ],
    },
    refactoring: {
      statement: L("One line changed. Nothing to refactor.", "Uma linha mudou. Nada a refatorar."),
      findings: [],
    },
    cleancode: {
      statement: L("No code to review here. I defer to the Staff Engineer on the build.", "Não há código para revisar aqui. Sigo o Staff Engineer quanto ao build."),
      findings: [],
    },
  },
  debate: {
    architect: {
      statement: L("The Staff Engineer is right.", "O Staff Engineer está certo."),
      positions: [
        {
          on: "lockfile-missing",
          stance: "agree",
          argument: L("A dependency change without its lockfile is half a change.", "Uma mudança de dependência sem o lockfile é meia mudança."),
        },
      ],
    },
    staff: { statement: L("Nothing to add.", "Nada a acrescentar."), positions: [] },
    refactoring: {
      statement: L("Agreed.", "De acordo."),
      positions: [{ on: "lockfile-missing", stance: "agree", argument: L("Agreed.", "De acordo.") }],
    },
    cleancode: {
      statement: L("Agreed.", "De acordo."),
      positions: [{ on: "lockfile-missing", stance: "agree", argument: L("The build should not depend on who runs it.", "O build não deve depender de quem o executa.") }],
    },
  },
  implementation: {
    statement: L(
      "I am not going to hand-write a lockfile in a review comment. Run the package manager and commit what it produces.",
      "Não vou escrever um lockfile à mão em um comentário de revisão. Rode o gerenciador de pacotes e faça commit do que ele produzir.",
    ),
    patches: [],
    declined: [
      {
        on: "lockfile-missing",
        reason: L(
          "A lockfile is generated, not written. The fix is one command on the author's machine.",
          "Um lockfile é gerado, não escrito. A correção é um comando na máquina do autor.",
        ),
      },
    ],
  },
  verdict: {
    statement: L("Simple and clear. Requesting one change.", "Simples e claro. Pedindo uma mudança."),
    decision: "request_changes",
    mergeRisk: "medium",
    summary: L(
      "Request changes. The upgrade itself is fine, but the lockfile was not updated, so the pipeline will fail or install the old version. One command fixes it.",
      "Pedir mudanças. A atualização em si está correta, mas o lockfile não foi atualizado, então o pipeline vai falhar ou instalar a versão antiga. Um comando resolve.",
    ),
    humanAttention: [],
  },
};
