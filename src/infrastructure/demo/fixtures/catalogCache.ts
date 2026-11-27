import { L, type CouncilScript, type DemoFile } from "../types.js";

const CLIENT = "src/catalog/CatalogClient.ts";
const CACHE = "src/shared/TtlCache.ts";

const clientBase = `import { HttpClient } from "../shared/http";

export interface Product {
  sku: string;
  name: string;
  unitPrice: number;
}

export class CatalogClient {
  constructor(private readonly http: HttpClient) {}

  async getProduct(sku: string): Promise<Product> {
    return this.http.get<Product>(\`/products/\${sku}\`);
  }
}
`;

const clientHead = `import { HttpClient } from "../shared/http";
import { TtlCache } from "../shared/TtlCache";

export interface Product {
  sku: string;
  name: string;
  unitPrice: number;
}

export class CatalogClient {
  private readonly cache = new TtlCache<Product>(300000);

  constructor(private readonly http: HttpClient) {}

  async getProduct(sku: string): Promise<Product> {
    const cached = this.cache.get(sku);
    if (cached) return cached;
    const product = await this.http.get<Product>(\`/products/\${sku}\`);
    this.cache.set(sku, product);
    return product;
  }
}
`;

const cacheHead = `interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}
`;

const cacheTestHead = `import { TtlCache } from "../../src/shared/TtlCache";

describe("TtlCache", () => {
  it("returns a value until it expires", () => {
    let now = 1000;
    const cache = new TtlCache<string>(50, () => now);
    cache.set("a", "one");
    expect(cache.get("a")).toBe("one");
    now = 1050;
    expect(cache.get("a")).toBeUndefined();
  });

  it("misses unknown keys", () => {
    expect(new TtlCache<string>(50).get("missing")).toBeUndefined();
  });
});
`;

export const catalogCacheFiles: readonly DemoFile[] = [
  { path: CLIENT, base: clientBase, head: clientHead },
  { path: CACHE, base: null, head: cacheHead },
  { path: "tests/shared/TtlCache.test.ts", base: null, head: cacheTestHead },
];

export const catalogCacheScript: CouncilScript = {
  opening: {
    architect: {
      statement: L(
        "The cache sits behind the catalog client, the public interface did not change and the clock is injected, so callers and tests are unaffected. The boundary is respected. I have one question that is about the business more than the code: checkout reads prices through this client.",
        "O cache fica atrás do cliente de catálogo, a interface pública não mudou e o relógio é injetado, então quem chama e os testes não são afetados. A fronteira foi respeitada. Tenho uma pergunta que é mais de negócio do que de código: o checkout lê preços por este cliente.",
      ),
      findings: [
        {
          key: "stale-price",
          severity: "minor",
          category: "architecture",
          path: CLIENT,
          quote: "if (cached) return cached;",
          title: L("Prices can be up to five minutes old at checkout", "Preços podem ter até cinco minutos de atraso no checkout"),
          rationale: L(
            "Product includes unitPrice. After this change a price update takes up to five minutes to reach every instance, and each instance expires at a different moment.",
            "Product inclui unitPrice. Depois desta mudança, uma alteração de preço leva até cinco minutos para chegar a todas as instâncias, e cada instância expira em um momento diferente.",
          ),
          recommendation: L(
            "Confirm with the product owner that this is acceptable, or have checkout confirm the price when the order is placed.",
            "Confirme com o responsável pelo produto que isso é aceitável, ou faça o checkout confirmar o preço no momento do pedido.",
          ),
          principle: L("Consistency is a business decision", "Consistência é uma decisão de negócio"),
        },
      ],
    },
    staff: {
      statement: L(
        "Correct and well tested for what it does. The only thing I would change before this sees production traffic is that the map never shrinks unless a key is read again.",
        "Correto e bem testado para o que faz. A única coisa que eu mudaria antes de receber tráfego de produção é que o mapa nunca diminui a menos que uma chave seja lida de novo.",
      ),
      findings: [
        {
          key: "unbounded-cache",
          severity: "minor",
          category: "performance",
          path: CACHE,
          quote: "private readonly entries = new Map<string, Entry<T>>();",
          title: L("Cache grows without limit", "O cache cresce sem limite"),
          rationale: L(
            "Expired entries are only removed when the same key is requested again. A SKU that is looked up once stays in memory for the life of the process, so memory grows with the size of the catalog.",
            "Entradas expiradas só são removidas quando a mesma chave é pedida de novo. Um SKU consultado uma vez fica na memória enquanto o processo viver, então a memória cresce com o tamanho do catálogo.",
          ),
          recommendation: L("Cap the number of entries and drop the oldest one when the cap is reached.", "Limite o número de entradas e descarte a mais antiga quando o limite for atingido."),
          principle: L("Every cache needs a bound", "Todo cache precisa de um limite"),
        },
      ],
    },
    refactoring: {
      statement: L(
        "Small, cohesive, and the new class has one reason to exist. The test controls time instead of sleeping. This is what a healthy change looks like and I have no findings.",
        "Pequeno, coeso, e a nova classe tem uma única razão para existir. O teste controla o tempo em vez de dormir. É assim que uma mudança saudável se parece, e não tenho achados.",
      ),
      findings: [],
    },
    cleancode: {
      statement: L("Clean and readable. One literal deserves a name.", "Limpo e legível. Um literal merece um nome."),
      findings: [
        {
          key: "magic-ttl",
          severity: "nit",
          category: "readability",
          path: CLIENT,
          quote: "private readonly cache = new TtlCache<Product>(300000);",
          title: L("Unnamed time-to-live literal", "Literal de tempo de vida sem nome"),
          rationale: L("300000 does not say five minutes, and it does not say why five.", "300000 não diz cinco minutos, e não diz por que cinco."),
          recommendation: L("Extract a named constant such as PRODUCT_TTL_MS = 5 * 60 * 1000.", "Extraia uma constante nomeada como PRODUCT_TTL_MS = 5 * 60 * 1000."),
          principle: L("Replace Magic Number with Named Constant", "Substituir Número Mágico por Constante Nomeada"),
        },
      ],
    },
  },
  debate: {
    architect: {
      statement: L("Nothing here blocks the merge.", "Nada aqui bloqueia o merge."),
      positions: [
        { on: "unbounded-cache", stance: "agree", argument: L("A bound keeps memory predictable per instance.", "Um limite mantém a memória previsível por instância.") },
        { on: "magic-ttl", stance: "agree", argument: L("The name also gives the business rule a place to be found.", "O nome também dá à regra de negócio um lugar para ser encontrada.") },
      ],
    },
    staff: {
      statement: L("The price question is real, and it is the kind a human should answer.", "A pergunta sobre preço é real, e é do tipo que um humano deve responder."),
      positions: [
        {
          on: "stale-price",
          stance: "refine",
          argument: L(
            "Acceptable for browsing. At order time the price should be confirmed against the source, which is outside this change.",
            "Aceitável para navegação. No momento do pedido o preço deve ser confirmado na origem, o que está fora desta mudança.",
          ),
        },
        { on: "magic-ttl", stance: "agree", argument: L("Agreed.", "De acordo.") },
      ],
    },
    refactoring: {
      statement: L("Agree with the bound, as long as it stays as simple as the class.", "Concordo com o limite, desde que continue tão simples quanto a classe."),
      positions: [
        {
          on: "unbounded-cache",
          stance: "refine",
          argument: L(
            "A size cap in a few lines is enough. Do not bring in an LRU library for this.",
            "Um limite de tamanho em poucas linhas basta. Não traga uma biblioteca de LRU para isso.",
          ),
        },
        { on: "magic-ttl", stance: "agree", argument: L("Replace Magic Literal.", "Substituir Literal Mágico.") },
        { on: "stale-price", stance: "agree", argument: L("Worth asking before it surprises someone.", "Vale perguntar antes que surpreenda alguém.") },
      ],
    },
    cleancode: {
      statement: L("Approve from my side.", "Aprovado da minha parte."),
      positions: [
        { on: "unbounded-cache", stance: "agree", argument: L("Agreed.", "De acordo.") },
        { on: "stale-price", stance: "agree", argument: L("Agreed.", "De acordo.") },
      ],
    },
  },
  implementation: {
    statement: L(
      "Good change. Two small patches: a cap on the cache using the map's own insertion order, and a name for the number. The stale price is not something code review can answer.",
      "Boa mudança. Dois patches pequenos: um limite no cache usando a própria ordem de inserção do mapa, e um nome para o número. O preço desatualizado não é algo que revisão de código consiga responder.",
    ),
    patches: [
      {
        fixes: ["unbounded-cache"],
        path: CACHE,
        original: `    private readonly now: () => number = Date.now,
  ) {}`,
        replacement: `    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}`,
        explanation: L("A default bound; callers do not change.", "Um limite padrão; quem chama não muda."),
      },
      {
        fixes: ["unbounded-cache"],
        path: CACHE,
        original: `  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }`,
        replacement: `  set(key: string, value: T): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      // A Map iterates in insertion order, so the first key is the oldest.
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }`,
        explanation: L("Drops the oldest entry when full. No library, no timers.", "Descarta a entrada mais antiga quando enche. Sem biblioteca, sem timers."),
      },
      {
        fixes: ["magic-ttl"],
        path: CLIENT,
        original: `export class CatalogClient {
  private readonly cache = new TtlCache<Product>(300000);`,
        replacement: `const PRODUCT_TTL_MS = 5 * 60 * 1000;

export class CatalogClient {
  private readonly cache = new TtlCache<Product>(PRODUCT_TTL_MS);`,
        explanation: L("The number now says what it means.", "O número agora diz o que significa."),
      },
    ],
    declined: [
      {
        on: "stale-price",
        reason: L("Not a code problem. The product owner decides how old a price may be.", "Não é problema de código. O responsável pelo produto decide quão antigo um preço pode ser."),
      },
    ],
  },
  verdict: {
    statement: L("An easy one. Approving.", "Este é fácil. Aprovando."),
    decision: "approve",
    mergeRisk: "low",
    summary: L(
      "Approve. A small, cohesive change with tests. The council raised three low-severity findings, all endorsed; two have ready patches and the third is a product question.",
      "Aprovado. Uma mudança pequena, coesa e com testes. O conselho levantou três achados de baixa severidade, todos endossados; dois têm patch pronto e o terceiro é uma pergunta de produto.",
    ),
    humanAttention: [
      L(
        "Product decision: prices may be up to five minutes old when read through this client. Confirm that this is acceptable at checkout.",
        "Decisão de produto: preços podem ter até cinco minutos de atraso quando lidos por este cliente. Confirme que isso é aceitável no checkout.",
      ),
    ],
  },
};
