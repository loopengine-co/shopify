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

interface OrderDetail {
  id: string
  name: string
  createdAt: string
  cancelledAt: string | null
  cancelReason: string | null
  closedAt: string | null
  note: string | null
  tags: string[]
  email: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string
  customer: { displayName: string } | null
  shippingAddress: { name: string | null; address1: string | null; address2: string | null; city: string | null; provinceCode: string | null; zip: string | null; countryCodeV2: string | null } | null
  subtotalPriceSet: Money | null
  totalShippingPriceSet: Money
  totalTaxSet: Money | null
  totalPriceSet: Money
  totalRefundedSet: Money
  currentTotalPriceSet: Money
  lineItems: { nodes: { id: string; title: string; variantTitle: string | null; sku: string | null; quantity: number; refundableQuantity: number; originalUnitPriceSet: Money }[] }
  fulfillments: { displayStatus: string | null; createdAt: string; deliveredAt: string | null; estimatedDeliveryAt: string | null; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[]
  refunds: { createdAt: string | null; note: string | null; totalRefundedSet: Money }[]
  transactions: { kind: string; status: string; gateway: string | null; createdAt: string; amountSet: Money }[]
}

export const shopifyGetOrder: ToolDefinition = {
  name: 'shopify_get_order',
  description:
    'Read one Shopify order in full: customer, shipping address, each item (with its line_item_id and how many can still be refunded), totals, payment status, what has already been refunded, payments, and shipments with carrier, tracking number and link. order is an order number like "#1042" or an id from shopify_find_orders. Read the order before any refund.',
  input_schema: {
    type: 'object',
    properties: {
      order: { type: 'string', description: 'The order number (e.g. "#1042") or order id.' },
    },
    required: ['order'],
  },
  execute: async (input, ctx) => {
    const action = 'shopify_get_order'
    const id = await resolveOrderId(ctx.env, action, input.order)
    const m = 'shopMoney { amount currencyCode }'
    const data = await shopifyGraphql<{ order: OrderDetail | null }>(
      ctx.env,
      action,
      `query ($id: ID!) {
        order(id: $id) {
          id name createdAt cancelledAt cancelReason closedAt note tags email
          displayFinancialStatus displayFulfillmentStatus
          customer { displayName }
          shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 }
          subtotalPriceSet { ${m} } totalShippingPriceSet { ${m} } totalTaxSet { ${m} }
          totalPriceSet { ${m} } totalRefundedSet { ${m} } currentTotalPriceSet { ${m} }
          lineItems(first: 50) { nodes { id title variantTitle sku quantity refundableQuantity originalUnitPriceSet { ${m} } } }
          fulfillments(first: 10) { displayStatus createdAt deliveredAt estimatedDeliveryAt trackingInfo(first: 5) { company number url } }
          refunds(first: 10) { createdAt note totalRefundedSet { ${m} } }
          transactions(first: 20) { kind status gateway createdAt amountSet { ${m} } }
        }
      }`,
      { id },
    )
    const o = data.order
    if (!o) throw new Error(`${action}: order not found`)
    const address = o.shippingAddress
    return JSON.stringify({
      order: o.name,
      id: o.id,
      created_at: o.createdAt,
      customer: o.customer?.displayName ?? null,
      email: o.email,
      payment: o.displayFinancialStatus,
      fulfilment: o.displayFulfillmentStatus,
      cancelled: o.cancelledAt ? { at: o.cancelledAt, reason: o.cancelReason } : null,
      closed_at: o.closedAt,
      note: o.note,
      tags: o.tags,
      ship_to: address
        ? [address.name, address.address1, address.address2, [address.city, address.provinceCode, address.zip].filter(Boolean).join(' '), address.countryCodeV2].filter(Boolean).join(', ')
        : null,
      items: o.lineItems.nodes.map((li) => ({
        line_item_id: li.id,
        title: li.variantTitle ? `${li.title} (${li.variantTitle})` : li.title,
        sku: li.sku,
        quantity: li.quantity,
        refundable_quantity: li.refundableQuantity,
        unit_price: money(li.originalUnitPriceSet),
      })),
      totals: {
        subtotal: money(o.subtotalPriceSet),
        shipping: money(o.totalShippingPriceSet),
        tax: money(o.totalTaxSet),
        total: money(o.totalPriceSet),
        refunded: money(o.totalRefundedSet),
        current_total: money(o.currentTotalPriceSet),
      },
      shipments: o.fulfillments.map((f) => ({
        status: f.displayStatus,
        shipped_at: f.createdAt,
        delivered_at: f.deliveredAt,
        estimated_delivery: f.estimatedDeliveryAt,
        tracking: f.trackingInfo.map((t) => ({ carrier: t.company, number: t.number, url: t.url })),
      })),
      refunds: o.refunds.map((r) => ({ at: r.createdAt, amount: money(r.totalRefundedSet), note: r.note })),
      payments: o.transactions.map((t) => ({ kind: t.kind, status: t.status, gateway: t.gateway, at: t.createdAt, amount: money(t.amountSet) })),
    })
  },
  safe: true,
}
