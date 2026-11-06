# @loopengine-co/shopify

A [loopengine](https://github.com/loopengine-co/loopengine) ability:
Shopify tools to find and read orders — items, payments, refunds so far,
shipments with tracking — and to preview and make refunds, plus a skill
on answering order questions and refunding the right amount. Refunds ask a
person first by default.

```sh
npx loopengine add-ability @loopengine-co/shopify --agent <your-agent>
```

## What's in it

- **Tools** (Shopify's GraphQL Admin API)
  - `shopify_find_orders(order_number?, email?, query?, max_results?)` —
    newest first: number, date, customer, email, payment and fulfilment
    status, total.
  - `shopify_get_order(order)` — one order in full: customer, ship-to,
    items with `line_item_id` and refundable quantity, totals, payments,
    refunds so far, shipments with carrier, tracking number and link.
  - `shopify_preview_refund(order, line_items? | amount?, refund_shipping?,
    shipping_amount?)` — what a refund would return and where it goes
    back to, calculated by Shopify, without refunding.
  - `shopify_create_refund(…same…, note?, notify_customer?)` — makes the
    refund.

  `order` takes an order number (`"#1042"`) or id. Refund amounts always
  come from Shopify's own calculation (`suggestedRefund`), with the
  item's discounts and tax, and can't exceed what's still refundable. A
  custom `amount` (e.g. a goodwill partial refund) is checked against the
  maximum refundable and goes to the order's payment method. Items are
  not restocked.
- **Skill** — `shopify-orders`: answering where-is-my-order and payment
  questions from the order, and the preview → propose → refund steps.
- **actauth rules** — finding, reading and previewing are `allow`;
  `shopify_create_refund` is `ask`.

## Setup

1. In the Shopify admin, open **Settings → Apps and sales channels →
   Develop apps** (allow custom app development if asked), and **Create
   an app**.
2. Under **Configuration → Admin API integration**, give it the scopes
   `read_orders` and `write_orders`. (Orders older than 60 days also
   need `read_all_orders`, which Shopify grants on request.)
3. **Install app**, then copy the **Admin API access token** (starts
   `shpat_`). Shopify shows it only once.
4. Set the values in the agent's **Environment** tab in the console:

| Setting | |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | e.g. `my-store.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | The access token (secret) |
| `SHOPIFY_API_VERSION` | Optional; defaults to `2025-10` |

All are shared by default; give an agent its own to work with a
different store.

## Permissions

| Tool | Default | Why |
| --- | --- | --- |
| `shopify_find_orders`, `shopify_get_order`, `shopify_preview_refund` | allow | Read only |
| `shopify_create_refund` | ask | Sends real money back and can't be undone |

Change these in the agent's Permissions tab. To let small refunds through,
allow `shopify_create_refund` with a `when` condition on `amount` rather
than for everything.
