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

interface OrderSummary {
  id: string
  name: string
  createdAt: string
  cancelledAt: string | null
  email: string | null
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string
  totalPriceSet: Money
  customer: { displayName: string } | null
}

export const shopifyFindOrders: ToolDefinition = {
  name: 'shopify_find_orders',
  description:
    'Find orders in the Shopify store, newest first: order number, date, customer, email, payment status (paid, refunded, partially refunded…), fulfilment status and total. Search by order number, by customer email, or with Shopify\'s order search syntax (e.g. "created_at:>2026-10-01 financial_status:paid"). Read one in full with shopify_get_order.',
  input_schema: {
    type: 'object',
    properties: {
      order_number: { type: 'string', description: 'An order number, e.g. "#1042" or "1042".' },
      email: { type: 'string', description: 'The customer\'s email address.' },
      query: { type: 'string', description: 'Any extra Shopify order search terms, e.g. "fulfillment_status:unfulfilled".' },
      max_results: { type: 'number', description: 'How many orders to return, 1 to 25. Default 10.' },
    },
    required: [],
  },
  execute: async (input, ctx) => {
    const action = 'shopify_find_orders'
    const terms: string[] = []
    const number = typeof input.order_number === 'string' ? input.order_number.trim() : typeof input.order_number === 'number' ? String(input.order_number) : ''
    if (number) terms.push(`name:${JSON.stringify(number.startsWith('#') ? number : `#${number}`)}`)
    const email = typeof input.email === 'string' ? input.email.trim() : ''
    if (email) terms.push(`email:${JSON.stringify(email)}`)
    if (typeof input.query === 'string' && input.query.trim()) terms.push(input.query.trim())
    const first = Math.max(1, Math.min(25, Math.floor(Number(input.max_results) || 10)))

    const data = await shopifyGraphql<{ orders: { nodes: OrderSummary[] } }>(
      ctx.env,
      action,
      `query ($first: Int!, $q: String) {
        orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id name createdAt cancelledAt email
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            customer { displayName }
          }
        }
      }`,
      { first, q: terms.join(' ') || null },
    )
    return JSON.stringify({
      orders: data.orders.nodes.map((o) => ({
        order: o.name,
        id: o.id,
        created_at: o.createdAt,
        customer: o.customer?.displayName ?? null,
        email: o.email,
        payment: o.displayFinancialStatus,
        fulfilment: o.displayFulfillmentStatus,
        total: money(o.totalPriceSet),
        cancelled: Boolean(o.cancelledAt),
      })),
    })
  },
  safe: true,
}
