const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id:"rzp_test_SfMtidSC2jNlKv",
  key_secret:"J0602kdzog1P51R0HWvfLPmk",
});

app.get("/", (req, res) => {
  res.send("Server running");
});

app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const options = {
      amount: amount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    console.log(err);
    res.status(500).send("Error creating order");
  }
});

app.listen(5000, "0.0.0.0", () => {
  console.log("Server running on port 5000");
});