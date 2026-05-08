/**
 * stripe-routes.cjs — Stripe payment integration for PDFRealm
 * Factory function: module.exports = function({ pool })
 * Returns: { router, webhookHandler }
 *
 * Routes:
 *   POST /api/stripe/create-checkout-session
 *   POST /api/stripe/webhook          (raw body - registered separately in server.js before express.json)
 *   GET  /api/stripe/portal
 *   GET  /api/stripe/subscription-status
 */

"use strict";

const express = require("express");
const crypto = require("crypto");

const PRICE_IDS = {
  ppe:               process.env.STRIPE_PPE_PRICE_ID              || "price_1TGOSZKEsXpHR2OdkAUK00Ft",
  pro_monthly:       process.env.STRIPE_PRO_MONTHLY_PRICE_ID      || "price_1TGOQeKEsXpHR2OdMGS8oe7I",
  pro_annual:        process.env.STRIPE_PRO_ANNUAL_PRICE_ID       || "price_1TGOOyKEsXpHR2OdVFcbCXfe",
  business_monthly:  process.env.STRIPE_BUSINESS_MONTHLY_PRICE_ID || "price_1TGOTjKEsXpHR2OdDbu4tKxh",
  business_annual:   process.env.STRIPE_BUSINESS_ANNUAL_PRICE_ID  || "price_1TGOUzKEsXpHR2Odzs5cCKkn",
  vault_addon:       process.env.STRIPE_VAULT_ADDON_PRICE_ID      || "price_1TGOW1KEsXpHR2Odsdu0jKU9",
};

const SUBSCRIPTION_PLANS = new Set([
  "pro_monthly", "pro_annual",
  "business_monthly", "business_annual",
  "vault_addon",
]);

function getBaseUrl() {
  return (process.env.BASE_URL || "https://pdfrealm.com").replace(/\/$/, "");
}

function planToTier(plan) {
  if (!plan) return "none";
  const p = String(plan).toLowerCase();
  if (p.startsWith("pro")) return "pro";
  if (p.startsWith("business")) return "business";
  if (p === "ppe") return "ppe";
  if (p.startsWith("vault")) return "vault_addon";
  return "none";
}

// Lazy Stripe init (so missing key doesn't crash startup)
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  _stripe = require("stripe")(key);
  return _stripe;
}

// ─── getUserFromReq helper (mirrors server.js logic) ─────────────────────────
function parseReqCookies(req) {
  const out = {};
  const raw = (req && req.headers && req.headers.cookie) ? String(req.headers.cookie) : "";
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function getUserFromReq(req, JWT_SECRET) {
  const jwt = require("jsonwebtoken");
  const auth = req.headers["authorization"] || "";
  let token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    const cookies = parseReqCookies(req);
    token = cookies.pdfrealm_token || cookies.token || cookies.auth_token || cookies.jwt || "";
  }
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET || process.env.JWT_SECRET || "pdfrealm-dev-secret");
  } catch {
    return null;
  }
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function safeHasColumn(pool, table, column) {
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
      [table, column]
    );
    return r.rowCount > 0;
  } catch { return false; }
}

async function safeHasTable(pool, table) {
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
      [table]
    );
    return r.rowCount > 0;
  } catch { return false; }
}

async function getActiveSubscription(pool, userId) {
  try {
    if (!(await safeHasTable(pool, "subscriptions"))) return null;
    const r = await pool.query(
      `SELECT plan, status, customer_id, subscription_id, vault_quota_gb
       FROM subscriptions
       WHERE user_id=$1 AND status='active'
       ORDER BY created_at DESC LIMIT 1`,
      [String(userId)]
    );
    return r.rows[0] || null;
  } catch { return null; }
}

async function upsertSubscription(pool, { userId, customerId, subscriptionId, plan, status }) {
  if (!(await safeHasTable(pool, "subscriptions"))) return;

  // Try UPDATE first (if row by subscription_id exists)
  const hasPlan          = await safeHasColumn(pool, "subscriptions", "plan");
  const hasStatus        = await safeHasColumn(pool, "subscriptions", "status");
  const hasCustomerId    = await safeHasColumn(pool, "subscriptions", "customer_id");
  const hasSubscriptionId= await safeHasColumn(pool, "subscriptions", "subscription_id");
  const hasUpdatedAt     = await safeHasColumn(pool, "subscriptions", "updated_at");

  // Check if row exists for this subscription_id
  if (hasSubscriptionId && subscriptionId) {
    const existing = await pool.query(
      `SELECT id FROM subscriptions WHERE subscription_id=$1 LIMIT 1`,
      [subscriptionId]
    );
    if (existing.rowCount > 0) {
      const sets = [];
      const args = [];
      if (hasPlan)    { args.push(plan);           sets.push(`plan=$${args.length}`); }
      if (hasStatus)  { args.push(status);          sets.push(`status=$${args.length}`); }
      if (hasCustomerId && customerId) { args.push(customerId); sets.push(`customer_id=$${args.length}`); }
      if (hasUpdatedAt) sets.push("updated_at=NOW()");
      if (sets.length) {
        args.push(subscriptionId);
        await pool.query(
          `UPDATE subscriptions SET ${sets.join(",")} WHERE subscription_id=$${args.length}`,
          args
        );
      }
      return;
    }
  }

  // Insert
  const cols = ["user_id"];
  const vals = ["$1"];
  const args = [String(userId)];

  const add = (col, val) => {
    if (val == null) return;
    args.push(val);
    cols.push(col);
    vals.push(`$${args.length}`);
  };

  if (hasCustomerId)     add("customer_id", customerId);
  if (hasSubscriptionId) add("subscription_id", subscriptionId);
  if (hasPlan)           add("plan", plan);
  if (hasStatus)         add("status", status);
  if (await safeHasColumn(pool, "subscriptions", "created_at")) { cols.push("created_at"); vals.push("NOW()"); }
  if (hasUpdatedAt) { cols.push("updated_at"); vals.push("NOW()"); }

  try {
    await pool.query(
      `INSERT INTO subscriptions (${cols.join(",")}) VALUES (${vals.join(",")})
       ON CONFLICT DO NOTHING`,
      args
    );
  } catch (e) {
    // If conflict constraint differs, try plain insert ignoring error
    await pool.query(
      `INSERT INTO subscriptions (${cols.join(",")}) VALUES (${vals.join(",")})`,
      args
    ).catch(() => {});
  }
}

async function deactivateSubscription(pool, subscriptionId) {
  if (!subscriptionId || !(await safeHasTable(pool, "subscriptions"))) return;
  try {
    await pool.query(
      `UPDATE subscriptions SET status='inactive', updated_at=NOW()
       WHERE subscription_id=$1`,
      [subscriptionId]
    );
  } catch {}
}

async function createPpeSession(pool, { userId, sessionToken }) {
  if (!(await safeHasTable(pool, "pay_per_export_sessions"))) return;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const cols = ["token", "expires_at"];
  const vals = ["$1", "$2"];
  const args = [sessionToken, expiresAt];

  if (userId && await safeHasColumn(pool, "pay_per_export_sessions", "user_id")) {
    args.push(String(userId));
    cols.push("user_id");
    vals.push(`$${args.length}`);
  }
  if (await safeHasColumn(pool, "pay_per_export_sessions", "created_at")) {
    cols.push("created_at");
    vals.push("NOW()");
  }

  try {
    await pool.query(
      `INSERT INTO pay_per_export_sessions (${cols.join(",")}) VALUES (${vals.join(",")})`,
      args
    );
  } catch {}
}

async function getUserIdByCustomerId(pool, customerId) {
  if (!(await safeHasTable(pool, "subscriptions"))) return null;
  if (!(await safeHasColumn(pool, "subscriptions", "customer_id"))) return null;
  try {
    const r = await pool.query(
      `SELECT user_id FROM subscriptions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    );
    return r.rows[0]?.user_id || null;
  } catch { return null; }
}

// ─── Factory ────────────────────────────────────────────────────────────────

module.exports = function createStripeRoutes({ pool }) {
  const router = express.Router();

  // ── POST /create-checkout-session ────────────────────────────────────────
  router.post("/create-checkout-session", async (req, res) => {
    try {
      const stripe = getStripe();
      const plan = String(req.body?.plan || "").trim();
      const priceId = PRICE_IDS[plan];
      if (!priceId) {
        return res.status(400).json({
          ok: false,
          error: `Unknown plan '${plan}'. Valid plans: ${Object.keys(PRICE_IDS).join(", ")}`,
        });
      }

      const base = getBaseUrl();
      const isPpe = plan === "ppe";
      const mode  = isPpe ? "payment" : "subscription";

      const sessionParams = {
        mode,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}/payment-success?session_id={CHECKOUT_SESSION_ID}&plan=${encodeURIComponent(plan)}`,
        cancel_url:  `${base}/pricing`,
        metadata: { plan },
      };

      // Attach customer if user is logged in
      const user = getUserFromReq(req);
      if (user && user.email) sessionParams.customer_email = user.email;

      const session = await stripe.checkout.sessions.create(sessionParams);
      return res.json({ ok: true, url: session.url, session_id: session.id });
    } catch (e) {
      console.error("[stripe] create-checkout-session error:", e.message || e);
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── GET /portal ───────────────────────────────────────────────────────────
  router.get("/portal", async (req, res) => {
    try {
      const stripe = getStripe();
      const user = getUserFromReq(req);
      if (!user) return res.status(401).json({ ok: false, error: "Not logged in." });

      // Find customer_id from DB
      const sub = await getActiveSubscription(pool, user.id);
      if (!sub || !sub.customer_id) {
        return res.status(400).json({
          ok: false,
          error: "No active subscription found. If you just subscribed, please wait a moment and try again.",
        });
      }

      const base = getBaseUrl();
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.customer_id,
        return_url: `${base}/account`,
      });

      return res.json({ ok: true, url: session.url });
    } catch (e) {
      console.error("[stripe] portal error:", e.message || e);
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── GET /subscription-status ─────────────────────────────────────────────
  router.get("/subscription-status", async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user) return res.status(401).json({ ok: false, error: "Not logged in." });

      const sub = await getActiveSubscription(pool, user.id);
      if (!sub) {
        return res.json({ ok: true, tier: "none", plan: null, vault_quota_gb: 0 });
      }

      const tier = planToTier(sub.plan);
      return res.json({
        ok: true,
        tier,
        plan: sub.plan,
        status: sub.status,
        vault_quota_gb: Number(sub.vault_quota_gb || 0),
      });
    } catch (e) {
      console.error("[stripe] subscription-status error:", e.message || e);
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ── Webhook handler (exported separately; needs raw body) ─────────────────
  async function webhookHandler(req, res) {
    try {
      const stripe = getStripe();
      const sig = req.headers["stripe-signature"];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      // Construct event — verifies signature if webhook secret is set
      let event;
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(
        typeof req.body === "string" ? req.body : JSON.stringify(req.body || {})
      );

      if (webhookSecret && sig) {
        try {
          event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
        } catch (err) {
          console.error("[stripe] webhook signature verification failed:", err.message);
          return res.status(400).json({ error: `Webhook signature: ${err.message}` });
        }
      } else {
        // No secret configured (dev mode) — parse body directly
        try {
          event = typeof req.body === "object" && req.body.type
            ? req.body
            : JSON.parse(rawBody.toString());
        } catch (e) {
          return res.status(400).json({ error: "Invalid JSON body" });
        }
        if (!webhookSecret) {
          console.warn("[stripe] STRIPE_WEBHOOK_SECRET not set — skipping signature verification (dev mode)");
        }
      }

      const eventType = event.type;
      console.log("[stripe] webhook:", eventType);

      if (eventType === "checkout.session.completed") {
        const session = event.data.object;
        const plan = session.metadata?.plan || "";
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        // Find user by customer_id or email
        let userId = await getUserIdByCustomerId(pool, customerId);
        if (!userId && session.customer_details?.email) {
          // Try to find user by email
          try {
            if (await safeHasTable(pool, "users")) {
              const ur = await pool.query(
                `SELECT id FROM users WHERE email=$1 LIMIT 1`,
                [session.customer_details.email]
              );
              userId = ur.rows[0]?.id || null;
            }
          } catch {}
        }

        if (plan === "ppe") {
          // Pay-Per-Export: create 24h session
          const ppeToken = crypto.randomBytes(32).toString("base64url");
          await createPpeSession(pool, { userId, sessionToken: ppeToken });

          // Return token via Set-Cookie so payment-success page can pick it up
          res.cookie("pdfrealm_ppe_session", ppeToken, {
            maxAge: 24 * 60 * 60 * 1000,
            httpOnly: false,
            sameSite: "Lax",
            path: "/",
          });
        } else if (SUBSCRIPTION_PLANS.has(plan)) {
          if (userId) {
            await upsertSubscription(pool, {
              userId,
              customerId,
              subscriptionId,
              plan,
              status: "active",
            });

            // Handle vault addon: increase vault quota
            if (plan === "vault_addon" && await safeHasTable(pool, "subscriptions")) {
              try {
                await pool.query(
                  `UPDATE subscriptions SET vault_quota_gb = COALESCE(vault_quota_gb, 0) + 1000
                   WHERE user_id=$1 AND status='active'`,
                  [String(userId)]
                );
              } catch {}
            }
          } else {
            console.warn("[stripe] checkout.session.completed: could not find user for customer", customerId);
          }
        }
      } else if (eventType === "customer.subscription.deleted") {
        const subscription = event.data.object;
        await deactivateSubscription(pool, subscription.id);

      } else if (eventType === "customer.subscription.updated") {
        const subscription = event.data.object;
        const status = subscription.status;
        if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
          await deactivateSubscription(pool, subscription.id);
        } else if (status === "active") {
          // Re-activate if it comes back
          try {
            if (await safeHasTable(pool, "subscriptions")) {
              await pool.query(
                `UPDATE subscriptions SET status='active', updated_at=NOW()
                 WHERE subscription_id=$1`,
                [subscription.id]
              );
            }
          } catch {}
        }
      }

      return res.json({ received: true });
    } catch (e) {
      console.error("[stripe] webhook error:", e.message || e);
      return res.status(500).json({ error: String(e.message || e) });
    }
  }

  return { router, webhookHandler };
};
