// Subscription billing. Real Stripe Checkout when PLATFORM_BILLING_REAL=true and
// a secret key is present; otherwise a simulated subscription so onboarding
// completes end to end without a Stripe account.
import { createHmac, timingSafeEqual } from "node:crypto";

const REAL = process.env.PLATFORM_BILLING_REAL === "true";

// Verify a Stripe webhook signature (the `Stripe-Signature` header) against the
// raw request body. Implements Stripe's scheme without the SDK. Throws on
// mismatch / stale timestamp.
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(
    String(header || "").split(",").map((kv) => kv.split("=").map((s) => s.trim()))
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) throw Object.assign(new Error("malformed Stripe-Signature"), { statusCode: 400 });
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) {
    throw Object.assign(new Error("stale webhook timestamp"), { statusCode: 400 });
  }
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("invalid webhook signature"), { statusCode: 400 });
  }
  return true;
}

async function stripe() {
  if (!REAL || !process.env.STRIPE_SECRET_KEY) return null;
  try {
    const Stripe = (await import("stripe")).default;
    return new Stripe(process.env.STRIPE_SECRET_KEY);
  } catch (err) {
    console.warn("[billing] stripe unavailable, simulating:", err.message);
    return null;
  }
}

// Create a subscription/checkout for a customer on a tier.
export async function createSubscription(customer, tier) {
  const s = await stripe();
  if (!s) {
    return {
      subscriptionId: `SIMSUB-${customer.id}`,
      status: "active",
      tier: tier.id,
      priceUsdMonthly: tier.priceUsdMonthly,
      simulated: true,
    };
  }
  if (tier.priceUsdMonthly == null) {
    return { status: "contact_sales", tier: tier.id, simulated: false };
  }
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer_email: customer.email,
    metadata: { customerId: customer.id },
    subscription_data: { metadata: { customerId: customer.id } },
    line_items: [
      {
        price_data: {
          currency: "usd",
          recurring: { interval: "month" },
          unit_amount: tier.priceUsdMonthly * 100,
          product_data: { name: `Aether Mesh — ${tier.name}` },
        },
        quantity: 1,
      },
    ],
    success_url: `${process.env.PLATFORM_PUBLIC_URL || ""}/dashboard?customer=${customer.id}`,
    cancel_url: `${process.env.PLATFORM_PUBLIC_URL || ""}/?canceled=1`,
  });
  return { checkoutUrl: session.url, subscriptionId: session.id, status: "pending", simulated: false };
}

// Create a checkout session for a customer (on any tier), optionally including the Cloud Deploy add-on
export async function createCheckoutSession(customer, tier, addCloudDeploy = false) {
  const s = await stripe();
  const baseUrl = process.env.PLATFORM_PUBLIC_URL || "http://localhost:8080";
  const successUrl = `${baseUrl}/dashboard.html?customer=${customer.id}&checkout_success=true`;
  const cancelUrl = `${baseUrl}/dashboard.html?checkout_cancel=true`;

  if (!s) {
    // Simulated checkout URL
    return {
      checkoutUrl: successUrl,
      simulated: true,
    };
  }

  const tierKey = String(tier).toUpperCase(); // e.g. INTERN, MANAGER, ENTERPRISE
  const basePriceId = process.env[`STRIPE_PRICE_${tierKey}`];
  if (!basePriceId) {
    throw new Error(`Stripe price env key STRIPE_PRICE_${tierKey} is unset`);
  }

  const lineItems = [{ price: basePriceId, quantity: 1 }];

  if (addCloudDeploy) {
    const cloudPriceId = process.env[`STRIPE_PRICE_CLOUD_${tierKey}`];
    if (!cloudPriceId) {
      throw new Error(`Stripe price env key STRIPE_PRICE_CLOUD_${tierKey} is unset`);
    }
    lineItems.push({ price: cloudPriceId, quantity: 1 });
  }

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer_email: customer.email,
    metadata: {
      customerId: customer.id,
      tier: tier,
      cloudDeploy: String(addCloudDeploy),
    },
    subscription_data: {
      metadata: {
        customerId: customer.id,
        tier: tier,
        cloudDeploy: String(addCloudDeploy),
      },
    },
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
    simulated: false,
  };
}

// Create a Razorpay Order for subscriptions (amounts converted to INR paise)
export async function createRazorpayOrder(customer, tier, addCloudDeploy = false) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;

  let amountUsd = 19;
  const tId = typeof tier === "string" ? tier : (tier.id || "intern");
  if (tId === "intern") amountUsd = 19;
  if (tId === "manager") amountUsd = 49;

  if (addCloudDeploy) {
    amountUsd += (tId === "intern" ? 15 : 29);
  }

  // Convert to INR paise (cents) using 1 USD = 83 INR rate
  const amountInrPaise = Math.round(amountUsd * 83 * 100);

  if (!keyId || !secret) {
    // Simulated order
    return {
      orderId: `SIMORDER-${Math.random().toString(36).substring(2, 11).toUpperCase()}`,
      amount: amountInrPaise,
      currency: "INR",
      keyId: "rzp_test_mockkeyid",
      simulated: true,
    };
  }

  // Real HTTP basic auth to Razorpay Orders API
  const auth = Buffer.from(`${keyId}:${secret}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
    },
    body: JSON.stringify({
      amount: amountInrPaise,
      currency: "INR",
      receipt: `rcpt_${customer.id}_${Date.now()}`,
      notes: {
        customerId: customer.id,
        tier: tId,
        cloudDeploy: String(addCloudDeploy),
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg = `HTTP error ${response.status}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.error?.description) errMsg = errJson.error.description;
    } catch {}
    throw new Error(`Razorpay API error: ${errMsg}`);
  }

  const order = await response.json();
  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: keyId,
    simulated: false,
  };
}

// Verify a Razorpay payment signature
export function verifyRazorpaySignature(paymentId, orderId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return true; // Simulated payment auto-verifies

  const text = `${orderId}|${paymentId}`;
  const expected = createHmac("sha256", secret).update(text).digest("hex");
  return expected === signature;
}


