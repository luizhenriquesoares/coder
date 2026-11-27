import { L, type CouncilScript } from "../types.js";

const SERVICE = "src/checkout/CheckoutService.ts";
const REPOSITORY = "src/checkout/coupons/CouponRepository.ts";
const COUPON = "src/checkout/coupons/Coupon.ts";
const CONTROLLER = "src/api/checkoutController.ts";
const MIGRATION = "migrations/20260112_add_coupons.sql";
const TEST = "tests/checkout/CheckoutService.test.ts";

export const couponScript: CouncilScript = {
  opening: {
    architect: {
      statement: L(
        "The feature is small but it crosses three boundaries: the checkout use case, the coupon rules and persistence. Today all three live inside placeOrder. The service builds its own Postgres repository, the rules about when a coupon is valid sit in the use case instead of in the coupon, and the schema does not protect the one invariant the code relies on. I raised three structural findings and one option for decoupling redemption.",
        "A funcionalidade é pequena, mas atravessa três fronteiras: o caso de uso de checkout, as regras de cupom e a persistência. Hoje as três vivem dentro de placeOrder. O serviço constrói o próprio repositório Postgres, as regras de validade do cupom estão no caso de uso em vez de estarem no cupom, e o schema não protege a invariante da qual o código depende. Levantei três achados estruturais e uma opção para desacoplar o resgate.",
      ),
      findings: [
        {
          key: "hidden-dependency",
          severity: "major",
          category: "architecture",
          path: SERVICE,
          quote: "const repo = new PostgresCouponRepository(db);",
          title: L("Use case instantiates its own infrastructure", "Caso de uso instancia a própria infraestrutura"),
          rationale: L(
            "CheckoutService receives orders and payments through its constructor, but creates PostgresCouponRepository and reaches for the global db inside the method. The dependency points from policy to mechanism, it is invisible in the constructor, and it cannot be replaced in a test or by another store.",
            "CheckoutService recebe orders e payments pelo construtor, mas cria PostgresCouponRepository e usa o db global dentro do método. A dependência aponta da política para o mecanismo, é invisível no construtor e não pode ser trocada em teste nem por outro armazenamento.",
          ),
          recommendation: L(
            "Declare a CouponRepository port and inject it through the constructor, like the other two collaborators.",
            "Declare uma porta CouponRepository e injete pelo construtor, como os outros dois colaboradores.",
          ),
          principle: L("Dependency Inversion / Ports & Adapters", "Inversão de Dependência / Portas e Adaptadores"),
        },
        {
          key: "anemic-coupon",
          severity: "major",
          category: "design",
          path: COUPON,
          quote: "export interface Coupon {",
          title: L("Coupon rules live outside the Coupon", "As regras do cupom vivem fora do Cupom"),
          rationale: L(
            "Coupon is a bag of fields. Whether it is expired, whether it still has uses and how much it discounts are decided inside the checkout use case. Any other entry point (cart preview, admin, a future subscription flow) will have to copy those rules.",
            "Coupon é um saco de campos. Se está expirado, se ainda tem usos e quanto desconta são decisões tomadas dentro do caso de uso de checkout. Qualquer outro ponto de entrada (prévia do carrinho, admin, uma futura assinatura) terá de copiar essas regras.",
          ),
          recommendation: L(
            "Give the coupon its behaviour: isRedeemable(now) and discountFor(subtotal). The use case asks, the coupon answers.",
            "Dê comportamento ao cupom: isRedeemable(now) e discountFor(subtotal). O caso de uso pergunta, o cupom responde.",
          ),
          principle: L("Rich domain model / Tell, don't ask", "Modelo de domínio rico / Tell, don't ask"),
        },
        {
          key: "missing-unique",
          severity: "major",
          category: "correctness",
          path: MIGRATION,
          quote: "code VARCHAR(64) NOT NULL,",
          title: L("Schema does not enforce unique coupon codes", "O schema não garante códigos de cupom únicos"),
          rationale: L(
            "The lookup uses LIMIT 1, which means the code assumes one coupon per code, but nothing in the table guarantees it. Two rows with the same code make the result arbitrary. expires_at is also TIMESTAMP without time zone, so expiry depends on the server's clock setting.",
            "A consulta usa LIMIT 1, ou seja, o código assume um cupom por código, mas nada na tabela garante isso. Duas linhas com o mesmo código tornam o resultado arbitrário. Além disso, expires_at é TIMESTAMP sem fuso, então a expiração depende da configuração de relógio do servidor.",
          ),
          recommendation: L(
            "Add UNIQUE to code and use TIMESTAMPTZ for expires_at. Consider CHECK (used_count <= max_uses) as a last line of defence.",
            "Adicione UNIQUE em code e use TIMESTAMPTZ em expires_at. Considere CHECK (used_count <= max_uses) como última linha de defesa.",
          ),
          principle: L("Make invariants explicit in the schema", "Torne as invariantes explícitas no schema"),
        },
        {
          key: "event-driven-redemption",
          severity: "minor",
          category: "architecture",
          path: SERVICE,
          quote: "await repo.incrementUsage(c.id, c.usedCount + 1);",
          title: L("Publish CouponRedeemed through an outbox instead of updating inline", "Publicar CouponRedeemed via outbox em vez de atualizar inline"),
          rationale: L(
            "Redemption is a fact other contexts will care about (marketing, fraud, analytics). Updating a counter inline couples checkout to the coupon table. An outbox event would let a coupon service own the counter.",
            "O resgate é um fato que interessa a outros contextos (marketing, fraude, analytics). Atualizar um contador inline acopla o checkout à tabela de cupons. Um evento em outbox deixaria um serviço de cupons ser dono do contador.",
          ),
          recommendation: L(
            "Emit a CouponRedeemed domain event from checkout and let a consumer update usage asynchronously.",
            "Emita um evento de domínio CouponRedeemed no checkout e deixe um consumidor atualizar o uso de forma assíncrona.",
          ),
          principle: L("Event-driven integration", "Integração orientada a eventos"),
        },
      ],
    },
    staff: {
      statement: L(
        "I traced the three inputs an attacker or an unlucky customer controls: the coupon code, the cart value and timing. Each one breaks something. The code is concatenated into SQL. Any code that produces no discount still zeroes shipping. Two simultaneous checkouts can both spend the last use of a coupon, and a fixed coupon above the subtotal produces a negative charge. Two of these are blockers.",
        "Rastreei as três entradas que um atacante ou um cliente azarado controla: o código do cupom, o valor do carrinho e o tempo. Cada uma quebra alguma coisa. O código é concatenado no SQL. Qualquer código que não gere desconto ainda zera o frete. Dois checkouts simultâneos conseguem gastar o último uso do mesmo cupom, e um cupom fixo maior que o subtotal gera cobrança negativa. Dois desses são bloqueantes.",
      ),
      findings: [
        {
          key: "sql-injection",
          severity: "blocker",
          category: "security",
          path: REPOSITORY,
          quote: `"SELECT * FROM coupons WHERE code = '" + code + "' LIMIT 1",`,
          title: L("SQL injection through the coupon code", "SQL injection pelo código do cupom"),
          rationale: L(
            "couponCode comes straight from req.body and is concatenated into the query. A code such as ' OR '1'='1 returns the first coupon in the table; stacked queries can read or rewrite any table the application user can reach.",
            "couponCode vem direto de req.body e é concatenado na consulta. Um código como ' OR '1'='1 devolve o primeiro cupom da tabela; consultas empilhadas conseguem ler ou reescrever qualquer tabela que o usuário da aplicação alcance.",
          ),
          recommendation: L(
            "Use a parameterised query ($1) here and in incrementUsage. Never build SQL from request data.",
            "Use consulta parametrizada ($1) aqui e em incrementUsage. Nunca monte SQL com dados da requisição.",
          ),
          principle: L("OWASP A03: Injection", "OWASP A03: Injeção"),
        },
        {
          key: "free-shipping-bug",
          severity: "blocker",
          category: "correctness",
          path: SERVICE,
          quote: "const shipping = subtotal >= 200 || (couponCode && d === 0) ? 0 : 15;",
          title: L("Any invalid coupon code gives free shipping", "Qualquer código de cupom inválido dá frete grátis"),
          rationale: L(
            "Free shipping is inferred from \"a code was sent and the discount is zero\". That is also true for an unknown code, an expired coupon and an exhausted coupon. Typing any text in the coupon field removes the shipping charge.",
            "O frete grátis é inferido de \"veio um código e o desconto é zero\". Isso também é verdade para código inexistente, cupom expirado e cupom esgotado. Digitar qualquer texto no campo de cupom remove a cobrança de frete.",
          ),
          recommendation: L(
            "Decide free shipping from the coupon type of a coupon that was actually found and is redeemable. Reject invalid codes with an error the customer can see.",
            "Decida o frete grátis pelo tipo de um cupom que foi de fato encontrado e é resgatável. Rejeite códigos inválidos com um erro visível para o cliente.",
          ),
          principle: L("Make illegal states unrepresentable", "Torne estados ilegais irrepresentáveis"),
        },
        {
          key: "coupon-race",
          severity: "major",
          category: "concurrency",
          path: SERVICE,
          quote: "await repo.incrementUsage(c.id, c.usedCount + 1);",
          title: L("Coupon usage is a lost-update race", "O uso do cupom sofre condição de corrida (lost update)"),
          rationale: L(
            "The service reads usedCount, compares it in memory and writes usedCount + 1. Two concurrent checkouts read the same value, both pass the limit check and both write the same number: a single-use coupon is spent twice and the counter shows one use. The use is also taken before the payment is attempted.",
            "O serviço lê usedCount, compara em memória e grava usedCount + 1. Dois checkouts concorrentes leem o mesmo valor, ambos passam na checagem de limite e ambos gravam o mesmo número: um cupom de uso único é gasto duas vezes e o contador mostra um uso. O uso também é consumido antes da tentativa de pagamento.",
          ),
          recommendation: L(
            "Redeem with one atomic statement: UPDATE … SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses, and check that a row was updated.",
            "Resgate com um único comando atômico: UPDATE … SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses, e confira se uma linha foi atualizada.",
          ),
          principle: L("Atomic check-and-set", "Check-and-set atômico"),
        },
        {
          key: "negative-total",
          severity: "major",
          category: "correctness",
          path: SERVICE,
          quote: "const total = subtotal - d + shipping;",
          title: L("Total can be negative or carry fractional cents", "O total pode ficar negativo ou com frações de centavo"),
          rationale: L(
            "A fixed coupon of 50 on a subtotal of 30 produces total = -5 and that value goes to payments.charge. A percent coupon uses floating point: 33.333% of 99.99 is 33.3296667, a value no payment gateway accepts consistently.",
            "Um cupom fixo de 50 em um subtotal de 30 gera total = -5, e esse valor vai para payments.charge. O cupom percentual usa ponto flutuante: 33,333% de 99,99 é 33,3296667, um valor que nenhum gateway de pagamento aceita de forma consistente.",
          ),
          recommendation: L(
            "Clamp the discount at the subtotal and round it to cents in one place.",
            "Limite o desconto ao subtotal e arredonde para centavos em um único lugar.",
          ),
          principle: L("Validate money at the boundary", "Valide dinheiro na fronteira"),
        },
        {
          key: "token-in-logs",
          severity: "major",
          category: "security",
          path: CONTROLLER,
          quote: `console.log("checkout request", req.body);`,
          title: L("Payment token written to logs", "Token de pagamento gravado nos logs"),
          rationale: L(
            "req.body contains paymentToken. Logging the whole body copies a payment credential into every log sink and retention policy the company has, which is a PCI finding by itself.",
            "req.body contém paymentToken. Logar o corpo inteiro copia uma credencial de pagamento para todos os destinos de log e políticas de retenção da empresa, o que por si só é um achado de PCI.",
          ),
          recommendation: L("Remove the line. If the request must be logged, log an allow-list of fields.", "Remova a linha. Se a requisição precisar ser logada, logue uma lista explícita de campos permitidos."),
          principle: L("Never log secrets", "Nunca logue segredos"),
        },
        {
          key: "thin-tests",
          severity: "minor",
          category: "testing",
          path: TEST,
          quote: `it("applies a percent coupon", async () => {`,
          title: L("Only the happy path of money code is tested", "Só o caminho feliz do código de dinheiro é testado"),
          rationale: L(
            "One test covers a valid percent coupon. Nothing covers an unknown code, an expired or exhausted coupon, a fixed coupon above the subtotal or free shipping. Every bug the council found lives in an untested branch.",
            "Um teste cobre um cupom percentual válido. Nada cobre código inexistente, cupom expirado ou esgotado, cupom fixo acima do subtotal ou frete grátis. Todo bug que o conselho encontrou vive em um ramo sem teste.",
          ),
          recommendation: L(
            "Add one test per rule before fixing: unknown, expired, exhausted, fixed above subtotal, free shipping.",
            "Adicione um teste por regra antes de corrigir: inexistente, expirado, esgotado, fixo acima do subtotal, frete grátis.",
          ),
          principle: L("Test the boundaries, not the brochure", "Teste as fronteiras, não o folheto"),
        },
      ],
    },
    refactoring: {
      statement: L(
        "The diff shows a method that grew by accretion. placeOrder now nests four conditionals deep and its variables are single letters, so a reader has to simulate the code to learn what it does. None of this needs a redesign. A few named refactorings in small steps, each one keeping the tests green, will make the bugs my colleagues found visible in plain sight.",
        "O diff mostra um método que cresceu por acúmulo. placeOrder agora aninha quatro condicionais e suas variáveis são letras soltas, então o leitor precisa simular o código para saber o que ele faz. Nada disso pede um redesenho. Algumas refatorações nomeadas em passos pequenos, cada uma mantendo os testes verdes, deixam à vista os bugs que meus colegas encontraram.",
      ),
      findings: [
        {
          key: "arrow-code",
          severity: "minor",
          category: "maintainability",
          path: SERVICE,
          quote: "if (c.expiresAt > new Date()) {",
          title: L("Four levels of nested conditionals", "Quatro níveis de condicionais aninhadas"),
          rationale: L(
            "The valid path is buried at the deepest indentation and the failure paths are implicit: an expired coupon and a missing coupon both silently fall through with d = 0. That silence is where the free-shipping bug hides.",
            "O caminho válido está enterrado na indentação mais profunda e os caminhos de falha são implícitos: cupom expirado e cupom inexistente caem em silêncio com d = 0. É nesse silêncio que o bug do frete grátis se esconde.",
          ),
          recommendation: L(
            "Replace Nested Conditional with Guard Clauses, then Extract Function for the discount calculation.",
            "Substituir Condicional Aninhada por Cláusulas de Guarda e depois Extrair Função para o cálculo do desconto.",
          ),
          principle: L("Replace Nested Conditional with Guard Clauses", "Substituir Condicional Aninhada por Cláusulas de Guarda"),
        },
        {
          key: "primitive-money",
          severity: "minor",
          category: "design",
          path: SERVICE,
          quote: "d = subtotal * (c.value / 100);",
          title: L("Money handled as a bare floating-point number", "Dinheiro tratado como número de ponto flutuante"),
          rationale: L(
            "Prices, discounts and totals are plain numbers, so rounding rules are wherever someone remembered to put them, which today is nowhere.",
            "Preços, descontos e totais são números puros, então as regras de arredondamento ficam onde alguém lembrou de colocar, o que hoje é lugar nenhum.",
          ),
          recommendation: L(
            "Short term: round in the one function that computes the discount. Later: introduce a Money value object where it pays for itself.",
            "Curto prazo: arredonde na única função que calcula o desconto. Depois: introduza um objeto de valor Money onde ele se pagar.",
          ),
          principle: L("Primitive Obsession", "Obsessão por Primitivos"),
        },
        {
          key: "mysterious-names",
          severity: "nit",
          category: "naming",
          path: SERVICE,
          quote: "let d = 0;",
          title: L("Single-letter names for domain concepts", "Nomes de uma letra para conceitos do domínio"),
          rationale: L("d, c, repo and e carry the whole feature. The reader has to keep a glossary in their head.", "d, c, repo e e carregam a funcionalidade inteira. O leitor precisa manter um glossário na cabeça."),
          recommendation: L("Rename Variable: discount, coupon.", "Renomear Variável: discount, coupon."),
          principle: L("Mysterious Name", "Nome Misterioso"),
        },
        {
          key: "jest-module-mock",
          severity: "minor",
          category: "testing",
          path: TEST,
          quote: `jest.mock("../../src/checkout/coupons/CouponRepository", () => ({`,
          title: L("The test has to mock a module path", "O teste precisa mockar um caminho de módulo"),
          rationale: L(
            "The test replaces a whole module by file path because the service gives it no seam. When a test is this awkward, it is reporting a design problem, not a testing problem.",
            "O teste substitui um módulo inteiro pelo caminho do arquivo porque o serviço não oferece nenhuma costura. Quando um teste fica assim desajeitado, ele está relatando um problema de design, não de teste.",
          ),
          recommendation: L("Inject the repository; the test then passes a plain object and jest.mock disappears.", "Injete o repositório; o teste passa um objeto simples e o jest.mock desaparece."),
          principle: L("Listen to the tests", "Escute os testes"),
        },
      ],
    },
    cleancode: {
      statement: L(
        "A function should do one thing. placeOrder validates the cart, looks up a coupon, decides if it is valid, computes a discount, mutates a counter, prices shipping, charges a card and stores an order. It also ignores an exception. The if/else chain on the coupon type means every new kind of coupon reopens this method. I want the type dispatch behind an abstraction and the empty catch gone before this merges.",
        "Uma função deve fazer uma coisa só. placeOrder valida o carrinho, busca um cupom, decide se é válido, calcula desconto, altera um contador, calcula frete, cobra um cartão e grava um pedido. Ainda ignora uma exceção. A cadeia if/else sobre o tipo do cupom significa que todo tipo novo de cupom reabre esse método. Quero o despacho por tipo atrás de uma abstração e o catch vazio removido antes do merge.",
      ),
      findings: [
        {
          key: "ocp-coupon-types",
          severity: "major",
          category: "design",
          path: SERVICE,
          quote: `if (c.type === "percent") {`,
          title: L("Type switch violates the Open/Closed Principle", "Switch por tipo viola o Princípio Aberto/Fechado"),
          rationale: L(
            "Each coupon type is a branch inside the checkout use case. Adding buy-one-get-one or a tiered coupon means editing and retesting placeOrder, the most sensitive method in the system.",
            "Cada tipo de cupom é um ramo dentro do caso de uso de checkout. Adicionar leve-dois-pague-um ou um cupom por faixas significa editar e retestar placeOrder, o método mais sensível do sistema.",
          ),
          recommendation: L(
            "Introduce a DiscountPolicy interface with one implementation per coupon type and select it by type. New types become new classes, not new branches.",
            "Introduza uma interface DiscountPolicy com uma implementação por tipo de cupom e selecione pelo tipo. Tipos novos viram classes novas, não ramos novos.",
          ),
          principle: L("Open/Closed Principle (Strategy)", "Princípio Aberto/Fechado (Strategy)"),
        },
        {
          key: "empty-catch",
          severity: "major",
          category: "error_handling",
          path: SERVICE,
          quote: "} catch (e) {}",
          title: L("Exception swallowed by an empty catch", "Exceção engolida por um catch vazio"),
          rationale: L(
            "If recording the redemption fails, the customer still gets the discount and nobody ever knows. The one operation that protects the coupon budget is the one whose failure is hidden.",
            "Se o registro do resgate falhar, o cliente ainda recebe o desconto e ninguém fica sabendo. A única operação que protege o orçamento de cupons é justamente aquela cuja falha é escondida.",
          ),
          recommendation: L("Remove the try/catch and let the failure abort the order, or handle it explicitly.", "Remova o try/catch e deixe a falha abortar o pedido, ou trate de forma explícita."),
          principle: L("Don't ignore caught errors", "Não ignore erros capturados"),
        },
        {
          key: "srp-place-order",
          severity: "minor",
          category: "design",
          path: SERVICE,
          quote: "async placeOrder(request: PlaceOrderRequest): Promise<Order> {",
          title: L("placeOrder mixes several levels of abstraction", "placeOrder mistura vários níveis de abstração"),
          rationale: L(
            "The method jumps from business steps (charge, create order) to details (percent arithmetic, counter updates). It has more than one reason to change.",
            "O método salta de passos de negócio (cobrar, criar pedido) para detalhes (aritmética de percentual, atualização de contador). Ele tem mais de um motivo para mudar.",
          ),
          recommendation: L(
            "Keep placeOrder as a short story of named steps and move the details below it.",
            "Mantenha placeOrder como uma história curta de passos nomeados e mova os detalhes para baixo.",
          ),
          principle: L("Single Responsibility / one level of abstraction per function", "Responsabilidade Única / um nível de abstração por função"),
        },
      ],
    },
  },

  debate: {
    architect: {
      statement: L(
        "Agreed on both blockers. On coupon types I think the two schools are arguing about timing, not direction: put the discount rule on the coupon now so there is one place to change, and split it into policies when a type needs its own data.",
        "De acordo com os dois bloqueantes. Sobre tipos de cupom, acho que as duas escolas discutem o momento, não a direção: coloque a regra de desconto no cupom agora para haver um único lugar de mudança, e separe em políticas quando um tipo precisar de dados próprios.",
      ),
      positions: [
        { on: "sql-injection", stance: "agree", argument: L("Blocker. Parameterised queries are not negotiable in the persistence layer.", "Bloqueante. Consultas parametrizadas não são negociáveis na camada de persistência.") },
        {
          on: "free-shipping-bug",
          stance: "agree",
          argument: L(
            "The root cause is a modelling shortcut: free shipping is represented as \"discount is zero\". Model it as an explicit outcome of the coupon.",
            "A causa raiz é um atalho de modelagem: frete grátis é representado como \"desconto é zero\". Modele como um resultado explícito do cupom.",
          ),
        },
        {
          on: "coupon-race",
          stance: "refine",
          argument: L(
            "Agree, and the order of operations matters: if the use is taken before the charge and the charge fails, the coupon is burned. Decide the transaction boundary with the payment explicitly.",
            "Concordo, e a ordem das operações importa: se o uso é consumido antes da cobrança e a cobrança falha, o cupom é queimado. Decida de forma explícita a fronteira de transação com o pagamento.",
          ),
        },
        { on: "token-in-logs", stance: "agree", argument: L("Logging belongs behind an allow-list at the edge.", "O log deve ficar atrás de uma lista de permitidos na borda.") },
        {
          on: "ocp-coupon-types",
          stance: "refine",
          argument: L(
            "Right direction, early timing. A discountFor() on the coupon gives a single point of change today. Promote it to policies when the third rule with its own data arrives.",
            "Direção certa, momento adiantado. Um discountFor() no cupom dá um único ponto de mudança hoje. Promova para políticas quando chegar a terceira regra com dados próprios.",
          ),
        },
        { on: "srp-place-order", stance: "agree", argument: L("The use case should read as orchestration only.", "O caso de uso deve ser lido apenas como orquestração.") },
        { on: "jest-module-mock", stance: "agree", argument: L("Same root cause as the hidden dependency.", "Mesma causa raiz da dependência escondida.") },
      ],
    },
    staff: {
      statement: L(
        "I support the structural findings because they make the bugs harder to write again. I do not support a class hierarchy for three branches, and I do not support an asynchronous counter: eventual consistency is the opposite of what a usage limit needs.",
        "Apoio os achados estruturais porque eles dificultam reescrever os mesmos bugs. Não apoio uma hierarquia de classes para três ramos, e não apoio um contador assíncrono: consistência eventual é o oposto do que um limite de uso precisa.",
      ),
      positions: [
        { on: "hidden-dependency", stance: "agree", argument: L("It is also the reason the test needs jest.mock on a path.", "É também o motivo de o teste precisar de jest.mock em um caminho.") },
        {
          on: "anemic-coupon",
          stance: "refine",
          argument: L(
            "Move validity and discount into the coupon, yes. Keep the usage limit in the database statement: an in-memory check is exactly the race I reported.",
            "Mover validade e desconto para o cupom, sim. Mantenha o limite de uso no comando do banco: uma checagem em memória é exatamente a corrida que reportei.",
          ),
        },
        { on: "missing-unique", stance: "agree", argument: L("LIMIT 1 without UNIQUE returns an arbitrary row. The CHECK constraint is a cheap backstop for the race.", "LIMIT 1 sem UNIQUE devolve uma linha arbitrária. A constraint CHECK é uma proteção barata para a corrida.") },
        {
          on: "event-driven-redemption",
          stance: "disagree",
          argument: L(
            "An asynchronous consumer makes the limit eventually consistent. The window in which a single-use coupon can be spent many times goes from milliseconds to however long the queue is behind.",
            "Um consumidor assíncrono torna o limite eventualmente consistente. A janela em que um cupom de uso único pode ser gasto várias vezes sai de milissegundos para o tempo de atraso da fila.",
          ),
        },
        {
          on: "ocp-coupon-types",
          stance: "disagree",
          argument: L(
            "Three branches, two of them one line long. None of the defects are in the dispatch, and a Strategy adds four files without fixing one blocker.",
            "Três ramos, dois deles de uma linha. Nenhum defeito está no despacho, e um Strategy adiciona quatro arquivos sem corrigir um único bloqueante.",
          ),
        },
        { on: "empty-catch", stance: "agree", argument: L("It hides the failure that matters most.", "Ele esconde a falha que mais importa.") },
        { on: "primitive-money", stance: "agree", argument: L("I would raise it to major: we send fractional cents to the gateway today.", "Eu subiria para grave: hoje enviamos frações de centavo ao gateway.") },
        { on: "arrow-code", stance: "agree", argument: L("Guard clauses would have made the free-shipping bug obvious.", "Cláusulas de guarda teriam deixado o bug do frete grátis óbvio.") },
        {
          on: "mysterious-names",
          stance: "disagree",
          argument: L(
            "True, but renames mixed into a security fix make the fix harder to verify. Do it in the same patch that rewrites the block or not in this PR.",
            "Verdade, mas renomeações misturadas a uma correção de segurança dificultam verificar a correção. Faça no mesmo patch que reescreve o bloco ou fora deste PR.",
          ),
        },
      ],
    },
    refactoring: {
      statement: L(
        "I disagree with my Clean Code colleague on one point, and it is worth being clear about why. A conditional with three short branches is not yet a smell that pays for polymorphism. Extract the function today. The day a fourth type arrives, or one type needs its own data, Replace Conditional with Polymorphism becomes a twenty-minute refactoring because the code is already in one place. Design is something we evolve from evidence, not something we predict.",
        "Discordo do meu colega do Clean Code em um ponto, e vale deixar claro o motivo. Uma condicional com três ramos curtos ainda não é um smell que pague por polimorfismo. Extraia a função hoje. No dia em que chegar um quarto tipo, ou um tipo precisar de dados próprios, Substituir Condicional por Polimorfismo vira uma refatoração de vinte minutos porque o código já está em um só lugar. Design é algo que evoluímos a partir de evidência, não algo que prevemos.",
      ),
      positions: [
        { on: "sql-injection", stance: "agree", argument: L("Nothing to debate.", "Nada a debater.") },
        {
          on: "free-shipping-bug",
          stance: "agree",
          argument: L("And the fix falls out naturally once free shipping is an explicit result instead of d === 0.", "E a correção sai naturalmente quando frete grátis vira um resultado explícito em vez de d === 0."),
        },
        { on: "negative-total", stance: "agree", argument: L("One extracted function is the natural home for the clamp and the rounding.", "Uma função extraída é o lar natural do limite e do arredondamento.") },
        { on: "hidden-dependency", stance: "agree", argument: L("The jest.mock in the test is this smell's shadow.", "O jest.mock no teste é a sombra desse smell.") },
        { on: "anemic-coupon", stance: "agree", argument: L("Feature Envy: the behaviour wants to live next to the data it uses. Move Function.", "Feature Envy: o comportamento quer morar junto dos dados que usa. Mover Função.") },
        {
          on: "event-driven-redemption",
          stance: "disagree",
          argument: L("Speculative Generality. No consumer exists; we would be building a queue for an audience of zero.", "Generalidade Especulativa. Não existe consumidor; estaríamos construindo uma fila para uma plateia de zero."),
        },
        {
          on: "ocp-coupon-types",
          stance: "disagree",
          argument: L(
            "YAGNI. Three cases in one extracted function are easy to read and easy to change. Introduce the hierarchy when the code asks for it.",
            "YAGNI. Três casos em uma função extraída são fáceis de ler e de mudar. Introduza a hierarquia quando o código pedir.",
          ),
        },
        { on: "empty-catch", stance: "agree", argument: L("Agreed without reservation.", "De acordo, sem ressalvas.") },
        {
          on: "srp-place-order",
          stance: "refine",
          argument: L(
            "This is my guard-clauses finding seen from above. Two Extract Function steps and the levels of abstraction separate by themselves.",
            "Este é o meu achado das cláusulas de guarda visto de cima. Dois passos de Extrair Função e os níveis de abstração se separam sozinhos.",
          ),
        },
      ],
    },
    cleancode: {
      statement: L(
        "I hear the YAGNI argument and I will not block on it, but I record my dissent: the cheapest moment to introduce the abstraction is when there are three cases and good tests, not when there are seven and none. On tests I go further than the Staff Engineer. Untested money code is not a minor issue.",
        "Ouço o argumento do YAGNI e não vou bloquear por ele, mas registro minha dissidência: o momento mais barato para introduzir a abstração é quando há três casos e bons testes, não quando há sete e nenhum. Sobre testes vou além do Staff Engineer. Código de dinheiro sem teste não é um problema menor.",
      ),
      positions: [
        { on: "sql-injection", stance: "agree", argument: L("Blocker.", "Bloqueante.") },
        {
          on: "free-shipping-bug",
          stance: "agree",
          argument: L("A boolean expression nobody can read is a defect waiting to ship. Give the condition a name.", "Uma expressão booleana que ninguém consegue ler é um defeito esperando para ir a produção. Dê um nome à condição."),
        },
        { on: "coupon-race", stance: "agree", argument: L("And the swallowed exception hides it when it happens.", "E a exceção engolida esconde quando acontece.") },
        {
          on: "hidden-dependency",
          stance: "agree",
          argument: L("Dependency Inversion: the policy must not know the mechanism.", "Inversão de Dependência: a política não deve conhecer o mecanismo."),
        },
        { on: "missing-unique", stance: "agree", argument: L("The schema should say what the code assumes.", "O schema deve dizer o que o código assume.") },
        {
          on: "event-driven-redemption",
          stance: "disagree",
          argument: L("More moving parts than the problem has. Solve the counter first.", "Mais partes móveis do que o problema tem. Resolva o contador primeiro."),
        },
        { on: "arrow-code", stance: "agree", argument: L("Indentation depth is a direct measure of how hard this is to read.", "A profundidade de indentação é uma medida direta de quão difícil é ler isso.") },
        { on: "primitive-money", stance: "agree", argument: L("Agreed.", "De acordo.") },
        { on: "mysterious-names", stance: "agree", argument: L("Names should reveal intent. d and c reveal nothing.", "Nomes devem revelar intenção. d e c não revelam nada.") },
        {
          on: "thin-tests",
          stance: "agree",
          argument: L(
            "I would raise this to major. I want the failing tests written first: expired, exhausted, unknown, fixed above subtotal.",
            "Eu subiria para grave. Quero os testes falhando escritos primeiro: expirado, esgotado, inexistente, fixo acima do subtotal.",
          ),
        },
      ],
    },
  },

  implementation: {
    statement: L(
      "I read the thread. Some of it is real and some of it is taste, so let me separate them. Real: the query is built by gluing strings, the shipping line gives free shipping to anyone who types garbage, and the counter is a read-modify-write that loses updates. Those are bugs, and bugs get patches, not opinions. The discount goes into one small function that rounds to cents and never exceeds the subtotal. I am not adding Strategy classes: three cases need a switch the compiler checks, not a hierarchy. I am also not building an event pipeline for a counter. Ten patches below. One thing I cannot decide for you: I take the coupon use before charging the card, and someone who knows the payment flow has to decide what happens when the charge fails.",
      "Li a discussão. Parte dela é real e parte é gosto, então vou separar. Real: a consulta é montada colando strings, a linha do frete dá frete grátis para quem digitar lixo, e o contador é um lê-altera-grava que perde atualizações. Isso é bug, e bug recebe patch, não opinião. O desconto vai para uma função pequena que arredonda para centavos e nunca passa do subtotal. Não vou adicionar classes de Strategy: três casos pedem um switch que o compilador confere, não uma hierarquia. Também não vou construir um pipeline de eventos para um contador. Dez patches abaixo. Uma coisa eu não posso decidir por vocês: eu consumo o uso do cupom antes de cobrar o cartão, e alguém que conhece o fluxo de pagamento precisa decidir o que acontece quando a cobrança falha.",
    ),
    patches: [
      {
        fixes: ["sql-injection"],
        path: REPOSITORY,
        original: `    const rows = await this.db.query(
      "SELECT * FROM coupons WHERE code = '" + code + "' LIMIT 1",
    );`,
        replacement: `    const rows = await this.db.query("SELECT * FROM coupons WHERE code = $1 LIMIT 1", [code]);`,
        explanation: L("Bind the code as a parameter. The driver escapes it; the query text never changes.", "Passa o código como parâmetro. O driver faz o escape; o texto da consulta nunca muda."),
      },
      {
        fixes: ["coupon-race"],
        path: REPOSITORY,
        original: `  async incrementUsage(id: string, usedCount: number): Promise<void> {
    await this.db.query(
      "UPDATE coupons SET used_count = " + usedCount + " WHERE id = '" + id + "'",
    );
  }`,
        replacement: `  /** Atomically takes one use. Returns false when the coupon is exhausted. */
  async redeem(id: string): Promise<boolean> {
    const rows = await this.db.query(
      "UPDATE coupons SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING id",
      [id],
    );
    return rows.length === 1;
  }`,
        explanation: L(
          "The check and the increment happen in one statement, so the database decides who gets the last use. The caller cannot pass a stale count any more.",
          "A checagem e o incremento acontecem em um único comando, então o banco decide quem fica com o último uso. Quem chama não consegue mais passar um contador desatualizado.",
        ),
      },
      {
        fixes: ["hidden-dependency"],
        path: REPOSITORY,
        original: `export class PostgresCouponRepository {`,
        replacement: `export interface CouponRepository {
  findByCode(code: string): Promise<Coupon | null>;
  redeem(id: string): Promise<boolean>;
}

export class PostgresCouponRepository implements CouponRepository {`,
        explanation: L("The port the use case depends on. Two methods, nothing more.", "A porta da qual o caso de uso depende. Dois métodos, nada mais."),
      },
      {
        fixes: ["anemic-coupon", "negative-total", "primitive-money"],
        path: COUPON,
        original: `  expiresAt: Date;
}`,
        replacement: `  expiresAt: Date;
}

export function isRedeemable(coupon: Coupon, now: Date): boolean {
  return coupon.expiresAt > now && coupon.usedCount < coupon.maxUses;
}

/** Discount in currency units, rounded to cents and never above the subtotal. */
export function discountFor(coupon: Coupon, subtotal: number): number {
  switch (coupon.type) {
    case "percent":
      return Math.min(subtotal, Math.round(subtotal * coupon.value) / 100);
    case "fixed":
      return Math.min(subtotal, coupon.value);
    case "free_shipping":
      return 0;
  }
}`,
        explanation: L(
          "The rules live next to the data. One switch, checked for exhaustiveness by the compiler; the clamp and the rounding exist in exactly one place.",
          "As regras moram junto dos dados. Um switch, com exaustividade conferida pelo compilador; o limite e o arredondamento existem em exatamente um lugar.",
        ),
      },
      {
        fixes: ["hidden-dependency"],
        path: SERVICE,
        original: `import { PostgresCouponRepository } from "./coupons/CouponRepository";
import { db } from "../shared/db";`,
        replacement: `import { CouponRepository } from "./coupons/CouponRepository";
import { discountFor, isRedeemable } from "./coupons/Coupon";`,
        explanation: L("The use case stops importing Postgres and the global connection.", "O caso de uso para de importar o Postgres e a conexão global."),
      },
      {
        fixes: ["hidden-dependency", "jest-module-mock"],
        path: SERVICE,
        original: `    private readonly payments: PaymentGateway,
  ) {}`,
        replacement: `    private readonly payments: PaymentGateway,
    private readonly coupons: CouponRepository,
  ) {}`,
        explanation: L("Injected like the other two collaborators. The test passes a plain object and drops jest.mock.", "Injetado como os outros dois colaboradores. O teste passa um objeto simples e abandona o jest.mock."),
      },
      {
        fixes: ["free-shipping-bug", "arrow-code", "empty-catch", "mysterious-names", "coupon-race"],
        path: SERVICE,
        original: `    let d = 0;
    if (couponCode) {
      const repo = new PostgresCouponRepository(db);
      const c = await repo.findByCode(couponCode);
      if (c) {
        if (c.expiresAt > new Date()) {
          if (c.usedCount < c.maxUses) {
            if (c.type === "percent") {
              d = subtotal * (c.value / 100);
            } else if (c.type === "fixed") {
              d = c.value;
            } else if (c.type === "free_shipping") {
              d = 0;
            }
            try {
              await repo.incrementUsage(c.id, c.usedCount + 1);
            } catch (e) {}
          }
        }
      }
    }
    const shipping = subtotal >= 200 || (couponCode && d === 0) ? 0 : 15;
    const total = subtotal - d + shipping;`,
        replacement: `    const coupon = couponCode ? await this.coupons.findByCode(couponCode) : null;
    if (couponCode && !(coupon && isRedeemable(coupon, new Date()))) {
      throw new Error("Coupon is not valid");
    }
    const discount = coupon ? discountFor(coupon, subtotal) : 0;
    const freeShipping = subtotal >= 200 || coupon?.type === "free_shipping";
    const shipping = freeShipping ? 0 : 15;
    const total = subtotal - discount + shipping;
    if (coupon && !(await this.coupons.redeem(coupon.id))) {
      throw new Error("Coupon is no longer available");
    }`,
        explanation: L(
          "Twenty-three lines and four levels of nesting become eleven flat lines. An invalid code is an error instead of free shipping, free shipping comes from the coupon type, and a failed redemption stops the order instead of disappearing into an empty catch.",
          "Vinte e três linhas e quatro níveis de aninhamento viram onze linhas planas. Código inválido vira erro em vez de frete grátis, o frete grátis vem do tipo do cupom, e um resgate que falha interrompe o pedido em vez de sumir em um catch vazio.",
        ),
      },
      {
        fixes: ["free-shipping-bug", "mysterious-names"],
        path: SERVICE,
        original: `      discount: d,`,
        replacement: `      discount,`,
        explanation: L("Follows the rename in the block above; apply the two together.", "Acompanha a renomeação do bloco acima; aplique os dois juntos."),
      },
      {
        fixes: ["token-in-logs"],
        path: CONTROLLER,
        original: `    console.log("checkout request", req.body);`,
        replacement: ``,
        explanation: L("Delete it. The request body contains the payment token.", "Apague. O corpo da requisição contém o token de pagamento."),
      },
      {
        fixes: ["missing-unique"],
        path: MIGRATION,
        original: `  code VARCHAR(64) NOT NULL,`,
        replacement: `  code VARCHAR(64) NOT NULL UNIQUE,`,
        explanation: L("The table now guarantees what LIMIT 1 was hoping for.", "A tabela agora garante o que o LIMIT 1 estava torcendo para ser verdade."),
      },
    ],
    declined: [
      {
        on: "ocp-coupon-types",
        reason: L(
          "Three cases. A switch that the compiler checks for exhaustiveness is the simplest thing that works. Bring a fourth type that needs its own data and I will take the patch.",
          "Três casos. Um switch com exaustividade conferida pelo compilador é a coisa mais simples que funciona. Traga um quarto tipo que precise de dados próprios e eu aceito o patch.",
        ),
      },
      {
        on: "srp-place-order",
        reason: L(
          "The coupon block is now eleven flat lines. Splitting placeOrder further would be moving code around to satisfy a line count.",
          "O bloco do cupom agora tem onze linhas planas. Dividir placeOrder ainda mais seria mover código de lugar para satisfazer uma contagem de linhas.",
        ),
      },
      {
        on: "thin-tests",
        reason: L(
          "Valid finding, but the author writes the tests. The cases are listed in the finding; the constructor now takes the repository, so they need no module mocks.",
          "Achado válido, mas quem escreve os testes é o autor. Os casos estão listados no achado; o construtor agora recebe o repositório, então eles não precisam de mock de módulo.",
        ),
      },
    ],
  },

  verdict: {
    statement: L(
      "The council is unanimous on what blocks this merge and honest about what it could not settle. I am requesting changes.",
      "O conselho é unânime sobre o que bloqueia este merge e honesto sobre o que não conseguiu resolver. Estou pedindo mudanças.",
    ),
    decision: "request_changes",
    mergeRisk: "high",
    summary: L(
      "Do not merge yet. Two blockers were endorsed by all four reviewers: the coupon lookup is open to SQL injection, and any invalid coupon code removes the shipping charge. The council also agrees that coupon usage loses updates under concurrency, that the total can go negative, and that the payment token is being logged. The implementer supplied ten patches that address 12 of the 14 endorsed findings. Two findings remained contested and one proposal from our own architect was rejected as over-engineering.",
      "Não faça o merge ainda. Dois bloqueantes foram endossados pelos quatro revisores: a busca de cupom está aberta a SQL injection, e qualquer código de cupom inválido remove a cobrança de frete. O conselho também concorda que o uso do cupom perde atualizações sob concorrência, que o total pode ficar negativo e que o token de pagamento está sendo logado. O implementador entregou dez patches que tratam 12 dos 14 achados endossados. Dois achados ficaram em disputa e uma proposta do nosso próprio arquiteto foi rejeitada por excesso de engenharia.",
    ),
    humanAttention: [
      L(
        "Coupon use versus payment failure: the patch takes the use before charging the card. Decide whether a failed charge should give the use back. This needs someone who knows the payment flow.",
        "Uso do cupom versus falha de pagamento: o patch consome o uso antes de cobrar o cartão. Decida se uma cobrança que falha deve devolver o uso. Isso precisa de alguém que conheça o fluxo de pagamento.",
      ),
      L(
        "Strategy versus switch for coupon types (contested): the Clean Code school wants policies now; the Refactoring school and the Staff Engineer say wait for a fourth type. This is a call for the tech lead.",
        "Strategy versus switch para tipos de cupom (em disputa): a escola do Clean Code quer políticas agora; a escola da Refatoração e o Staff Engineer dizem para esperar um quarto tipo. Essa decisão é do tech lead.",
      ),
      L(
        "Tests: only the happy path is covered for code that moves money. Ask the author for the five cases listed in the testing finding before approving.",
        "Testes: só o caminho feliz está coberto em um código que movimenta dinheiro. Peça ao autor os cinco casos listados no achado de testes antes de aprovar.",
      ),
    ],
  },
};
