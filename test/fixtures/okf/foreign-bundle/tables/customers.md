---
type: BigQuery Table
title: Customers
description: One row per registered customer.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=customers
tags: [sales, customers]
timestamp: 2026-05-28T00:00:00Z
---

# Schema

| Column        | Type   | Description                     |
|---------------|--------|---------------------------------|
| `customer_id` | STRING | Globally unique customer id.    |
| `email`       | STRING | Primary contact email address.  |

Referenced by [orders](/tables/orders.md). Also links to a
[not-yet-written concept](/tables/refunds.md) — consumers MUST tolerate
broken links (spec §5.3).
