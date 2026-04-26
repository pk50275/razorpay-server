const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

// ⚠️ IMPORTANT: webhook के लिए raw body चाहिए
app.use("/webhook", express.raw({ type: "*/*" }));

app.use(cors());
app.use(express.json());

// ================= FIREBASE =================
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("Firebase connected");
} catch (err) {
  console.error("Firebase init error:", err.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// ================= RAZORPAY =================
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET,
});

// 🔒 webhook secret (dashboard से लेना)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ================= TEST =================
app.get("/", (req, res) => {
  res.send("Server is running");
});

// ================= CREATE ORDER =================
app.post("/create-order", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: "Firebase not initialized" });
    }

    let { formId, gender, caste } = req.body;

    if (!formId || !gender || !caste) {
      return res.status(400).json({ error: "Invalid request" });
    }

    formId = formId.toString().trim();
    gender = gender.toString().toLowerCase().trim();
    caste = caste.toString().toLowerCase().trim();

    const formDoc = await db.collection("forms").doc(formId).get();

    if (!formDoc.exists) {
      return res.status(404).json({ error: "Form not found" });
    }

    const formData = formDoc.data();

    const fee = formData?.fees?.[gender]?.[caste];

    if (fee === undefined) {
      return res.status(400).json({ error: "Fee not defined" });
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
    console.error("CREATE ORDER ERROR:", err);
    return res.status(500).json({ error: "Order creation failed" });
  }
});

// ================= VERIFY PAYMENT =================
app.post("/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      return res.json({ success: true });
    } else {
      return res.status(400).json({ success: false });
    }
  } catch (err) {
    return res.status(500).json({ error: "Verification failed" });
  }
});

// ================= 🚀 WEBHOOK =================
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];

    const expectedSignature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(req.body)
      .digest("hex");

    if (expectedSignature !== signature) {
      console.log("❌ Invalid webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString());

    console.log("🔥 EVENT:", event.event);

    // ================= PAYMENT SUCCESS =================
    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;

      const orderId = payment.order_id;
      const paymentId = payment.id;

      const snap = await db
        .collection("applications")
        .where("orderId", "==", orderId)
        .limit(1)
        .get();

      if (!snap.empty) {
        const docRef = snap.docs[0].ref;

        await docRef.update({
          paymentStatus: "success",
          status: "submitted",
          paymentId: paymentId,
          updatedAt: new Date(),
        });

        console.log("✅ Webhook success updated");
      }
    }

    // ================= PAYMENT FAILED =================
    if (event.event === "payment.failed") {
      const payment = event.payload.payment.entity;

      const orderId = payment.order_id;

      const snap = await db
        .collection("applications")
        .where("orderId", "==", orderId)
        .limit(1)
        .get();

      if (!snap.empty) {
        const docRef = snap.docs[0].ref;

        await docRef.update({
          paymentStatus: "failed",
          status: "pending",
          updatedAt: new Date(),
        });

        console.log("❌ Webhook failed updated");
      }
    }

    res.status(200).send("OK");

  } catch (err) {
    console.log("Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ================= START =================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});