const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const MONGODB_URI = process.env.MONGODB_URI;

const DB_NAME = 'daalMail';
const USERS_COLLECTION = 'users';
const ORDERS_COLLECTION = 'orders';
const NETLIFY_MENU_LINK = 'https://sweet-sopapillas-fb37b3.netlify.app/';

let cachedDb = null;
const connectToDatabase = async () => {
  if (cachedDb) {
    console.log("connectToDatabase: Returning cached database connection");
    return cachedDb;
  }
  try {
    console.log("connectToDatabase: Connecting to MongoDB...");
    const client = await MongoClient.connect(MONGODB_URI);
    cachedDb = client.db(DB_NAME);
    console.log('connectToDatabase: Successfully connected to MongoDB');
    return cachedDb;
  } catch (error) {
    console.error('connectToDatabase: Error connecting to MongoDB:', error);
    throw error;
  }
};

async function sendMessage(to, message, type = 'text', buttons = []) {
  try {
    console.log(`sendMessage: called with to: ${to}, message: ${message}, type: ${type}, buttons: ${JSON.stringify(buttons)}`);
    const payload = {
      messaging_product: 'whatsapp',
      to,
    };

    if (type === 'text') {
      payload.text = { body: message };
    } else if (type === 'button') {
      payload.type = 'interactive';
      payload.interactive = {
        type: 'button',
        body: {
          text: message,
        },
        action: {
          // IMPORTANT: Limit buttons to a maximum of 3
          buttons: buttons.slice(0, 3).map((button) => ({
            type: 'reply',
            reply: {
              id: button.id,
              title: button.title,
            },
          })),
        },
      };
    }

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('sendMessage: successful');
    return response;
  } catch (err) {
    console.error('sendMessage: Error sending message:', err.response?.data || err.message);
    throw err;
  }
}

app.get('/webhook', (req, res) => {
  console.log("GET /webhook: Received webhook verification request");
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`GET /webhook: mode: ${mode}, token: ${token}, challenge: ${challenge}`);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('GET /webhook: Webhook verification successful');
    res.status(200).send(challenge);
  } else {
    console.log('GET /webhook: Webhook verification failed');
    res.sendStatus(403);
  }
});

const userState = {};

app.post('/webhook', async (req, res) => {
  console.log("POST /webhook: Received webhook event");
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || !Array.isArray(messages)) {
      console.log("POST /webhook: No messages to process.  Exiting.");
      return res.status(200).send();
    }

    for (const message of messages) {
      const location = message?.location;
      const buttonReply = value?.interactive?.button_reply?.id;
      const msgBody = message?.text?.body?.trim().toLowerCase() || '';
      const from = message?.from;

      if (!from) {
        const error = new Error("POST /webhook: ERROR - 'from' is undefined. Cannot process message.");
        console.error(error);
        continue;
      }

      console.log(`POST /webhook: from: ${from}, msgBody: ${msgBody}, buttonReply: ${buttonReply}, location: ${JSON.stringify(location)}`);
      const db = await connectToDatabase();
      const usersCollection = db.collection(USERS_COLLECTION);
      const ordersCollection = db.collection(ORDERS_COLLECTION);

      if (!userState[from]) {
        userState[from] = { stage: 'start' };
      }

      const state = userState[from];
      console.log(`POST /webhook: User state for ${from}:`, state);

      const userInput = buttonReply || msgBody;

      if (userInput === 'hello' || userInput === 'hi' || state.stage === 'start') {
        const existingUser = await usersCollection.findOne({ waNumber: from });
        if (!existingUser) {
          state.stage = 'collect_location';
          await sendMessage(from, "👋 Welcome to Daal Mail!\n\nPlease share your location to continue with your order.");
        } else {
          state.stage = 'menu';
          await sendMessage(from, '👋 Welcome back to Daal Mail!\n\nPlease choose an option:', 'button', [
            { id: 'place_order', title: 'Place an order' },
            { id: 'track_order', title: 'Track your order' },
          ]);
        }
      } else if (state.stage === 'start') {
        await sendMessage(from, "Please send 'hi' or 'hello' to start.");
      }

      if (state.stage === 'collect_location') {
        if (location) {
          state.userLocation = location;
          state.stage = 'collect_address';
          await sendMessage(from, "📍 Thank you for sharing your location. Now, please enter your address:");
          console.log(`POST /webhook:  location : ${JSON.stringify(location)}`);
        } else {
          await sendMessage(from, "❌ Location is required. Please share your location to proceed.");
        }
      }

      if (userInput === 'place_order' && state.stage === 'menu') {
        const existingUser = await usersCollection.findOne({ waNumber: from });

        if (!existingUser || !Array.isArray(existingUser.previousAddresses) || existingUser.previousAddresses.length === 0) {
          state.stage = 'collect_location';
          await sendMessage(from, '📍 No previous address found. Please share your location to continue with your order:');
        } else {
          const addresses = existingUser.previousAddresses;
          let msg = '📍 We found your previous addresses:\n\n';
          const buttons = addresses.slice(0, 3).map((item, index) => ({
            title: `${index + 1}. ${item.address}`,
            id: `address_${index}`,
          }));

          if (addresses.length > 3) {
            buttons.push({ title: 'More options...', id: 'more_addresses' });
          } else {
             buttons.push({ title: '➕ Add new address', id: 'new_address' });
          }
          state.stage = 'choose_address';
          state.addresses = addresses;
          await sendMessage(from, msg, 'button', buttons);
        }
      } else if (userInput === 'track_order' && state.stage === 'menu') {
        state.stage = 'track_order';
        const waNumberForQuery = from.startsWith('+') ? from : `+${from}`;
        console.log(`POST /webhook: Tracking orders for waNumber: ${waNumberForQuery}`);
        const userOrders = await ordersCollection.find({ waNumber: waNumberForQuery }).toArray();

        if (userOrders.length > 0) {
          let orderListMessage = "📦 Your Previous Orders:\n";
          const buttons = userOrders.slice(0, 3).map((order, index) => ({
            title: `Order ${index + 1}`,
            id: `order_${index}`,
          }));
          userOrders.forEach((order, index) => {
            orderListMessage += `${index + 1}. Order Number: ${order.orderNumber}, Status: ${order.status}, Order Time: ${order.orderTime}\n`;
          });
          orderListMessage += "\n Please enter the *number* of the order you want to track:";
          state.orders = userOrders;
          await sendMessage(from, orderListMessage, 'button', buttons);
        } else {
          await sendMessage(from, "❌ No previous orders found.");
          state.stage = 'done';
        }
      } else if (state.stage === 'menu') {
        await sendMessage(from, '👋 Welcome back to Daal Mail!\n\nPlease choose an option:', 'button', [
          { id: 'place_order', title: 'Place an order' },
          { id: 'track_order', title: 'Track your order' },
        ]);
      }

      if (state.stage === 'track_order' && state.orders) {
        const orderNumberChoice = parseInt(userInput);
        if (!isNaN(orderNumberChoice) && orderNumberChoice > 0 && orderNumberChoice <= state.orders.length) {
          const selectedOrder = state.orders[orderNumberChoice - 1];
          await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
          state.stage = 'done';
          delete userState[from];
          await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
        } else {
          await sendMessage(from, "❌ Invalid order number. Please enter a valid number from the list.");
        }
      } else if (state.stage === 'track_order') {
        await sendMessage(from, "❌ Invalid input. Please enter a valid order number from the list.");
      }

      if (state.stage === 'choose_address') {
        const choice = parseInt(userInput);

        if (!isNaN(choice) && choice >= 1 && choice <= state.addresses.length) {
          const selectedAddress = state.addresses[choice - 1].address;
          state.stage = 'payment_selection';
          state.selectedAddress = selectedAddress;
          console.log(`POST /webhook: Selected address: ${selectedAddress} for ${from}`);
          const orderSummary = `
Order Summary:
Selected Address: ${selectedAddress}
Please select payment method:
`;
          await sendMessage(from, orderSummary, 'button', [
            { id: 'cod', title: 'COD' },
            { id: 'upi', title: 'UPI' },
          ]);
        } else if (choice === state.addresses.length + 1) {
          state.stage = 'collect_location';
          await sendMessage(from, '📍 Please share your location:');
        } else {
          await sendMessage(from, '❌ Invalid option. Please reply with a valid number from the list above.');
        }
      } else if (state.stage === 'choose_address') {
        await sendMessage(from, "❌ Invalid input. Please enter a valid address number from the list.");
      }

      if (state.stage === 'collect_address') {
        const address = msgBody;
        if (state.userLocation) {
          const existingUser = await usersCollection.findOne({ waNumber: from });
          const newEntry = { address, location: state.userLocation, timestamp: new Date() };
          if (existingUser) {
            await usersCollection.updateOne({ waNumber: from }, { $push: { previousAddresses: newEntry } });
          } else {
            const newUser = {
              waNumber: from,
              previousAddresses: [newEntry],
            };
            await usersCollection.insertOne(newUser);
          }
          state.stage = 'done';
          console.log(`POST /webhook: New address saved: ${address} for ${from}`);
          await sendMessage(from, `✅ Address saved: ${address}`);
          await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
        } else {
          await sendMessage(from, "❌ Location is required. Please share your location and address again.");
          state.stage = 'collect_location';
        }
      }

      if (userInput === 'cod' && state.stage === 'payment_selection') {
        // COD
        try {
          const db = await connectToDatabase();
          const ordersCollection = db.collection(ORDERS_COLLECTION);
          const newOrder = {
            waNumber: from,
            orderItems: [
              { name: "Sample Item 1", quantity: 2 },
              { name: "Sample Item 2", quantity: 1 },
            ],
            total: 100,
            status: 'confirmed',
            paymentMethod: 'COD',
            orderTime: new Date(),
            orderNumber: `DM${Math.floor(Math.random() * 1000000)}`,
            deliveryAddress: state.selectedAddress,
          };
          await ordersCollection.insertOne(newOrder);
          await sendMessage(from, `✅ Your order is confirmed and will be delivered soon to ${state.selectedAddress}. Your Order Number is ${newOrder.orderNumber}. Payment Mode: COD`);
          state.stage = 'done';
          delete userState[from];
          await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
        } catch (error) {
          console.error("Error updating order status:", error);
          await sendMessage(from, "❌ An error occurred while confirming your order. Please try again.");
          state.stage = 'done';
          delete userState[from];
          await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
        }
      } else if (userInput === 'upi' && state.stage === 'payment_selection') {
        // UPI
        const qrCodeUrl = "https://via.placeholder.com/200x200?text=UPI+QR+Code";
        await sendMessage(from, "Please scan this QR code to pay:", 'image');
        await sendMessage(from, "Once payment is complete, send 'paid' to confirm.");
        state.stage = 'awaiting_payment';
      } else if (state.stage === 'payment_selection') {
        await sendMessage(from, "Invalid payment option. Please select payment method:", 'button', [
          { id: 'cod', title: 'COD' },
          { id: 'upi', title: 'UPI' },
        ]);
      }

      if (state.stage === 'awaiting_payment') {
        if (userInput === 'paid') {
          const isPaymentSuccessful = await verifyPayment(state.orderNumber);
          if (isPaymentSuccessful) {
            try {
              const db = await connectToDatabase();
              const ordersCollection = db.collection(ORDERS_COLLECTION);
              await ordersCollection.updateOne({ orderNumber: state.orderNumber }, { $set: { status: 'confirmed', paymentMethod: 'UPI' } });
              await sendMessage(from, `✅ Payment confirmed! Your order is confirmed and will be delivered soon. Your Order Number is ${state.orderNumber}. Payment Mode: UPI`);
              state.stage = 'done';
              delete userState[from];
              await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
            } catch (error) {
              console.error("Error updating order status:", error);
              await sendMessage(from, "❌ An error occurred while confirming your order. Please try again.");
              state.stage = 'done';
              delete userState[from];
              await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
            }
          } else {
            await sendMessage(from, "❌ Payment failed. Please try again.");
            state.stage = 'payment_selection';
            await sendMessage(from, "Please select payment method:", 'button', [
              { id: 'cod', title: 'COD' },
              { id: 'upi', title: 'UPI' },
            ]);
          }
        } else {
          await sendMessage(from, "Please send 'paid' after completing the payment.");
        }
      }

      if (state.stage === 'done') {
        console.log(`POST /webhook: stage is done.  ${from}`);
        delete userState[from];
        await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
      }

      // Default response for unexpected input
      console.log(`POST /webhook: Unexpected input: ${userInput} in stage ${state.stage} from ${from}`);
      await sendMessage(from, "❌ I'm not sure what you mean. Please send 'hi' or 'hello' to start.");
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("POST /webhook: Error processing webhook event:", error);
    return res.status(500).send("Internal Server Error");
  }
});

app.post('/create-order', async (req, res) => {
  console.log("POST /create-order: Entered /create-order route");
  try {
    const db = await connectToDatabase();
    const ordersCollection = db.collection('orders');
    const usersCollection = db.collection('users');

    const { orderItems, total, waNumber } = req.body;
    console.log("POST /create-order: Received data:", { orderItems, total, waNumber });

    if (!waNumber) {
      console.log("POST /create-order: WhatsApp number is missing");
      return res.status(400).json({ error: 'WhatsApp number is required. Please provide it in the request body.' });
    }

    const user = await usersCollection.findOne({ waNumber });
    console.log("POST /create-order: User found:", user);
    if (!user) {
      console.log("POST /create-order: WhatsApp number not found in database");
      return res.status(400).json({ error: 'WhatsApp number not found. Please go back to WhatsApp and try again.' });
    }

    const newOrder = {
      waNumber,
      orderItems,
      total,
      status: 'notified',
      orderTime: new Date(),
      orderNumber: `DM${Math.floor(Math.random() * 1000000)}`,
    };

    const result = await ordersCollection.insertOne(newOrder);
    console.log("POST /create-order: Order saved to database:", result);

    res.status(201).json({
      message: 'Order created successfully',
      order: newOrder,
    });

    const orderSummary = `
Order Summary:
Order Number: ${newOrder.orderNumber}
Total: ${total}
Items:
${orderItems.map(item => `- ${item.name} x ${item.quantity}`).join('\n')}
Status: ${newOrder.status}
    `;
    console.log("POST /create-order: Order summary: ", orderSummary);
    try {
      await sendMessage(waNumber, `Your order has been placed!\n${orderSummary}`);
      console.log("POST /create-order: sendMessage call successful");
    } catch (e) {
      console.error("POST /create-order: Error sending message from create-order", e);
    }
    console.log("POST /create-order: Exiting /create-order route");
  } catch (error) {
    console.error('POST /create-order: Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
