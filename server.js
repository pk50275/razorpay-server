const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET,
});

// ✅ ROOT ROUTE (FIX)
app.get("/", (req, res) => {
  res.send("Server running");
});

// 🔥 CREATE ORDER
app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Amount required" });
    }

    const options = {
      amount: amount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);

    res.json({
      id: order.id,
      amount: order.amount,
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// 🔐 VERIFY PAYMENT
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
      .update(body.toString())
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
    console.log(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

app.listen(5000, "0.0.0.0", () => {
  console.log("Server running on port 5000");
});