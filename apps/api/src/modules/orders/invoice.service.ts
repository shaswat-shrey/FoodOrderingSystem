import type { Order, Prisma, PrismaClient } from '@fos/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/http/errors';
import { simplePdf, type PdfLine } from '../../platform/pdf';
import { localParts } from '../catalog';

type Tx = Prisma.TransactionClient;

/** One series for invoices the platform issues as e-commerce operator (BR-ORDER-019; legal review pending). */
export const INVOICE_SERIES = 'FOS';
const PLATFORM = {
  name: 'FoodOrderSystem Technologies Pvt Ltd',
  role: 'E-commerce operator (supply notified under CGST s.9(5))',
};

/** Indian financial year (April–March) in IST, e.g. "2026-27". */
export function financialYear(at: Date): string {
  const { year, month } = localParts(at, 'Asia/Kolkata');
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const rs = (paise: number) =>
  `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Tax invoices for delivered orders (FR-CORD-009, API-ORD-009). */
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  /**
   * Issues the order's invoice once. Numbers are sequential per series and
   * financial year with no gaps: allocation runs under a transaction-scoped
   * advisory lock for that series/year.
   */
  async issue(tx: Tx, order: Pick<Order, 'id' | 'status'>) {
    if (order.status !== 'DELIVERED') {
      throw new AppError('ORDER_STATE_CONFLICT', {
        message: 'An invoice is available once the order is delivered.',
      });
    }
    const existing = await tx.invoice.findFirst({ where: { orderId: order.id } });
    if (existing) return existing;
    const fy = financialYear(this.clock.now());
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${INVOICE_SERIES}:${fy}`}))`;
    const again = await tx.invoice.findFirst({ where: { orderId: order.id } });
    if (again) return again;
    const last = await tx.invoice.aggregate({
      where: { series: INVOICE_SERIES, financialYear: fy },
      _max: { number: true },
    });
    return tx.invoice.create({
      data: {
        orderId: order.id,
        issuer: 'PLATFORM',
        series: INVOICE_SERIES,
        financialYear: fy,
        number: (last._max.number ?? 0) + 1,
        issuedAt: this.clock.now(),
      },
    });
  }

  static display(inv: { series: string; financialYear: string; number: number }): string {
    return `${inv.series}/${inv.financialYear}/${String(inv.number).padStart(6, '0')}`;
  }

  /** API-ORD-009: the customer's PDF (issued on first request if the delivery event hasn't yet). */
  async pdf(userId: string, orderId: string): Promise<{ filename: string; body: Buffer }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: {
        items: { include: { options: true }, orderBy: { id: 'asc' } },
        priceComponents: { orderBy: { id: 'asc' } },
        address: true,
        branch: { include: { restaurant: true } },
      },
    });
    if (!order) throw new AppError('NOT_FOUND', { message: "We couldn't find that order." });
    const invoice = await this.prisma.$transaction((tx) => this.issue(tx, order));
    const number = InvoiceService.display(invoice);
    const r = order.branch.restaurant;
    const a = order.address;
    const lines: PdfLine[] = [
      { text: 'TAX INVOICE', size: 16, bold: true },
      {
        text: `Invoice no. ${number}`,
        right: `Date ${invoice.issuedAt.toISOString().slice(0, 10)}`,
      },
      { text: `Order ${order.number}` },
      { text: 'Supplier (restaurant)', bold: true, gapBefore: 8 },
      { text: `${r.legalName} (${r.brandName}, ${order.branch.name})` },
      { text: `GSTIN: ${r.gstin ?? 'Not registered'}   FSSAI: ${r.fssaiNumber ?? '-'}` },
      { text: 'Issued by', bold: true, gapBefore: 8 },
      { text: `${PLATFORM.name}, ${PLATFORM.role}` },
      { text: 'Billed to', bold: true, gapBefore: 8 },
      { text: order.contactName },
      ...(a
        ? [
            {
              text: [a.line1, a.line2, a.area, a.city, a.state, a.pincode]
                .filter(Boolean)
                .join(', '),
            },
          ]
        : []),
      { text: 'Items', bold: true, gapBefore: 10 },
    ];
    for (const i of order.items) {
      const opts = i.options.map((o) => o.optionName).join(', ');
      lines.push({
        text: `${i.quantity} x ${i.itemName}${i.variantName ? ` (${i.variantName})` : ''}${opts ? ` - ${opts}` : ''}`,
        right: rs(i.lineTotalAmount),
      });
    }
    lines.push({ text: 'Charges', bold: true, gapBefore: 10 });
    const negative = new Set(['ITEM_DISCOUNT', 'PROMOTION', 'COUPON']);
    for (const c of order.priceComponents) {
      if (c.type === 'ITEMS_SUBTOTAL') continue;
      lines.push({
        text: c.type === 'TAX' && c.rateBps ? `${c.label} @ ${c.rateBps / 100}%` : c.label,
        right: `${negative.has(c.type) ? '- ' : ''}${rs(c.amount)}`,
      });
    }
    if (order.tipAmount > 0)
      lines.push({ text: 'Delivery partner tip (not taxable)', right: rs(order.tipAmount) });
    lines.push({ text: 'Total', bold: true, right: rs(order.totalAmount), gapBefore: 6 });
    lines.push({
      text: 'Amounts include GST as shown. This is a computer-generated invoice.',
      size: 8,
      gapBefore: 14,
    });
    return {
      filename: `invoice-${number.replace(/\//g, '-')}.pdf`,
      body: simplePdf(lines, { title: `Invoice ${number}` }),
    };
  }
}
