import type { AgentEnv, ToolDefinition } from 'loopengine'

// ---- Shared request helpers ----------------------------------------
// Duplicated verbatim across every tool file in this ability: add-ability
// copies each tool file standalone, with no shared-module support, so
// this block is the contract between them. Keep the copies identical.
//
// Uses Shopify's GraphQL Admin API. Settings come from ctx.env, not
// process.env: loopengine resolves them per agent (see
// loopengine.ability.json's `scope`).
const DEFAULT_API_VERSION = '2025-10'

interface Money {
  shopMoney: { amount: string; currencyCode: string }
}

function shopDomain(env: AgentEnv, action: string): string {
  const raw = (env.get('SHOPIFY_STORE_DOMAIN') ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!raw) throw new Error(`${action}: SHOPIFY_STORE_DOMAIN is not set (e.g. "my-store.myshopify.com")`)
  const domain = raw.includes('.') ? raw : `${raw}.myshopify.com`
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error(`${action}: SHOPIFY_STORE_DOMAIN must be the store's myshopify.com address (e.g. "my-store.myshopify.com"), not its public domain; got "${raw}"`)
  }
  return domain
}

async function shopifyGraphql<T>(env: AgentEnv, action: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = env.get('SHOPIFY_ADMIN_TOKEN')
  if (!token) throw new Error(`${action}: SHOPIFY_ADMIN_TOKEN is not set (see @loopengine-co/shopify's README)`)
  const version = (env.get('SHOPIFY_API_VERSION') ?? '').trim() || DEFAULT_API_VERSION
  const domain = shopDomain(env, action)
  const res = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] | string }
  if (!res.ok) {
    const hint =
      res.status === 401
        ? ' The access token is invalid.'
        : res.status === 403
          ? ' The app is missing an access scope this needs (see @loopengine-co/shopify\'s README).'
          : res.status === 404
            ? ` Check SHOPIFY_STORE_DOMAIN ("${domain}").`
            : res.status === 429
              ? ' Shopify is rate limiting; try again in a few seconds.'
              : ''
    const detail = typeof body.errors === 'string' ? body.errors : body.errors?.[0]?.message
    throw new Error(`${action}: Shopify API error ${res.status}${detail ? `: ${detail}` : ''}.${hint}`)
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED')
    throw new Error(`${action}: ${throttled ? 'Shopify is rate limiting; try again in a few seconds' : `Shopify error: ${body.errors.map((e) => e.message).join('; ')}`}`)
  }
  if (!body.data) throw new Error(`${action}: Shopify returned no data`)
  return body.data
}

function money(value: Money | null | undefined): string | null {
  return value ? `${value.shopMoney.amount} ${value.shopMoney.currencyCode}` : null
}

// Accepts an order number ("#1042" or "1042"), a numeric order id, or a
// GraphQL id, and returns the GraphQL id.
async function resolveOrderId(env: AgentEnv, action: string, ref: unknown): Promise<string> {
  const value = typeof ref === 'number' ? String(ref) : typeof ref === 'string' ? ref.trim() : ''
  if (!value) throw new Error(`${action}: order is required (an order number like "#1042", or an order id)`)
  if (value.startsWith('gid://shopify/Order/')) return value
  if (/^\d{9,}$/.test(value)) return `gid://shopify/Order/${value}`
  const name = value.startsWith('#') ? value : `#${value}`
  const data = await shopifyGraphql<{ orders: { nodes: { id: string }[] } }>(
    env,
    action,
    'query ($q: String!) { orders(first: 1, query: $q) { nodes { id } } }',
    { q: `name:${JSON.stringify(name)}` },
  )
  const id = data.orders.nodes[0]?.id
  if (!id) throw new Error(`${action}: no order ${name} in this store`)
  return id
}
// ---- End of shared helpers -----------------------------------------

// ---- Refund helpers (same in shopify_preview_refund and shopify_create_refund)
// Shopify's own suggestedRefund works out the amounts — item prices,
// discounts, tax, and which payment to refund to — so a refund is never
// calculated by hand, and can't exceed what's refundable.
interface SuggestedRefund {
  amountSet: Money
  subtotalSet: Money
  totalTaxSet: Money
  maximumRefundableSet: Money
  shipping: { amountSet: Money; maximumRefundableSet: Money }
  refundLineItems: { quantity: number; lineItem: { id: string; title: string }; subtotalSet: Money }[]
  suggestedTransactions: { gateway: string | null; amountSet: Money; parentTransaction: { id: string } | null }[]
}

interface RefundPlan {
  orderId: string
  order: string
  lineItems: { lineItemId: string; quantity: number }[]
  shipping?: { fullRefund: true } | { amount: string }
  transactions: { gateway: string; amount: string; parentId: string }[]
  summary: {
    order: string
    refund_total: string
    items: { title: string; quantity: number; amount: string | null }[]
    shipping: string | null
    tax: string | null
    refund_to: string[]
    maximum_refundable: string | null
  }
}

const REFUND_PROPERTIES = {
  order: { type: 'string', description: 'The order number (e.g. "#1042") or order id.' },
  line_items: {
    type: 'array',
    description: 'Items to refund: each line_item_id (from shopify_get_order) and how many of it.',
    items: {
      type: 'object',
      properties: { line_item_id: { type: 'string' }, quantity: { type: 'number' } },
      required: ['line_item_id', 'quantity'],
    },
  },
  refund_shipping: { type: 'boolean', description: 'Also refund all of the shipping cost.' },
  shipping_amount: { type: 'string', description: 'Refund part of the shipping cost instead, e.g. "4.50".' },
  amount: {
    type: 'string',
    description: 'A custom amount to refund instead of items, e.g. "15.00" as a goodwill partial refund for a damaged item the customer keeps. Use either this or line_items.',
  },
} as const

function parseRefundLineItems(action: string, value: unknown): { lineItemId: string; quantity: number }[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${action}: line_items must be a list of { line_item_id, quantity }`)
  return value.map((item, i) => {
    const entry = (item ?? {}) as Record<string, unknown>
    const id = typeof entry.line_item_id === 'string' ? entry.line_item_id.trim() : ''
    const quantity = Number(entry.quantity)
    if (!id.startsWith('gid://shopify/LineItem/')) throw new Error(`${action}: line_items[${i}].line_item_id must be a line item id from shopify_get_order (gid://shopify/LineItem/…)`)
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`${action}: line_items[${i}].quantity must be a whole number of at least 1`)
    return { lineItemId: id, quantity }
  })
}

function parseAmount(action: string, field: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${action}: ${field} must be a positive amount like "15.00"`)
  return n.toFixed(2)
}

async function planRefund(env: AgentEnv, action: string, input: Record<string, unknown>): Promise<RefundPlan> {
  const orderId = await resolveOrderId(env, action, input.order)
  const lineItems = parseRefundLineItems(action, input.line_items)
  const fullShipping = input.refund_shipping === true
  const shippingAmount = parseAmount(action, 'shipping_amount', input.shipping_amount)
  const customAmount = parseAmount(action, 'amount', input.amount)
  if (customAmount && (lineItems.length || fullShipping || shippingAmount)) {
    throw new Error(`${action}: give either amount, or line_items and shipping, not both`)
  }
  if (!customAmount && !lineItems.length && !fullShipping && !shippingAmount) {
    throw new Error(`${action}: say what to refund: line_items, refund_shipping, shipping_amount, or amount`)
  }
  if (fullShipping && shippingAmount) throw new Error(`${action}: give refund_shipping or shipping_amount, not both`)

  const m = 'shopMoney { amount currencyCode }'
  const data = await shopifyGraphql<{ order: { name: string; suggestedRefund: SuggestedRefund } | null }>(
    env,
    action,
    `query ($id: ID!, $items: [RefundLineItemInput!], $ship: Boolean, $shipAmount: Money, $full: Boolean) {
      order(id: $id) {
        name
        suggestedRefund(refundLineItems: $items, refundShipping: $ship, shippingAmount: $shipAmount, suggestFullRefund: $full) {
          amountSet { ${m} } subtotalSet { ${m} } totalTaxSet { ${m} } maximumRefundableSet { ${m} }
          shipping { amountSet { ${m} } maximumRefundableSet { ${m} } }
          refundLineItems { quantity lineItem { id title } subtotalSet { ${m} } }
          suggestedTransactions { gateway amountSet { ${m} } parentTransaction { id } }
        }
      }
    }`,
    {
      id: orderId,
      items: lineItems.map((li) => ({ lineItemId: li.lineItemId, quantity: li.quantity })),
      ship: fullShipping,
      shipAmount: shippingAmount ?? null,
      full: Boolean(customAmount),
    },
  )
  if (!data.order) throw new Error(`${action}: order not found`)
  const s = data.order.suggestedRefund
  const currency = s.maximumRefundableSet.shopMoney.currencyCode
  const maxRefundable = Number(s.maximumRefundableSet.shopMoney.amount)

  let transactions: RefundPlan['transactions']
  if (customAmount) {
    if (Number(customAmount) > maxRefundable) {
      throw new Error(`${action}: ${customAmount} ${currency} is more than this order's ${s.maximumRefundableSet.shopMoney.amount} ${currency} that can still be refunded`)
    }
    const payments = s.suggestedTransactions.filter((t) => t.parentTransaction && t.gateway)
    if (payments.length !== 1) {
      throw new Error(`${action}: this order was paid with ${payments.length === 0 ? 'no refundable payment' : 'more than one payment method'}, so a custom amount can't be refunded automatically; refund by line_items instead`)
    }
    transactions = [{ gateway: payments[0].gateway!, amount: customAmount, parentId: payments[0].parentTransaction!.id }]
  } else {
    transactions = s.suggestedTransactions
      .filter((t) => t.parentTransaction && t.gateway && Number(t.amountSet.shopMoney.amount) > 0)
      .map((t) => ({ gateway: t.gateway!, amount: t.amountSet.shopMoney.amount, parentId: t.parentTransaction!.id }))
    if (!transactions.length) throw new Error(`${action}: Shopify suggests refunding nothing for this; the items or shipping may already be refunded. Check shopify_get_order.`)
  }

  const total = transactions.reduce((sum, t) => sum + Number(t.amount), 0).toFixed(2)
  return {
    orderId,
    order: data.order.name,
    lineItems: customAmount ? [] : lineItems,
    shipping: customAmount ? undefined : fullShipping ? { fullRefund: true } : shippingAmount ? { amount: shippingAmount } : undefined,
    transactions,
    summary: {
      order: data.order.name,
      refund_total: `${total} ${currency}`,
      items: customAmount ? [] : s.refundLineItems.map((r) => ({ title: r.lineItem.title, quantity: r.quantity, amount: money(r.subtotalSet) })),
      shipping: customAmount ? null : money(s.shipping.amountSet),
      tax: customAmount ? null : money(s.totalTaxSet),
      refund_to: transactions.map((t) => t.gateway),
      maximum_refundable: money(s.maximumRefundableSet),
    },
  }
}
// ---- End of refund helpers

export const shopifyPreviewRefund: ToolDefinition = {
  name: 'shopify_preview_refund',
  description:
    'Work out exactly what a refund would return, without refunding anything: Shopify calculates the amount for the chosen items (including their discounts and tax) and shipping, and which payment it goes back to. Use it before proposing a refund, so the amount you state is right. Takes the same inputs as shopify_create_refund.',
  input_schema: { type: 'object', properties: REFUND_PROPERTIES, required: ['order'] },
  execute: async (input, ctx) => {
    const plan = await planRefund(ctx.env, 'shopify_preview_refund', input)
    return JSON.stringify({ preview: true, ...plan.summary })
  },
  safe: true,
}
