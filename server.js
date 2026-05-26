const express = require("express");

const Razorpay = require("razorpay");

const cors = require("cors");

const crypto = require("crypto");

const admin = require("firebase-admin");

const app = express();

// ================= RAW BODY =================

app.use(
  "/webhook",
  express.raw({
    type: "*/*",
  }),
);

app.use(cors());

app.use(express.json());

// ================= FIREBASE =================

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_KEY,
  );

  admin.initializeApp({
    credential:
      admin.credential.cert(
        serviceAccount,
      ),
  });

  console.log(
    "Firebase connected",
  );
} catch (err) {
  console.error(
    "Firebase init error:",
    err.message,
  );
}

const db = admin.apps.length
  ? admin.firestore()
  : null;

const {
  FieldValue,
} = admin.firestore;

// ================= RAZORPAY =================

const razorpay =
  new Razorpay({
    key_id:
      process.env.KEY_ID,

    key_secret:
      process.env.KEY_SECRET,
  });

// ================= SECRETS =================

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET;

// ================= TEST =================

app.get("/", (req, res) => {
  res.send(
    "Server is running",
  );
});

// ================= WEBHOOK IDEMPOTENCY =================

async function
  isWebhookAlreadyProcessed({
    paymentId,
    event,
  }) {
  const documentId =
    `${paymentId}_${event}`;

  const snapshot =
    await db
      .collection(
        "payment_webhook_idempotency",
      )
      .doc(documentId)
      .get();

  return snapshot.exists;
}

async function
  markWebhookProcessed({
    paymentId,
    event,
  }) {
  const documentId =
    `${paymentId}_${event}`;

  await db
    .collection(
      "payment_webhook_idempotency",
    )
    .doc(documentId)
    .set({
      paymentId,

      event,

      processedAt:
        FieldValue.serverTimestamp(),
    });
}

// ================= WEBHOOK AUDIT =================

async function
  createWebhookAudit({
    verified,
    event,
    paymentId,
    orderId,
    status,
    payload,
    error = "",
  }) {
  await db
    .collection(
      "payment_webhook_audits",
    )
    .add({
      verified,

      event,

      paymentId,

      orderId,

      status,

      payload,

      error,

      createdAt:
        FieldValue.serverTimestamp(),
    });
}

// ================= RECONCILIATION =================

async function
  createReconciliationLog({
    paymentId,
    orderId,
    event,
    status,
    applicationId = "",
    reconciliationStatus,
  }) {
  await db
    .collection(
      "payment_reconciliation_logs",
    )
    .add({
      paymentId,

      orderId,

      event,

      status,

      applicationId,

      reconciliationStatus,

      createdAt:
        FieldValue.serverTimestamp(),
    });
}

// ================= STAFF ASSIGNMENT =================

async function
  assignStaffAtomically({
    applicationReference,
    selectedStaff,
    paymentId,
  }) {
  await db.runTransaction(
    async (
      transaction,
    ) => {
      const staffReference =
        db
          .collection(
            "staff",
          )
          .doc(
            selectedStaff.id,
          );

      const freshStaffDocument =
        await transaction.get(
          staffReference,
        );

      if (
        !freshStaffDocument.exists
      ) {
        throw new Error(
          "Staff not found",
        );
      }

      const freshStaffData =
        freshStaffDocument.data();

      if (
        freshStaffData
          ?.active !== true
      ) {
        throw new Error(
          "Staff inactive",
        );
      }

      transaction.update(
        applicationReference,
        {
          paymentStatus:
            "success",

          paymentId:
            paymentId,

          status:
            "submitted",

          assignedStaffId:
            selectedStaff.id,

          assignedStaffName:
            selectedStaff.name ||
            "",

          assignedAt:
            new Date(),

          updatedAt:
            new Date(),
        },
      );

      transaction.update(
        staffReference,
        {
          pendingLoad:
            FieldValue.increment(
              1,
            ),
        },
      );
    },
  );
}

// ================= HELPERS =================

function normalizeString(
  value,
) {
  return value
    ?.toString()
    .trim();
}

function normalizeLowerString(
  value,
) {
  return value
    ?.toString()
    .toLowerCase()
    .trim();
}

// ================= CREATE ORDER =================

app.post(
  "/create-order",
  async (req, res) => {
    try {
      if (!db) {
        return res
          .status(500)
          .json({
            error:
              "Firebase not initialized",
          });
      }

      let {
        formId,
        gender,
        caste,
      } = req.body;

      if (
        !formId ||
        !gender ||
        !caste
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid request",
          });
      }

      formId =
        normalizeString(
          formId,
        );

      gender =
        normalizeLowerString(
          gender,
        );

      caste =
        normalizeLowerString(
          caste,
        );

      const formDoc =
        await db
          .collection("forms")
          .doc(formId)
          .get();

      if (!formDoc.exists) {
        return res
          .status(404)
          .json({
            error:
              "Form not found",
          });
      }

      const formData =
        formDoc.data();

      const fee =
        formData?.fees?.[
          gender
        ]?.[caste];

      if (
        fee === undefined
      ) {
        return res
          .status(400)
          .json({
            error:
              "Fee not defined",
          });
      }

      const order =
        await razorpay.orders.create(
          {
            amount:
              fee * 100,

            currency:
              "INR",

            receipt:
              `receipt_${Date.now()}`,

            notes: {
              formId,
            },
          },
        );

      return res.json({
        success: true,

        orderId:
          order.id,

        amount:
          order.amount,

        fee,
      });
    } catch (err) {
      console.error(
        "CREATE ORDER ERROR:",
        err,
      );

      return res
        .status(500)
        .json({
          error:
            "Order creation failed",
        });
    }
  },
);

// ================= VERIFY PAYMENT =================

app.post(
  "/verify-payment",
  async (
    req,
    res,
  ) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = req.body;

      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              "Missing payment data",
          });
      }

      const body =
        `${razorpay_order_id}|${razorpay_payment_id}`;

      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            process.env
              .KEY_SECRET,
          )
          .update(body)
          .digest("hex");

      if (
        expectedSignature !==
        razorpay_signature
      ) {
        await createWebhookAudit(
          {
            verified:
              false,

            event:
              "client_verification_failed",

            paymentId:
              razorpay_payment_id,

            orderId:
              razorpay_order_id,

            status:
              "failed",

            payload:
              req.body,

            error:
              "Invalid payment signature",
          },
        );

        return res
          .status(400)
          .json({
            success: false,
          });
      }

      await createWebhookAudit(
        {
          verified: true,

          event:
            "client_verification_success",

          paymentId:
            razorpay_payment_id,

          orderId:
            razorpay_order_id,

          status:
            "verified",

          payload:
            req.body,
        },
      );

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "VERIFY PAYMENT ERROR:",
        err,
      );

      return res
        .status(500)
        .json({
          error:
            "Verification failed",
        });
    }
  },
);

// ================= WEBHOOK =================

app.post(
  "/webhook",
  async (req, res) => {
    try {
      const signature =
        req.headers[
          "x-razorpay-signature"
        ];

      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            WEBHOOK_SECRET,
          )
          .update(req.body)
          .digest("hex");

      if (
        expectedSignature !==
        signature
      ) {
        console.log(
          "Invalid webhook signature",
        );

        await createWebhookAudit(
          {
            verified:
              false,

            event:
              "invalid_signature",

            paymentId: "",

            orderId: "",

            status:
              "failed",

            payload:
              req.body.toString(),

            error:
              "Invalid webhook signature",
          },
        );

        return res
          .status(400)
          .send(
            "Invalid signature",
          );
      }

      const event =
        JSON.parse(
          req.body.toString(),
        );

      console.log(
        "EVENT:",
        event.event,
      );

      // ================= PAYMENT CAPTURED =================

      if (
        event.event ===
        "payment.captured"
      ) {
        const payment =
          event.payload
            .payment.entity;

        const orderId =
          payment.order_id;

        const paymentId =
          payment.id;

        await createWebhookAudit(
          {
            verified: true,

            event:
              event.event,

            paymentId,

            orderId,

            status:
              payment.status,

            payload: event,
          },
        );

        const alreadyProcessed =
          await isWebhookAlreadyProcessed(
            {
              paymentId,

              event:
                event.event,
            },
          );

        if (
          alreadyProcessed
        ) {
          console.log(
            "Duplicate webhook ignored",
          );

          return res
            .status(200)
            .send(
              "Already processed",
            );
        }

        const applicationSnapshot =
          await db
            .collection(
              "applications",
            )
            .where(
              "orderId",
              "==",
              orderId,
            )
            .limit(1)
            .get();

        if (
          applicationSnapshot.empty
        ) {
          await createReconciliationLog(
            {
              paymentId,

              orderId,

              event:
                event.event,

              status:
                payment.status,

              reconciliationStatus:
                "application_missing",
            },
          );

          await markWebhookProcessed(
            {
              paymentId,

              event:
                event.event,
            },
          );

          return res
            .status(200)
            .send(
              "Application missing",
            );
        }

        const applicationDocument =
          applicationSnapshot
            .docs[0];

        const appRef =
          applicationDocument.ref;

        const applicationData =
          applicationDocument.data();

        if (
          applicationData
            ?.paymentStatus ===
          "success"
        ) {
          await markWebhookProcessed(
            {
              paymentId,

              event:
                event.event,
            },
          );

          return res
            .status(200)
            .send(
              "Already verified",
            );
        }

        // ================= ACTIVE STAFF =================

        const staffSnapshot =
          await db
            .collection(
              "staff",
            )
            .where(
              "active",
              "==",
              true,
            )
            .get();

        let staffList =
          [];

        staffSnapshot.forEach(
          (doc) => {
            staffList.push({
              id: doc.id,
              ...doc.data(),
            });
          },
        );

        // ================= NO STAFF =================

        if (
          staffList.length ===
          0
        ) {
          await appRef.update(
            {
              paymentStatus:
                "success",

              paymentId:
                paymentId,

              status:
                "submitted",

              reconciliationStatus:
                "pending_staff_assignment",

              webhookVerified:
                true,

              webhookEvent:
                event.event,

              webhookReceivedAt:
                FieldValue.serverTimestamp(),

              reconciliationUpdatedAt:
                FieldValue.serverTimestamp(),

              updatedAt:
                new Date(),
            },
          );

          await createReconciliationLog(
            {
              paymentId,

              orderId,

              event:
                event.event,

              status:
                payment.status,

              applicationId:
                applicationDocument.id,

              reconciliationStatus:
                "pending_staff_assignment",
            },
          );

          await markWebhookProcessed(
            {
              paymentId,

              event:
                event.event,
            },
          );

          console.log(
            "No active staff found",
          );

          return res
            .status(200)
            .send("OK");
        }

        // ================= LOAD BALANCER =================

        staffList.sort(
          (a, b) => {
            if (
              a.pendingLoad !==
              b.pendingLoad
            ) {
              return (
                a.pendingLoad -
                b.pendingLoad
              );
            }

            if (
              a.completedCount !==
              b.completedCount
            ) {
              return (
                b.completedCount -
                a.completedCount
              );
            }

            return 0;
          },
        );

        const selectedStaff =
          staffList[0];

        // ================= ATOMIC ASSIGNMENT =================

        await assignStaffAtomically(
          {
            applicationReference:
              appRef,

            selectedStaff,

            paymentId,
          },
        );

        await appRef.update({
          reconciliationStatus:
            "verified",

          webhookVerified:
            true,

          webhookEvent:
            event.event,

          webhookReceivedAt:
            FieldValue.serverTimestamp(),

          reconciliationUpdatedAt:
            FieldValue.serverTimestamp(),
        });

        await createReconciliationLog(
          {
            paymentId,

            orderId,

            event:
              event.event,

            status:
              payment.status,

            applicationId:
              applicationDocument.id,

            reconciliationStatus:
              "verified",
          },
        );

        await markWebhookProcessed(
          {
            paymentId,

            event:
              event.event,
          },
        );

        console.log(
          "Assigned to:",
          selectedStaff.name,
        );
      }

      // ================= PAYMENT FAILED =================

      if (
        event.event ===
        "payment.failed"
      ) {
        const payment =
          event.payload
            .payment.entity;

        const orderId =
          payment.order_id;

        const paymentId =
          payment.id;

        await createWebhookAudit(
          {
            verified: true,

            event:
              event.event,

            paymentId,

            orderId,

            status:
              payment.status,

            payload: event,
          },
        );

        const alreadyProcessed =
          await isWebhookAlreadyProcessed(
            {
              paymentId,

              event:
                event.event,
            },
          );

        if (
          alreadyProcessed
        ) {
          console.log(
            "Duplicate failed webhook ignored",
          );

          return res
            .status(200)
            .send(
              "Already processed",
            );
        }

        const applicationSnapshot =
          await db
            .collection(
              "applications",
            )
            .where(
              "orderId",
              "==",
              orderId,
            )
            .limit(1)
            .get();

        if (
          !applicationSnapshot.empty
        ) {
          const applicationDocument =
            applicationSnapshot
              .docs[0];

          const docRef =
            applicationDocument.ref;

          await docRef.update(
            {
              paymentStatus:
                "failed",

              status:
                "pending",

              reconciliationStatus:
                "payment_failed",

              webhookVerified:
                true,

              webhookEvent:
                event.event,

              webhookReceivedAt:
                FieldValue.serverTimestamp(),

              reconciliationUpdatedAt:
                FieldValue.serverTimestamp(),

              updatedAt:
                new Date(),
            },
          );

          await createReconciliationLog(
            {
              paymentId,

              orderId,

              event:
                event.event,

              status:
                payment.status,

              applicationId:
                applicationDocument.id,

              reconciliationStatus:
                "payment_failed",
            },
          );

          await markWebhookProcessed(
            {
              paymentId,

              event:
                event.event,
            },
          );

          console.log(
            "Payment failed updated",
          );
        }
      }

      res
        .status(200)
        .send("OK");
    } catch (err) {
      console.log(
        "Webhook error:",
        err,
      );

      await createWebhookAudit(
        {
          verified:
            false,

          event:
            "webhook_exception",

          paymentId: "",

          orderId: "",

          status:
            "failed",

          payload: {},

          error:
            err.message ||
            "Unknown error",
        },
      );

      res
        .status(500)
        .send("Error");
    }
  },
);

// ================= START =================

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`,
  );
});