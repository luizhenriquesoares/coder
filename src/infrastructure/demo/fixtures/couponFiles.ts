import type { DemoFile } from "../types.js";

const checkoutServiceBase = `import { Cart, CartItem } from "./Cart";
import { Order, OrderRepository } from "../orders/OrderRepository";
import { PaymentGateway } from "../payments/PaymentGateway";
import { logger } from "../shared/logger";

export interface PlaceOrderRequest {
  customerId: string;
  cart: Cart;
  paymentToken: string;
}

export class CheckoutService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentGateway,
  ) {}

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    const { customerId, cart, paymentToken } = request;
    if (cart.items.length === 0) {
      throw new Error("Cart is empty");
    }

    const subtotal = this.subtotalOf(cart.items);
    const shipping = subtotal >= 200 ? 0 : 15;
    const total = subtotal + shipping;

    const charge = await this.payments.charge(paymentToken, total);
    const order = await this.orders.create({
      customerId,
      items: cart.items,
      subtotal,
      shipping,
      total,
      chargeId: charge.id,
    });

    logger.info("order placed", { orderId: order.id, total });
    return order;
  }

  private subtotalOf(items: CartItem[]): number {
    return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }
}
`;

const checkoutServiceHead = `import { Cart, CartItem } from "./Cart";
import { Order, OrderRepository } from "../orders/OrderRepository";
import { PaymentGateway } from "../payments/PaymentGateway";
import { logger } from "../shared/logger";
import { PostgresCouponRepository } from "./coupons/CouponRepository";
import { db } from "../shared/db";

export interface PlaceOrderRequest {
  customerId: string;
  cart: Cart;
  paymentToken: string;
  couponCode?: string;
}

export class CheckoutService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentGateway,
  ) {}

  async placeOrder(request: PlaceOrderRequest): Promise<Order> {
    const { customerId, cart, paymentToken, couponCode } = request;
    if (cart.items.length === 0) {
      throw new Error("Cart is empty");
    }

    const subtotal = this.subtotalOf(cart.items);
    let d = 0;
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
    const total = subtotal - d + shipping;

    const charge = await this.payments.charge(paymentToken, total);
    const order = await this.orders.create({
      customerId,
      items: cart.items,
      subtotal,
      discount: d,
      shipping,
      total,
      chargeId: charge.id,
    });

    logger.info("order placed", { orderId: order.id, total, couponCode });
    return order;
  }

  private subtotalOf(items: CartItem[]): number {
    return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }
}
`;

const couponRepositoryHead = `import { Database } from "../../shared/db";
import { Coupon } from "./Coupon";

export class PostgresCouponRepository {
  constructor(private readonly db: Database) {}

  async findByCode(code: string): Promise<Coupon | null> {
    const rows = await this.db.query(
      "SELECT * FROM coupons WHERE code = '" + code + "' LIMIT 1",
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      code: row.code,
      type: row.type,
      value: Number(row.value),
      maxUses: row.max_uses,
      usedCount: row.used_count,
      expiresAt: new Date(row.expires_at),
    };
  }

  async incrementUsage(id: string, usedCount: number): Promise<void> {
    await this.db.query(
      "UPDATE coupons SET used_count = " + usedCount + " WHERE id = '" + id + "'",
    );
  }
}
`;

const couponHead = `export type CouponType = "percent" | "fixed" | "free_shipping";

export interface Coupon {
  id: string;
  code: string;
  type: CouponType;
  value: number;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
}
`;

const controllerBase = `import { Request, Response } from "express";
import { CheckoutService } from "../checkout/CheckoutService";
import { loadCart } from "../checkout/Cart";

export function checkoutController(checkout: CheckoutService) {
  return async (req: Request, res: Response) => {
    const cart = await loadCart(req.user.id);
    try {
      const order = await checkout.placeOrder({
        customerId: req.user.id,
        cart,
        paymentToken: req.body.paymentToken,
      });
      res.status(201).json({ orderId: order.id, total: order.total });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };
}
`;

const controllerHead = `import { Request, Response } from "express";
import { CheckoutService } from "../checkout/CheckoutService";
import { loadCart } from "../checkout/Cart";

export function checkoutController(checkout: CheckoutService) {
  return async (req: Request, res: Response) => {
    const cart = await loadCart(req.user.id);
    console.log("checkout request", req.body);
    try {
      const order = await checkout.placeOrder({
        customerId: req.user.id,
        cart,
        paymentToken: req.body.paymentToken,
        couponCode: req.body.couponCode,
      });
      res.status(201).json({ orderId: order.id, total: order.total, discount: order.discount });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };
}
`;

const migrationHead = `CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(64) NOT NULL,
  type VARCHAR(16) NOT NULL,
  value NUMERIC(10, 2) NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL
);

ALTER TABLE orders ADD COLUMN discount NUMERIC(10, 2) NOT NULL DEFAULT 0;
`;

const testBase = `import { CheckoutService } from "../../src/checkout/CheckoutService";

const orders = { create: jest.fn(async (order) => ({ id: "ord_1", ...order })) };
const payments = { charge: jest.fn(async () => ({ id: "ch_1" })) };

describe("CheckoutService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("charges subtotal plus shipping", async () => {
    const service = new CheckoutService(orders as any, payments as any);
    const order = await service.placeOrder({
      customerId: "c1",
      cart: { items: [{ sku: "A", unitPrice: 50, quantity: 2 }] },
      paymentToken: "tok",
    });
    expect(order.total).toBe(115);
  });
});
`;

const testHead = `import { CheckoutService } from "../../src/checkout/CheckoutService";

jest.mock("../../src/checkout/coupons/CouponRepository", () => ({
  PostgresCouponRepository: jest.fn().mockImplementation(() => ({
    findByCode: jest.fn(async () => ({
      id: "cp_1",
      code: "WELCOME10",
      type: "percent",
      value: 10,
      maxUses: 100,
      usedCount: 3,
      expiresAt: new Date("2099-01-01"),
    })),
    incrementUsage: jest.fn(),
  })),
}));

const orders = { create: jest.fn(async (order) => ({ id: "ord_1", ...order })) };
const payments = { charge: jest.fn(async () => ({ id: "ch_1" })) };

describe("CheckoutService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("charges subtotal plus shipping", async () => {
    const service = new CheckoutService(orders as any, payments as any);
    const order = await service.placeOrder({
      customerId: "c1",
      cart: { items: [{ sku: "A", unitPrice: 50, quantity: 2 }] },
      paymentToken: "tok",
    });
    expect(order.total).toBe(115);
  });

  it("applies a percent coupon", async () => {
    const service = new CheckoutService(orders as any, payments as any);
    const order = await service.placeOrder({
      customerId: "c1",
      cart: { items: [{ sku: "A", unitPrice: 50, quantity: 2 }] },
      paymentToken: "tok",
      couponCode: "WELCOME10",
    });
    expect(order.total).toBe(105);
  });
});
`;

export const couponFiles: readonly DemoFile[] = [
  { path: "src/checkout/CheckoutService.ts", base: checkoutServiceBase, head: checkoutServiceHead },
  { path: "src/checkout/coupons/CouponRepository.ts", base: null, head: couponRepositoryHead },
  { path: "src/checkout/coupons/Coupon.ts", base: null, head: couponHead },
  { path: "src/api/checkoutController.ts", base: controllerBase, head: controllerHead },
  { path: "migrations/20260112_add_coupons.sql", base: null, head: migrationHead },
  { path: "tests/checkout/CheckoutService.test.ts", base: testBase, head: testHead },
];
