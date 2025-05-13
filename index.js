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
          buttons: buttons.map((button) => ({
            type: 'reply',
            reply: {
              id: button.id,
              title: button.title,
            },
          })),
        },
      };
    }

    await axios.post(
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
  } catch (err) {
    console.error('Error sending message:', err.response?.data || err.message);
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
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const location = message?.location;
  const buttonReply = message?.button?.payload; // Get button payload

  if (!message) {
    console.log("POST /webhook: No message found in payload. Full request body:", JSON.stringify(req.body, null, 2));
    return res.sendStatus(200);
  }

  const from = message.from;
  const msgBody = message.text?.body?.trim().toLowerCase() || '';
  console.log(`POST /webhook: from: ${from}, msgBody: ${msgBody}, buttonReply: ${buttonReply}, location: ${JSON.stringify(location)}`);
  const db = await connectToDatabase();
  const usersCollection = db.collection(USERS_COLLECTION);
  const ordersCollection = db.collection(ORDERS_COLLECTION);

  if (!userState[from]) {
    userState[from] = { stage: 'start' };
  }

  const state = userState[from];
  console.log(`POST /webhook: User state for ${from}:`, state);

  // Use buttonReply if available, otherwise use msgBody.  Important for button presses.
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
    return res.sendStatus(200);
  } else if (state.stage === 'start') {
    await sendMessage(from, "Please send 'hi' or 'hello' to start.");
    return res.sendStatus(200);
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
    return res.sendStatus(200);
  }

  if (userInput === 'place_order' && state.stage === 'menu') {
    const existingUser = await usersCollection.findOne({ waNumber: from });

    if (!existingUser || !Array.isArray(existingUser.previousAddresses) || existingUser.previousAddresses.length === 0) {
      state.stage = 'collect_location';
      await sendMessage(from, '📍 No previous address found. Please share your location to continue with your order:');
    } else {
      const addresses = existingUser.previousAddresses;
      let msg = '📍 We found your previous addresses:\n\n';
      addresses.forEach((item, index) => {
        msg += `${index + 1}. ${item.address}\n`;
      });
      msg += `${addresses.length + 1}. ➕ Add a new address\n\nPlease reply with the number of your choice.`;
      state.stage = 'choose_address';
      state.addresses = addresses;
      await sendMessage(from, msg);
    }
    return res.sendStatus(200);
  } else if (userInput === 'track_order' && state.stage === 'menu') {
    state.stage = 'track_order';
    const waNumberForQuery = from.startsWith('+') ? from : `+${from}`;
    console.log(`POST /webhook: Tracking orders for waNumber: ${waNumberForQuery}`);
    const userOrders = await ordersCollection.find({ waNumber: waNumberForQuery }).toArray();

    if (userOrders.length > 0) {
      let orderListMessage = "📦 Your Previous Orders:\n";
      userOrders.forEach((order, index) => {
        orderListMessage += `${index + 1}. Order Number: ${order.orderNumber}, Status: ${order.status}, Order Time: ${order.orderTime}\n`;
      });
      orderListMessage += "\n Please enter the *number* of the order you want to track:";
      state.orders = userOrders;
      await sendMessage(from, orderListMessage);
    } else {
      await sendMessage(from, "❌ No previous orders found.");
      state.stage = 'done';
      delete userState[from]; // Ensure state is reset
    }
    return res.sendStatus(200);
  } else if (state.stage === 'menu') {
    await sendMessage(from, '👋 Welcome back to Daal Mail!\n\nPlease choose an option:', 'button', [
      { id: 'place_order', title: 'Place an order' },
      { id: 'track_order', title: 'Track your order' },
    ]);
    return res.sendStatus(200);
  }

  if (state.stage === 'track_order' && state.orders) {
    const orderNumberChoice = parseInt(userInput);
    if (!isNaN(orderNumberChoice) && orderNumberChoice > 0 && orderNumberChoice <= state.orders.length) {
      const selectedOrder = state.orders[orderNumberChoice - 1];
      await sendMessage(from, `📦 Order Status: ${selectedOrder.status}\nOrder Number: ${selectedOrder.orderNumber}\nOrder Time: ${selectedOrder.orderTime}`);
      state.stage = 'done';
      delete userState[from]; // Ensure state is reset
      await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
      return res.sendStatus(200);
    } else {
      await sendMessage(from, "❌ Invalid order number. Please enter a valid number from the list.");
      return res.sendStatus(200);
    }
  } else if (state.stage === 'track_order') {
    await sendMessage(from, "❌ Invalid input. Please enter a valid order number from the list.");
    return res.sendStatus(200);
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
      await sendMessage(from, orderSummary, 'button', [      // Changed here
        { id: 'cod', title: 'COD' },
        { id: 'upi', title: 'UPI' },
      ]);
      return res.sendStatus(200);
    } else if (choice === state.addresses.length + 1) {
      state.stage = 'collect_location';
      await sendMessage(from, '📍 Please share your location:');
    } else {
      await sendMessage(from, '❌ Invalid option. Please reply with a valid number from the list above.');
    }
    return res.sendStatus(200);
  } else if (state.stage === 'choose_address') {
    await sendMessage(from, "❌ Invalid input. Please enter a valid address number from the list.");
    return res.sendStatus(200);
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
      state.stage = 'done'; //set stage
      console.log(`POST /webhook: New address saved: ${address} for ${from}`);
      await sendMessage(from, `✅ Address saved: ${address}`);
      await sendMessage(from, `${NETLIFY_MENU_LINK}?waNumber=${from}`);
      return res.sendStatus(200);
    } else {
      await sendMessage(from, "❌ Location is required. Please share your location and address again.");
      state.stage = 'collect_location';
      return res.sendStatus(200);
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
      delete userState[from]; // Ensure state is reset
      await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
      return res.sendStatus(200);
    } catch (error) {
      console.error("Error updating order status:", error);
      await sendMessage(from, "❌ An error occurred while confirming your order. Please try again.");
      state.stage = 'done';
      delete userState[from]; // Ensure state is reset
      await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
      return res.sendStatus(200);
    }
  } else if (userInput === 'upi' && state.stage === 'payment_selection') {
    // UPI
    const qrCodeUrl = "https://via.placeholder.com/200x200?text=UPI+QR+Code";
    await sendMessage(from, "Please scan this QR code to pay:", 'image');
    await sendMessage(from, "Once payment is complete, send 'paid' to confirm.");
    state.stage = 'awaiting_payment';
    return res.sendStatus(200);
  } else if (state.stage === 'payment_selection') {
    await sendMessage(from, "Invalid payment option. Please select payment method:", 'button', [      // Changed here
      { id: 'cod', title: 'COD' },
      { id: 'upi', title: 'UPI' },
    ]);
    return res.sendStatus(200);
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
          delete userState[from]; // Ensure state is reset
          await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
          return res.sendStatus(200);
        } catch (error) {
          console.error("Error updating order status:", error);
          await sendMessage(from, "❌ An error occurred while confirming your order. Please try again.");
          state.stage = 'done';
          delete userState[from]; // Ensure state is reset
          await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
          return res.sendStatus(200);
        }
      } else {
        await sendMessage(from, "❌ Payment failed. Please try again.");
        state.stage = 'payment_selection';
        await sendMessage(from, "Please select payment method:", 'button', [      // Changed here
          { id: 'cod', title: 'COD' },
          { id: 'upi', title: 'UPI' },
        ]);
        return res.sendStatus(200);
      }
    } else {
      await sendMessage(from, "Please send 'paid' after completing the payment.");
      return res.sendStatus(200);
    }
  }

  if (state.stage === 'done') {
    console.log(`POST /webhook: stage is done.  ${from}`);
    delete userState[from]; // Ensure state is reset
    await sendMessage(from, "Please send 'hi' or 'hello' to restart.");
    return res.sendStatus(200);
  }

  // Default response for unexpected input
  console.log(`POST /webhook: Unexpected input: ${userInput} in stage ${state.stage} from ${from}`);
  await sendMessage(from, "❌ I'm not sure what you mean. Please send 'hi' or 'hello' to start.");
  return res.sendStatus(200);
});

// New route to handle order creation from Netlify
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
      return res.status(400).json({ error: 'WhatsApp number not found.  Please go back to WhatsApp and try again.' });
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

    //  Send WhatsApp confirmation
    console.log("POST /create-order: Order data before sending message:", { newOrder, waNumber, orderItems, total });
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
