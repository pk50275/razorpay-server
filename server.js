// 🔥 ONLY CHANGE INSIDE CREATE ORDER (SAFE MATCH)

const clean = (str) =>
  str.toString().toLowerCase().replace(/[^a-z]/g, "");

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
    gender = clean(gender);
    caste = clean(caste);

    console.log("🔍 Incoming:", { formId, gender, caste });

    const formDoc = await db.collection("forms").doc(formId).get();

    if (!formDoc.exists) {
      return res.status(404).json({ error: "Form not found" });
    }

    const formData = formDoc.data();

    // 🔥 SAFE MATCH (KEY CLEANING)
    const fees = formData.fees || {};

    const genderKey = Object.keys(fees).find(
      (g) => clean(g) === gender
    );

    if (!genderKey) {
      return res.status(400).json({ error: "Gender not found" });
    }

    const casteKey = Object.keys(fees[genderKey]).find(
      (c) => clean(c) === caste
    );

    if (!casteKey) {
      return res.status(400).json({ error: "Caste not found" });
    }

    const fee = fees[genderKey][casteKey];

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
      fee,
    });

  } catch (err) {
    console.error("❌ ERROR:", err);
    return res.status(500).json({ error: "Order creation failed" });
  }
});