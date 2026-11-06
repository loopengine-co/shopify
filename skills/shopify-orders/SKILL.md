---
name: shopify-orders
description: How to use the @loopengine-co/shopify tools to answer questions about an order — status, delivery, what was paid and refunded — and to propose and make a refund with the right amount, previewed first.
---

# Shopify orders

The @loopengine-co/shopify tools read the store's orders and can refund them
(refunds ask a person first). Get the facts from the order every time;
never answer from memory or guess.

## Find the order

`shopify_find_orders` with the order number ("#1042") when the customer
gives one. Otherwise search by their `email`. If several orders match,
pick by date and items, and say which one you mean. If none match,
ask the customer for the order number; don't guess.

Then read it with `shopify_get_order`.

## Answer from the order

- **Where is it?** Look at `shipments`: carrier, tracking number and
  link, shipped and delivered dates. Give the tracking link. If nothing
  has shipped, say so and use the fulfilment status.
- **What did I pay / was I refunded?** Use `totals` and `refunds`. A
  refund usually takes 5–10 business days to reach a card; say that,
  not "today".
- **Cancelled?** `cancelled` says when and why.

## Refunds: preview, then propose, then refund

1. Check the request against the store's return policy (and the order:
   is it delivered, how long ago, was this item already refunded —
   compare `quantity` with `refundable_quantity`).
2. Choose what to refund:
   - items: `line_items` with each `line_item_id` and quantity, from
     `shopify_get_order`;
   - shipping: `refund_shipping` for all of it, or `shipping_amount`;
   - or a custom `amount`, e.g. a partial refund for a damaged item the
     customer keeps.
3. Run `shopify_preview_refund` with exactly that. Shopify works out the
   amount (with the item's discounts and tax) and where it goes back to.
4. Propose it with the previewed amount and one line of reasoning, e.g.
   "Refund 1 × Ceramic Mug, 18.50 USD to the card: arrived cracked,
   within the 30-day policy."
5. Only then call `shopify_create_refund` with the same inputs and a
   `note` saying why. It asks a person first.

Never state a refund amount you haven't previewed. Never refund an
order twice: check `refunds` first. Items are not restocked by these
tools; say so if the item comes back to the warehouse.

## Things never to do

- Never share one customer's order details with someone who isn't that
  customer (check the email matches the order).
- Never promise a refund before a person has approved it; say it's
  being reviewed.
