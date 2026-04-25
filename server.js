const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   🔐 FIREBASE INIT (SAFE)
========================= */
let serviceAccount;

try {
  if (!process.env.FIREBASE_KEY) {
    throw new Error("FIREBASE_KEY missing in env");
  }

  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("✅ Firebase connected");

} catch (err) {
  console.error("❌ Firebase init error:", err.message);
}

/* =========================
   📦 FIRESTORE
========================= */
const db = admin.apps.length ? admin.firestore() : null;

/* =========================
   💳 RAZORPAY INIT
========================= */
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET,
});

/* =========================
   🟢 ROOT CHECK
========================= */
app.get("/", (req, res) => {
  res.send("🚀 Server is running");
});

/* =========================
   🔥 CREATE ORDER
========================= */
app.post("/create-order", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: "Firebase not initialized" });
    }

    const { formId, gender, caste } = req.body;

    if (!formId || !gender || !caste) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const formDoc = await db.collection("forms").doc(formId).get();

    if (!formDoc.exists) {
      return res.status(404).json({ error: "Form not found" });
    }

    const formData = formDoc.data();

    const fee = formData?.fees?.[gender]?.[caste];

    if (fee === undefined || fee === null) {
      return res.status(400).json({ error: "Fee not defined" });
    }

    if (typeof fee !== "number") {
      return res.status(400).json({ error: "Invalid fee format" });
    }

    const order = await razorpay.orders.create({
      amount: fee * 100,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    return res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      fee: fee,
    });

  } catch (err) {
    console.error("❌ CREATE ORDER ERROR:", err);
    return res.status(500).json({ error: "Order creation failed" });
  }
});

/* =========================
   🔐 VERIFY PAYMENT
========================= */
app.post("/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment data" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      return res.json({ success: true });
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid signature",
      });
    }

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

/* =========================
   🚀 SERVER START
========================= */
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🔥 Server running on port ${PORT}`);
});